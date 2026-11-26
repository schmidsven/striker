// Package prs adds each repo's GitHub repository and open pull requests to Striker's status report: the slug
// from `git remote get-url origin` (here or on the repo's machine), the PRs from `gh pr list -R` run here.
package prs

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ploenk42/striker/striker/internal/gitrepo"
	"github.com/ploenk42/striker/striker/internal/issues"
	"github.com/ploenk42/striker/striker/internal/status"
)

// Parse reads `gh pr list --json number,title,url,isDraft,headRefName`, oldest PR first.
func Parse(b []byte) ([]status.PR, error) {
	var raw []struct {
		Number int    `json:"number"`
		Title  string `json:"title"`
		URL    string `json:"url"`
		Draft  bool   `json:"isDraft"`
		Branch string `json:"headRefName"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := make([]status.PR, 0, len(raw))
	for _, p := range raw {
		out = append(out, status.PR{Number: p.Number, Title: p.Title, URL: p.URL, Draft: p.Draft, Branch: p.Branch})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out, nil
}

// Cache remembers slugs for the life of the process and PR lists for Every; Git gives the git runner of a
// machine ("" = this computer). Bg runs the git and gh lookups: nil runs them inside Fill; striker serve passes
// a goroutine, so a slow or hanging gh never holds the status report (the answer lands on a later Fill).
// Gone, if set, gets each PR that left a slug's open list between two successful lookups, with the lead
// addresses of the repos on that slug; the first list after start and failed lookups report nothing.
type Cache struct {
	GH    issues.GH
	Git   func(machine string) gitrepo.Runner
	Every time.Duration
	Bg    func(func())
	Gone  func(slug string, pr status.PR, leads []string)

	mu     sync.Mutex
	slugs  map[string]string   // machine|path → slug ("" = not GitHub)
	lists  map[string]*list    // slug → last list
	flight map[string]bool     // lookups running: "slug|"+machine|path, "list|"+slug
	leads  map[string][]string // slug → lead addresses from the last Fill
}

type list struct {
	at  time.Time
	prs []status.PR
	ok  bool // prs came from a successful lookup
	err string
}

// Fill sets GitHub, PRs and PRsError on every repo of rep that has a path, from what the cache knows; missing
// slugs and stale lists are looked up (through Bg), at most one lookup per slug or list at a time.
func (c *Cache) Fill(rep *status.Report, now time.Time) {
	c.run(c.jobs(rep, now, true))
	c.run(c.jobs(rep, now, false))
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range rep.Repos {
		r := &rep.Repos[i]
		slug := c.slugs[key(r)]
		if r.Path == "" || slug == "" {
			continue
		}
		r.GitHub = slug
		if l := c.lists[slug]; l != nil {
			r.PRs, r.PRsError = l.prs, l.err
		}
	}
}

func key(r *status.Repo) string {
	if r.Machine != nil {
		return *r.Machine + "|" + r.Path
	}
	return "|" + r.Path
}

// jobs are the lookups rep needs now: slugs not known yet, or (slugs false) lists missing or older than Every.
func (c *Cache) jobs(rep *status.Report, now time.Time, slugs bool) []func() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.slugs == nil {
		c.slugs, c.lists, c.flight = map[string]string{}, map[string]*list{}, map[string]bool{}
	}
	if !slugs {
		c.leads = map[string][]string{}
		for i := range rep.Repos {
			r := &rep.Repos[i]
			if slug := c.slugs[key(r)]; r.Path != "" && slug != "" && r.Lead != nil && r.Lead.Address != "" {
				c.leads[slug] = append(c.leads[slug], r.Lead.Address)
			}
		}
	}
	var out []func()
	for i := range rep.Repos {
		r := &rep.Repos[i]
		if r.Path == "" {
			continue
		}
		k := key(r)
		slug, known := c.slugs[k]
		switch {
		case slugs && !known && !c.flight["slug|"+k]:
			c.flight["slug|"+k] = true
			machine, _, _ := strings.Cut(k, "|")
			out = append(out, func() { c.lookSlug(k, machine, r.Path) })
		case !slugs && slug != "" && !c.flight["list|"+slug]:
			if l := c.lists[slug]; l != nil && now.Sub(l.at) < c.Every {
				continue
			}
			c.flight["list|"+slug] = true
			out = append(out, func() { c.lookList(slug, now) })
		}
	}
	return out
}

func (c *Cache) run(jobs []func()) {
	for _, j := range jobs {
		if c.Bg != nil {
			c.Bg(j)
		} else {
			j()
		}
	}
}

func (c *Cache) lookSlug(k, machine, path string) {
	url, err := c.Git(machine).Git(path, "remote", "get-url", "origin")
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.flight, "slug|"+k)
	if err == nil { // a failed lookup is retried on the next Fill
		c.slugs[k] = issues.Slug(string(url))
	}
}

func (c *Cache) lookList(slug string, now time.Time) {
	out, err := c.GH.Run("", "pr", "list", "-R", slug, "--state", "open", "--json", "number,title,url,isDraft,headRefName", "--limit", "50")
	var prs []status.PR
	if err == nil {
		prs, err = Parse(out)
	}
	c.mu.Lock()
	delete(c.flight, "list|"+slug)
	l := c.lists[slug]
	if l == nil {
		l = &list{}
		c.lists[slug] = l
	}
	l.at = now
	if err != nil { // the last list stays
		l.err, _, _ = strings.Cut(strings.TrimSpace(err.Error()), "\n")
		c.mu.Unlock()
		return
	}
	var gone []status.PR
	if l.ok {
		gone = missing(l.prs, prs)
	}
	l.prs, l.ok, l.err = prs, true, ""
	leads := c.leads[slug]
	c.mu.Unlock()
	if c.Gone != nil {
		for _, p := range gone {
			c.Gone(slug, p, leads)
		}
	}
}

// missing are the PRs of old whose number is not in now.
func missing(old, now []status.PR) []status.PR {
	open := map[int]bool{}
	for _, p := range now {
		open[p.Number] = true
	}
	var out []status.PR
	for _, p := range old {
		if !open[p.Number] {
			out = append(out, p)
		}
	}
	return out
}

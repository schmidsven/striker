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
// machine ("" = this computer).
type Cache struct {
	GH    issues.GH
	Git   func(machine string) gitrepo.Runner
	Every time.Duration

	mu    sync.Mutex
	slugs map[string]string // machine|path → slug ("" = not GitHub)
	lists map[string]*list  // slug → last list
}

type list struct {
	at  time.Time
	prs []status.PR
	err string
}

// Fill sets GitHub, PRs and PRsError on every repo of rep that has a path.
func (c *Cache) Fill(rep *status.Report, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.slugs == nil {
		c.slugs, c.lists = map[string]string{}, map[string]*list{}
	}
	for i := range rep.Repos {
		r := &rep.Repos[i]
		if r.Path == "" {
			continue
		}
		machine := ""
		if r.Machine != nil {
			machine = *r.Machine
		}
		slug := c.slug(machine, r.Path)
		if slug == "" {
			continue
		}
		l := c.list(slug, now)
		r.GitHub, r.PRs, r.PRsError = slug, l.prs, l.err
	}
}

func (c *Cache) slug(machine, path string) string {
	key := machine + "|" + path
	if s, ok := c.slugs[key]; ok {
		return s
	}
	url, err := c.Git(machine).Git(path, "remote", "get-url", "origin")
	if err != nil {
		return "" // retried next time
	}
	s := issues.Slug(string(url))
	c.slugs[key] = s
	return s
}

func (c *Cache) list(slug string, now time.Time) *list {
	l := c.lists[slug]
	if l != nil && now.Sub(l.at) < c.Every {
		return l
	}
	if l == nil {
		l = &list{}
		c.lists[slug] = l
	}
	l.at = now
	out, err := c.GH.Run("", "pr", "list", "-R", slug, "--state", "open", "--json", "number,title,url,isDraft,headRefName", "--limit", "50")
	if err == nil {
		var prs []status.PR
		if prs, err = Parse(out); err == nil {
			l.prs, l.err = prs, ""
			return l
		}
	}
	l.err, _, _ = strings.Cut(strings.TrimSpace(err.Error()), "\n")
	return l
}

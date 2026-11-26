package prs

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ploenk42/striker/striker/internal/gitrepo"
	"github.com/ploenk42/striker/striker/internal/status"
)

type fakeGH struct {
	out   string
	err   error
	calls [][]string
}

func (g *fakeGH) Run(dir string, args ...string) ([]byte, error) {
	g.calls = append(g.calls, append([]string{dir}, args...))
	return []byte(g.out), g.err
}

type fakeGit struct {
	origin map[string]string // dir → origin URL; missing: git fails
	calls  int
}

func (g *fakeGit) Git(dir string, args ...string) ([]byte, error) {
	g.calls++
	if u, ok := g.origin[dir]; ok && reflect.DeepEqual(args, []string{"remote", "get-url", "origin"}) {
		return []byte(u + "\n"), nil
	}
	return nil, errors.New("fatal: not a git repository")
}
func (g *fakeGit) Read(string) ([]byte, error) { return nil, errors.New("unused") }

const twoPRs = `[{"number":31,"title":"b","url":"u31","isDraft":true,"headRefName":"x"},` +
	`{"number":29,"title":"a","url":"u29","isDraft":false,"headRefName":"feature/a"}]`

func cache(gh *fakeGH, git map[string]*fakeGit) *Cache {
	return &Cache{GH: gh, Git: func(m string) gitrepo.Runner { return git[m] }, Every: 60 * time.Second}
}

func report(repos ...status.Repo) *status.Report { return &status.Report{Repos: repos} }

func TestParse(t *testing.T) {
	got, err := Parse([]byte(twoPRs))
	want := []status.PR{{Number: 29, Title: "a", URL: "u29", Branch: "feature/a"}, {Number: 31, Title: "b", URL: "u31", Draft: true, Branch: "x"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse = %+v, %v; want %+v", got, err, want)
	}
}

func TestFillSlugAndPRs(t *testing.T) {
	gh := &fakeGH{out: twoPRs}
	c := cache(gh, map[string]*fakeGit{"": {origin: map[string]string{"/p/r": "git@github.com:o/r.git"}}})
	rep := report(status.Repo{Name: "r", Path: "/p/r"})
	c.Fill(rep, time.Unix(1000, 0))
	r := rep.Repos[0]
	if r.GitHub != "o/r" || len(r.PRs) != 2 || r.PRsError != "" {
		t.Fatalf("repo = %+v", r)
	}
	want := []string{"", "pr", "list", "-R", "o/r", "--state", "open", "--json", "number,title,url,isDraft,headRefName", "--limit", "50"}
	if len(gh.calls) != 1 || !reflect.DeepEqual(gh.calls[0], want) {
		t.Fatalf("gh calls = %q, want %q", gh.calls, want)
	}
}

func TestFillNoGitHub(t *testing.T) {
	gh := &fakeGH{out: twoPRs}
	c := cache(gh, map[string]*fakeGit{"": {origin: map[string]string{"/p/lab": "https://gitlab.com/o/r"}}})
	rep := report(status.Repo{Name: "lab", Path: "/p/lab"}, status.Repo{Name: "none", Path: "/p/none"}, status.Repo{Name: "nopath"})
	c.Fill(rep, time.Unix(1000, 0))
	for _, r := range rep.Repos {
		if r.GitHub != "" || r.PRs != nil || r.PRsError != "" {
			t.Errorf("repo %s = %+v, want nothing", r.Name, r)
		}
	}
	if len(gh.calls) != 0 {
		t.Errorf("gh called: %q", gh.calls)
	}
}

func TestFillCaches(t *testing.T) {
	gh := &fakeGH{out: twoPRs}
	git := &fakeGit{origin: map[string]string{"/p/r": "https://github.com/o/r"}}
	c := cache(gh, map[string]*fakeGit{"": git})
	t0 := time.Unix(1000, 0)
	for _, at := range []time.Duration{0, 30 * time.Second} {
		c.Fill(report(status.Repo{Name: "r", Path: "/p/r"}), t0.Add(at))
	}
	if len(gh.calls) != 1 {
		t.Fatalf("gh calls within 60 s = %d, want 1", len(gh.calls))
	}
	rep := report(status.Repo{Name: "r", Path: "/p/r"})
	c.Fill(rep, t0.Add(61*time.Second))
	if len(gh.calls) != 2 || len(rep.Repos[0].PRs) != 2 {
		t.Fatalf("gh calls after 61 s = %d, prs %+v", len(gh.calls), rep.Repos[0].PRs)
	}
	if git.calls != 1 {
		t.Errorf("slug lookups = %d, want 1", git.calls)
	}
}

func TestFillRetriesFailedSlug(t *testing.T) {
	git := &fakeGit{origin: map[string]string{}}
	c := cache(&fakeGH{out: twoPRs}, map[string]*fakeGit{"": git})
	c.Fill(report(status.Repo{Name: "r", Path: "/p/r"}), time.Unix(1000, 0))
	git.origin["/p/r"] = "https://github.com/o/r"
	rep := report(status.Repo{Name: "r", Path: "/p/r"})
	c.Fill(rep, time.Unix(1020, 0))
	if rep.Repos[0].GitHub != "o/r" {
		t.Errorf("slug not retried: %+v", rep.Repos[0])
	}
}

func TestFillGhFails(t *testing.T) {
	gh := &fakeGH{out: twoPRs}
	c := cache(gh, map[string]*fakeGit{"": {origin: map[string]string{"/p/r": "https://github.com/o/r"}}})
	c.Fill(report(status.Repo{Name: "r", Path: "/p/r"}), time.Unix(1000, 0))
	gh.out, gh.err = "", errors.New("gh: not logged in\nmore")
	rep := report(status.Repo{Name: "r", Path: "/p/r"})
	c.Fill(rep, time.Unix(1061, 0))
	r := rep.Repos[0]
	if len(r.PRs) != 2 || r.PRsError != "gh: not logged in" {
		t.Fatalf("repo = %+v", r)
	}
}

func TestFillRemote(t *testing.T) {
	remote := &fakeGit{origin: map[string]string{"/srv/a": "git@github.com:o/a.git"}}
	c := cache(&fakeGH{out: "[]"}, map[string]*fakeGit{"": {}, "remote1": remote})
	m := "remote1"
	rep := report(status.Repo{Name: "a", Path: "/srv/a", Machine: &m})
	c.Fill(rep, time.Unix(1000, 0))
	if rep.Repos[0].GitHub != "o/a" || remote.calls != 1 {
		t.Fatalf("repo = %+v, remote git calls %d", rep.Repos[0], remote.calls)
	}
}

func TestReportJSON(t *testing.T) {
	b, _ := json.Marshal(status.Report{Repos: []status.Repo{
		{Name: "r", GitHub: "o/r", PRs: []status.PR{{Number: 29, Title: "a", URL: "u29", Branch: "feature/a"}}},
		{Name: "plain"},
	}})
	s := string(b)
	if !strings.Contains(s, `"github":"o/r"`) ||
		!strings.Contains(s, `"prs":[{"number":29,"title":"a","url":"u29","draft":false,"branch":"feature/a"}]`) {
		t.Errorf("JSON lacks github/prs: %s", s)
	}
	if strings.Count(s, `"github"`) != 1 || strings.Count(s, `"prs"`) != 1 || strings.Contains(s, "prs_error") {
		t.Errorf("empty fields not omitted: %s", s)
	}
}

// blockingGH hangs until release is closed, like gh without network.
type blockingGH struct{ release chan struct{} }

func (g blockingGH) Run(string, ...string) ([]byte, error) {
	<-g.release
	return []byte(twoPRs), nil
}

// With Bg set (striker serve: a goroutine), Fill never waits on gh or git: a hanging gh must not hold the whole
// status report. The list arrives on a later Fill, and only one refresh per slug runs at a time.
func TestFillDoesNotWaitOnGh(t *testing.T) {
	gh := blockingGH{release: make(chan struct{})}
	var started sync.WaitGroup
	c := &Cache{GH: gh, Git: func(string) gitrepo.Runner { return &fakeGit{origin: map[string]string{"/p/r": "https://github.com/o/r"}} },
		Every: 60 * time.Second, Bg: func(f func()) { started.Add(1); go func() { defer started.Done(); f() }() }}
	done := make(chan *status.Report)
	go func() {
		rep := report(status.Repo{Name: "r", Path: "/p/r"})
		c.Fill(rep, time.Unix(1000, 0))
		c.Fill(rep, time.Unix(1001, 0))
		done <- rep
	}()
	var rep *status.Report
	select {
	case rep = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Fill blocked on a hanging gh")
	}
	if rep.Repos[0].PRs != nil {
		t.Errorf("PRs before gh answered: %+v", rep.Repos[0].PRs)
	}
	close(gh.release)
	started.Wait()
	rep = report(status.Repo{Name: "r", Path: "/p/r"})
	c.Fill(rep, time.Unix(1002, 0))
	started.Wait()
	if len(rep.Repos[0].PRs) != 2 {
		// the list may land just after this Fill read the cache: one more Fill must have it
		c.Fill(rep, time.Unix(1003, 0))
	}
	if len(rep.Repos[0].PRs) != 2 {
		t.Errorf("PRs after gh answered: %+v", rep.Repos[0])
	}
}

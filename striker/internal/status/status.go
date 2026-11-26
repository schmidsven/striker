// Package status builds the fleet status report.
package status

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ploenk42/striker/striker/internal/fleet"
	"github.com/ploenk42/striker/striker/internal/hc"
)

type Report struct {
	Updated string `json:"updated"`
	Repos   []Repo `json:"repos"`
}

type Repo struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Machine      *string         `json:"machine"`
	Path         string          `json:"path"`
	Space        string          `json:"space"`
	SpacePath    string          `json:"space_path"`
	Lead         *Lead           `json:"lead"`
	Status       json.RawMessage `json:"status"`
	Coordinators []Coord         `json:"coordinators"`
	// GitHub is the repo's GitHub "owner/repo" from origin, PRs its open pull requests (both filled by package
	// prs in striker serve); PRsError is gh's first error line while the last list is kept.
	GitHub   string `json:"github,omitempty"`
	PRs      []PR   `json:"prs,omitempty"`
	PRsError string `json:"prs_error,omitempty"`
}

// PR is one open pull request of a repo.
type PR struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Draft  bool   `json:"draft"`
	Branch string `json:"branch"`
}

// Coord is a coordinator terminal (labels striker.coordinator=<change>,
// striker.repo=<repo>) with its status file <status_dir>/<repo>--<change>.json.
type Coord struct {
	Change  string          `json:"change"`
	Address string          `json:"address"`
	State   string          `json:"state"`
	Status  json.RawMessage `json:"status"`
}

type Lead struct {
	Address  string  `json:"address"`
	State    *string `json:"state"`
	Msg      *string `json:"msg"`
	StatusMs *int64  `json:"status_ms"`
	Where    string  `json:"where"`
}

const invalidJSON = "Statusdatei ist kein gültiges JSON"

func errStatus(msg string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return b
}

// parseStatus validates a status file body (BOM tolerated).
func parseStatus(b []byte) json.RawMessage {
	b = bytes.TrimSpace(bytes.TrimPrefix(b, []byte("\xEF\xBB\xBF")))
	if !json.Valid(b) {
		return errStatus(invalidJSON)
	}
	return json.RawMessage(b)
}

func leadFrom(addr, where string, info hc.Info) *Lead {
	l := &Lead{Address: addr, StatusMs: info.StatusMs, Where: where}
	if info.Status != nil {
		state, msg := info.Status.State, info.Status.Msg
		l.State, l.Msg = &state, &msg
	}
	return l
}

// Build never fails: per-repo problems are reported inside the repo.
func Build(c hc.Client, f fleet.Fleet, home string, now time.Time) Report {
	rep := Report{Updated: now.UTC().Format("2006-01-02T15:04:05Z"), Repos: []Repo{}}
	seen := map[string]bool{}

	for _, fr := range f.Repos {
		seen[fr.Name] = true
		rep.Repos = append(rep.Repos, fleetRepo(c, f, home, fr))
	}

	ts, err := c.List()
	if err != nil {
		return nonNilCoords(rep)
	}
	type found struct {
		repo string
		c    Coord
	}
	var coords []found
	for _, t := range ts {
		info, err := c.Get(t.Address)
		if err != nil {
			continue
		}
		if ch := info.Labels["striker.coordinator"]; ch != "" {
			repo := info.Labels["striker.repo"]
			if safeName(ch) && safeName(repo) {
				k := Coord{Change: ch, Address: t.Address}
				if info.Status != nil {
					k.State = info.Status.State
				}
				k.Status = ReadCoord(home, c, f, machineOf(t.Address), repo, ch)
				coords = append(coords, found{repo, k})
			}
		}
		if !hc.IsLocal(t.Address) {
			continue
		}
		name := info.Labels["striker.lead"]
		if name == "" || seen[name] || !safeName(name) {
			continue
		}
		seen[name] = true
		space, _, _ := strings.Cut(t.Where, " / ")
		rep.Repos = append(rep.Repos, Repo{
			Name: name, Path: info.Cwd, SpacePath: info.Cwd, Space: space, Lead: leadFrom(t.Address, t.Where, info),
			Status: localStatus(home, name),
		})
	}
	sort.Slice(coords, func(i, j int) bool {
		a, b := coords[i].c, coords[j].c
		if a.Change != b.Change {
			return a.Change < b.Change
		}
		return a.Address < b.Address
	})
	// A coordinator whose repo has no entry (not in the fleet, no local lead)
	// gets one with lead null, so it never vanishes from the report.
	for _, k := range coords {
		i := 0
		for i < len(rep.Repos) && rep.Repos[i].Name != k.repo {
			i++
		}
		if i == len(rep.Repos) {
			r := Repo{Name: k.repo}
			if m := machineOf(k.c.Address); m != "" {
				r.Machine = &m
			}
			rep.Repos = append(rep.Repos, r)
		}
		rep.Repos[i].Coordinators = append(rep.Repos[i].Coordinators, k.c)
	}
	return nonNilCoords(rep)
}

// fleetRepo is the fleet entry fr with its lead (label striker.lead=<name>)
// and the lead's status file.
func fleetRepo(c hc.Client, f fleet.Fleet, home string, fr fleet.Repo) Repo {
	r := Repo{Name: fr.Name, Title: fr.Title, Path: fr.Path, SpacePath: fr.Path, Space: fr.Space}
	if fr.Machine != "" {
		m := fr.Machine
		r.Machine = &m
	}
	if ts, err := c.ListLabel("striker.lead", fr.Name); err == nil && len(ts) > 0 {
		if info, err := c.Get(ts[0].Address); err == nil {
			r.Lead = leadFrom(ts[0].Address, ts[0].Where, info)
		} else {
			r.Status = errStatus(err.Error())
		}
	} else if err != nil {
		r.Status = errStatus(err.Error())
	}
	if r.Status == nil {
		if r.Machine != nil {
			b, err := c.ReadFile(*r.Machine, f.StatusDir[*r.Machine]+"/"+fr.Name+".json")
			if err != nil {
				r.Status = errStatus(err.Error())
			} else {
				r.Status = parseStatus(b)
			}
		} else {
			r.Status = localStatus(home, fr.Name)
		}
	}
	return r
}

func normPath(p string) string {
	p = strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	return p
}

// LeadAt finds the repo at path on machine ("" = this computer) the way
// Build does: its fleet entry with the lead labelled striker.lead=<name>,
// else a local terminal labelled striker.lead whose cwd is path. Without
// either, the repo is named after its folder and has no lead. Coordinators
// are not read (see For). It never fails.
func LeadAt(c hc.Client, f fleet.Fleet, home, machine, path string) Repo {
	return leadAt(c, &terms{c: c}, f, home, machine, path)
}

// terms reads hc's terminal list and each terminal's info at most once, so
// For's lead lookup and coordinator scan share one pass.
type terms struct {
	c      hc.Client
	listed bool
	list   []hc.Terminal
	err    error
	infos  map[string]hc.Info
	errs   map[string]error
}

func (s *terms) List() ([]hc.Terminal, error) {
	if !s.listed {
		s.listed = true
		s.list, s.err = s.c.List()
	}
	return s.list, s.err
}

func (s *terms) Get(addr string) (hc.Info, error) {
	if s.infos == nil {
		s.infos, s.errs = map[string]hc.Info{}, map[string]error{}
	}
	if info, ok := s.infos[addr]; ok {
		return info, s.errs[addr]
	}
	info, err := s.c.Get(addr)
	s.infos[addr], s.errs[addr] = info, err
	return info, err
}

func leadAt(c hc.Client, tm *terms, f fleet.Fleet, home, machine, path string) Repo {
	if machine == "local" {
		machine = ""
	}
	if name := f.RepoAt(machine, path); name != "" {
		for _, fr := range f.Repos {
			if fr.Name == name {
				return withCoords(fleetRepo(c, f, home, fr))
			}
		}
	}
	r := Repo{Name: filepath.Base(normPath(path)), Path: path, SpacePath: path}
	if machine != "" {
		m := machine
		r.Machine = &m
		return withCoords(r)
	}
	ts, err := tm.List()
	if err != nil {
		return withCoords(r)
	}
	for _, t := range ts {
		if !hc.IsLocal(t.Address) {
			continue
		}
		info, err := tm.Get(t.Address)
		if err != nil {
			continue
		}
		name := info.Labels["striker.lead"]
		if !safeName(name) || normPath(info.Cwd) != normPath(path) {
			continue
		}
		space, _, _ := strings.Cut(t.Where, " / ")
		r.Name, r.Space = name, space
		r.Lead = leadFrom(t.Address, t.Where, info)
		r.Status = localStatus(home, name)
		break
	}
	return withCoords(r)
}

func withCoords(r Repo) Repo {
	if r.Coordinators == nil {
		r.Coordinators = []Coord{}
	}
	return r
}

// For is LeadAt plus the repo's coordinators: terminals on its machine
// labelled striker.coordinator=<change> and striker.repo=<name>, with their
// status files, sorted by change and address.
func For(c hc.Client, f fleet.Fleet, home, machine, path string) Repo {
	tm := &terms{c: c}
	r := leadAt(c, tm, f, home, machine, path)
	m := ""
	if r.Machine != nil {
		m = *r.Machine
	}
	ts, err := tm.List()
	if err != nil {
		return r
	}
	for _, t := range ts {
		if machineOf(t.Address) != m {
			continue
		}
		info, err := tm.Get(t.Address)
		if err != nil {
			continue
		}
		ch := info.Labels["striker.coordinator"]
		if ch == "" || info.Labels["striker.repo"] != r.Name || !safeName(ch) {
			continue
		}
		k := Coord{Change: ch, Address: t.Address}
		if info.Status != nil {
			k.State = info.Status.State
		}
		k.Status = ReadCoord(home, c, f, m, r.Name, ch)
		r.Coordinators = append(r.Coordinators, k)
	}
	sort.Slice(r.Coordinators, func(i, j int) bool {
		a, b := r.Coordinators[i], r.Coordinators[j]
		if a.Change != b.Change {
			return a.Change < b.Change
		}
		return a.Address < b.Address
	})
	return r
}

// LeadTask returns the task of r's lead status file and the lead's live
// state ("" when unknown).
func LeadTask(r Repo) (task, state string) {
	var v struct {
		Task any `json:"task"`
	}
	if json.Unmarshal(r.Status, &v) == nil {
		if s, ok := v.Task.(string); ok {
			task = s
		}
	}
	if r.Lead != nil && r.Lead.State != nil {
		state = *r.Lead.State
	}
	return task, state
}

func nonNilCoords(rep Report) Report {
	for i := range rep.Repos {
		if rep.Repos[i].Coordinators == nil {
			rep.Repos[i].Coordinators = []Coord{}
		}
	}
	return rep
}

// machineOf is the machine prefix of a terminal address ("" = local).
func machineOf(addr string) string {
	if m, _, remote := strings.Cut(addr, "/"); remote {
		return m
	}
	return ""
}

// safeName accepts a label value usable as a file name part.
func safeName(s string) bool {
	return s != "" && filepath.Base(s) == s && !strings.Contains(s, "..") && !strings.ContainsAny(s, `/\`)
}

func localStatus(home, name string) json.RawMessage {
	b, err := os.ReadFile(filepath.Join(home, ".striker", "status", name+".json"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return errStatus(err.Error())
	}
	return parseStatus(b)
}

// ReadCoord reads the status file <status_dir>/<repo>--<change>.json of a
// coordinator: on this machine (machine "") under <home>/.striker/status, else
// through hc from the machine's status_dir in the fleet. A missing,
// unreadable or invalid file gives {"error": …}, never nil.
func ReadCoord(home string, h hc.Client, f fleet.Fleet, machine, repo, change string) json.RawMessage {
	if !safeName(repo) || !safeName(change) {
		return errStatus("ungültiger Repo- oder Change-Name")
	}
	name := repo + "--" + change + ".json"
	if machine == "" {
		b, err := os.ReadFile(filepath.Join(home, ".striker", "status", name))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return errStatus("keine Statusdatei " + name)
			}
			return errStatus(err.Error())
		}
		return parseStatus(b)
	}
	dir, ok := f.StatusDir[machine]
	if !ok {
		return errStatus("kein status_dir für " + machine + " in fleet.json")
	}
	b, err := h.ReadFile(machine, dir+"/"+name)
	if err != nil {
		return errStatus(err.Error())
	}
	return parseStatus(b)
}

// CoordNeeds counts the entries of a coordinator status' needs_you and
// returns the task ids its entries name with an optional "task" key.
func CoordNeeds(status json.RawMessage) (n int, tasks []string) {
	var v struct {
		NeedsYou []struct {
			Task any `json:"task"`
		} `json:"needs_you"`
	}
	if json.Unmarshal(status, &v) != nil {
		return 0, nil
	}
	for _, e := range v.NeedsYou {
		var id string
		switch t := e.Task.(type) {
		case string:
			id = strings.TrimSpace(t)
		case float64:
			id = strconv.FormatFloat(t, 'f', -1, 64)
		}
		if id != "" {
			tasks = append(tasks, id)
		}
	}
	return len(v.NeedsYou), tasks
}

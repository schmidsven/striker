// Command striker: status, send and start-lead for the herdr fleet.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ploenk42/striker/striker/internal/bridge"
	"github.com/ploenk42/striker/striker/internal/coord"
	"github.com/ploenk42/striker/striker/internal/crew"
	"github.com/ploenk42/striker/striker/internal/dispatch"
	"github.com/ploenk42/striker/striker/internal/fleet"
	"github.com/ploenk42/striker/striker/internal/gitrepo"
	"github.com/ploenk42/striker/striker/internal/hc"
	"github.com/ploenk42/striker/striker/internal/home"
	"github.com/ploenk42/striker/striker/internal/issues"
	"github.com/ploenk42/striker/striker/internal/lead"
	"github.com/ploenk42/striker/striker/internal/openspec"
	"github.com/ploenk42/striker/striker/internal/plans"
	"github.com/ploenk42/striker/striker/internal/prs"
	"github.com/ploenk42/striker/striker/internal/relay"
	"github.com/ploenk42/striker/striker/internal/repoview"
	"github.com/ploenk42/striker/striker/internal/serve"
	"github.com/ploenk42/striker/striker/internal/status"
	"github.com/ploenk42/striker/striker/internal/statusline"
)

const usage = `usage:
  striker status
  striker send <addr> <text>
  striker send <addr> --file <file>
  striker start-lead <repo>
  striker start-coordinator <repo> <change>
  striker serve [--addr 127.0.0.1:7522]
  striker issues <change>
  striker issues <plan file>
  striker dispatch <role> <task id | #issue> --plan <change> [--dry-run]
  striker dispatch <role> <issue> --plan <plan file> [--dry-run]
  striker coordinator <plan file> [--terminal <addr>]
  striker statusline   (Claude Code status line: JSON on stdin)
  striker install-statusline
`

func main() { os.Exit(run(os.Args[1:])) }

func fail(err error) int {
	fmt.Fprintln(os.Stderr, "striker:", err)
	return 1
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	c := hc.Client{R: hc.Exec{}}
	fleetPath := filepath.Join(home.Dir(), "fleet.json")
	switch args[0] {
	case "status":
		f, err := fleet.Load(fleetPath)
		if err != nil {
			return fail(err)
		}
		uh, _ := os.UserHomeDir()
		b, _ := json.MarshalIndent(status.Build(c, f, uh, time.Now()), "", "  ")
		fmt.Println(string(b))
		return 0
	case "send":
		var text string
		switch {
		case len(args) == 4 && args[2] == "--file":
			b, err := os.ReadFile(args[3])
			if err != nil {
				return fail(err)
			}
			text = string(b)
		case len(args) == 3:
			text = args[2]
		default:
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		if err := c.Send(args[1], lead.Message(text)); err != nil {
			return fail(err)
		}
		fmt.Printf("Zugestellt an %s.\n", args[1])
		return 0
	case "start-lead":
		if len(args) != 2 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		f, err := fleet.Load(fleetPath)
		if err != nil {
			return fail(err)
		}
		herdr := hc.Exec{Bin: "herdr-app"}.Run
		addr, err := lead.Start(c, herdr, f, args[1], filepath.Join(home.Dir(), "briefs", "lead.md"))
		var nr *lead.NotReadyError
		if errors.As(err, &nr) {
			fmt.Println(nr.Error())
			return 2
		}
		if err != nil {
			return fail(err)
		}
		fmt.Printf("Einweisung an %s geschickt.\n", addr)
		return 0
	case "start-coordinator":
		return runStartCoordinator(c, fleetPath, args[1:])
	case "serve":
		return runServe(c, fleetPath, args[1:])
	case "issues":
		if len(args) != 2 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return runIssues(args[1])
	case "dispatch":
		return runDispatch(c, fleetPath, args[1:])
	case "coordinator":
		return runCoordinator(c, fleetPath, args[1:])
	case "statusline":
		// Claude Code's status line command: store model and tokens for this terminal, print the short line
		in, _ := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
		uh, _ := os.UserHomeDir()
		fmt.Println(statusline.Write(in, os.Getenv("HC_TERMINAL_ID"), filepath.Join(uh, ".striker", "agents"), time.Now()))
		return 0
	case "install-statusline":
		// the installers: `striker statusline` as the person's Claude status line, unless one is set already
		exe, err := os.Executable()
		if err != nil {
			return fail(err)
		}
		uh, _ := os.UserHomeDir()
		path := filepath.Join(uh, ".claude", "settings.json")
		changed, err := statusline.Install(path, filepath.ToSlash(exe)+" statusline")
		if err != nil {
			return fail(err)
		}
		if changed {
			fmt.Printf("set the Claude status line in %s to striker statusline\n", path)
		} else {
			fmt.Printf("%s already has a status line: left as it is\n", path)
		}
		return 0
	}
	fmt.Fprint(os.Stderr, usage)
	return 2
}

const startCoordinatorUsage = `usage: striker start-coordinator <repo> <change>

Starts the coordinator of the OpenSpec change <change> of <repo> (fleet.json or
a local lead): creates the worktree from x-branch if missing, opens the space
<repo>-<change> with tab "coord <change>" running Claude, labels it
striker.coordinator=<change> and striker.repo=<repo>, and sends briefs/coordinator.md.
Its status file is <status_dir>/<repo>--<change>.json.
`

func runStartCoordinator(c hc.Client, fleetPath string, args []string) int {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
		fmt.Print(startCoordinatorUsage)
		return 0
	}
	if len(args) != 2 || strings.HasPrefix(args[0], "-") || strings.HasPrefix(args[1], "-") {
		fmt.Fprint(os.Stderr, startCoordinatorUsage)
		return 2
	}
	f, err := fleet.Load(fleetPath)
	if err != nil {
		return fail(err)
	}
	herdr := hc.Exec{Bin: "herdr-app"}.Run
	addr, err := coord.Start(c, herdr, f, args[0], args[1], filepath.Join(home.Dir(), "briefs", "coordinator.md"))
	var nr *coord.NotReadyError
	if errors.As(err, &nr) {
		fmt.Println(nr.Error())
		return 2
	}
	if err != nil {
		return fail(err)
	}
	fmt.Printf("Einweisung an %s geschickt.\n", addr)
	return 0
}

// ghExec runs gh in the process working directory (runIssues changes into the
// repo root first), so the dir argument is not needed.
type ghExec struct{ x hc.Exec }

func (g ghExec) Run(_ string, args ...string) ([]byte, error) { return g.x.Run(args...) }

// outside reports whether a path relative to the repo top leaves it: ".." or
// a "../" prefix (a file named "..foo.md" stays inside).
func outside(rel string) bool {
	return rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.HasPrefix(rel, "../")
}

// isChange reports whether arg names an OpenSpec change of the worktree top:
// a bare name (no separator, no .md) with openspec/changes/<arg>/tasks.md.
// Anything else is a legacy plan file argument.
func isChange(top, arg string) bool {
	if arg == "" || arg == "." || arg == ".." || strings.ContainsAny(arg, `/\`) || strings.HasSuffix(arg, ".md") {
		return false
	}
	st, err := os.Stat(filepath.Join(top, "openspec", "changes", arg, "tasks.md"))
	return err == nil && st.Mode().IsRegular()
}

// activeChange reads the change from the working tree of top.
func activeChange(top, name string) (openspec.Change, error) {
	st, _, err := openspec.Read(gitrepo.Repo{R: gitrepo.Local{}, Dir: top}, "")
	if err != nil {
		return openspec.Change{}, err
	}
	for _, c := range st.Changes {
		if c.Name == name && c.Archived == "" {
			return c, nil
		}
	}
	return openspec.Change{}, fmt.Errorf("no active change %q in %s", name, top)
}

func worktreeTop() (cwd, top string, err error) {
	cwd, err = os.Getwd()
	if err != nil {
		return "", "", err
	}
	out, err := gitrepo.Local{}.Git(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", err
	}
	return cwd, strings.TrimSpace(string(out)), nil
}

// runIssuesChange creates the issues of an OpenSpec change and writes their
// numbers into its tasks.md.
func runIssuesChange(top, change string) int {
	if err := os.Chdir(top); err != nil { // gh finds the repo from the working directory
		return fail(err)
	}
	repo := gitrepo.Repo{R: gitrepo.Local{}, Dir: top}
	write := func(rel string, text []byte) error {
		return os.WriteFile(filepath.Join(top, filepath.FromSlash(rel)), text, 0o644)
	}
	created, cerr := issues.CreateChange(ghExec{hc.Exec{Bin: "gh"}}, repo, change, write)
	if c, err := activeChange(top, change); err == nil {
		for _, t := range c.Tasks {
			if n, ok := created[t.ID]; ok {
				fmt.Printf("#%d %s %s\n", n, t.ID, t.Title)
			}
		}
	}
	if cerr != nil {
		return fail(cerr)
	}
	return 0
}

func runIssues(plan string) int {
	cwd, top, err := worktreeTop()
	if err != nil {
		return fail(err)
	}
	if isChange(top, plan) {
		return runIssuesChange(top, plan)
	}
	abs := plan
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(cwd, plan)
	}
	rel, err := filepath.Rel(top, abs)
	if err != nil || outside(rel) {
		return fail(fmt.Errorf("%s is outside the repo %s", plan, top))
	}
	rel = filepath.ToSlash(rel)
	if err := os.Chdir(top); err != nil {
		return fail(err)
	}
	repo := gitrepo.Repo{R: gitrepo.Local{}, Dir: top}
	write := func(rel string, text []byte) error {
		return os.WriteFile(filepath.Join(top, filepath.FromSlash(rel)), text, 0o644)
	}
	created, cerr := issues.Create(ghExec{hc.Exec{Bin: "gh"}}, repo, rel, write)
	if text, err := repo.ReadWorking(rel); err == nil {
		for _, t := range plans.ParsePlan(rel, text).Tasks {
			for _, n := range created {
				if t.Issue == n {
					fmt.Printf("#%d %s\n", t.Issue, t.Title)
				}
			}
		}
	}
	if cerr != nil {
		return fail(cerr)
	}
	return 0
}

// runDispatch starts a task agent for one plan task as a labelled terminal in
// the current worktree and prints its address (--dry-run: prints the hc argv).
func runDispatch(c hc.Client, fleetPath string, args []string) int {
	if len(args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	role := args[0]
	if !dispatch.ValidRole(role) {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	fs := flag.NewFlagSet("dispatch", flag.ContinueOnError)
	plan := fs.String("plan", "", "OpenSpec change or plan file")
	dry := fs.Bool("dry-run", false, "print the hc argv instead of running it")
	if err := fs.Parse(args[2:]); err != nil || fs.NArg() != 0 || *plan == "" {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	cwd, top, err := worktreeTop()
	if err != nil {
		return fail(err)
	}
	if isChange(top, *plan) {
		ch, err := activeChange(top, *plan)
		if err != nil {
			return fail(err)
		}
		task, err := dispatch.ResolveChange(ch, args[1])
		if err != nil {
			return fail(err)
		}
		return startAgent(c, dispatch.CommandChange(role, repoNameAt(fleetPath, top), ch, task, top), *dry)
	}
	issue, err := strconv.Atoi(args[1])
	if err != nil || issue <= 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	abs := *plan
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(cwd, abs)
	}
	text, err := os.ReadFile(abs)
	if err != nil {
		return fail(err)
	}
	rel := abs
	if r, err := filepath.Rel(top, abs); err == nil && !outside(r) {
		rel = filepath.ToSlash(r)
	}
	p := plans.ParsePlan(abs, text)
	task, err := dispatch.Resolve(p, issue, *dry)
	if err != nil {
		return fail(err)
	}
	specRel := ""
	spec := strings.Replace(strings.TrimSuffix(abs, ".md")+"-design.md", string(filepath.Separator)+"plans"+string(filepath.Separator), string(filepath.Separator)+"specs"+string(filepath.Separator), 1)
	if _, err := os.Stat(spec); err == nil {
		specRel = spec
		if r, err := filepath.Rel(top, spec); err == nil && !outside(r) {
			specRel = filepath.ToSlash(r)
		}
	}
	return startAgent(c, dispatch.Command(role, issue, p, task, top, rel, specRel), *dry)
}

// startAgent runs the hc argv of a task agent and prints its address
// (dry: prints the argv as JSON instead).
func startAgent(c hc.Client, argv []string, dry bool) int {
	if dry {
		b, _ := json.Marshal(argv)
		fmt.Println(string(b))
		return 0
	}
	addr, err := c.R.Run(argv...)
	if err != nil {
		return fail(err)
	}
	fmt.Println(strings.TrimSpace(string(addr)))
	return 0
}

// legacyRepoName names the repo of the worktree top (commonDir: its absolute
// git common dir, may be ""): the fleet name of the worktree or of its main
// checkout, else the main checkout's folder name.
func legacyRepoName(f fleet.Fleet, top, commonDir string) string {
	if n := f.RepoAt("", top); n != "" {
		return n
	}
	if commonDir == "" {
		return filepath.Base(top)
	}
	main := strings.TrimSuffix(strings.TrimRight(commonDir, "/"), "/.git")
	if n := f.RepoAt("", main); n != "" {
		return n
	}
	return filepath.Base(main)
}

// repoNameAt is the striker.repo of the local worktree top (coordinators and
// task agents): legacyRepoName with the fleet (none: folder names) and git's
// common dir.
func repoNameAt(fleetPath, top string) string {
	common := ""
	if out, err := (gitrepo.Local{}).Git(top, "rev-parse", "--path-format=absolute", "--git-common-dir"); err == nil {
		common = strings.TrimSpace(string(out))
	}
	f, _ := fleet.Load(fleetPath)
	return legacyRepoName(f, top, common)
}

// runCoordinator labels this terminal striker.repo=<repo> and
// striker.coordinator=<topic> and prints the path of a filled coordinator
// brief. hc resolves "this terminal" itself (`hc get` without an argument);
// --terminal overrides it.
func runCoordinator(c hc.Client, fleetPath string, args []string) int {
	if len(args) < 1 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	fs := flag.NewFlagSet("coordinator", flag.ContinueOnError)
	term := fs.String("terminal", "", "terminal address (default: the current terminal)")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	topic := plans.Topic(args[0])
	_, top, err := worktreeTop()
	if err != nil {
		return fail(fmt.Errorf("striker coordinator läuft im Worktree des Plans: %w", err))
	}
	repo := repoNameAt(fleetPath, top)
	addr, err := dispatch.LabelCoordinator(c, *term, repo, topic)
	if err != nil {
		return fail(err)
	}
	fmt.Fprintf(os.Stderr, "striker: %s trägt striker.repo=%s, striker.coordinator=%s\n", addr, repo, topic)
	// The brief has {repo} {change} {status_file} {agents}: print a filled
	// copy (direct: a legacy coordinator runs on this computer).
	uh, _ := os.UserHomeDir()
	statusFile := filepath.Join(uh, ".striker", "status", repo+"--"+topic+".json")
	p, err := legacyBrief(filepath.Join(home.Dir(), "briefs", "coordinator.md"), filepath.Join(uh, ".striker", "briefs"), repo, topic, statusFile)
	if err != nil {
		return fail(err)
	}
	fmt.Fprintf(os.Stderr, "striker: repo=%s change=%s status_file=%s\n", repo, topic, statusFile)
	fmt.Println(p)
	return 0
}

// legacyBrief writes the coordinator brief filled for repo and change into
// outDir and returns its path.
func legacyBrief(tplPath, outDir, repo, change, statusFile string) (string, error) {
	tpl, err := os.ReadFile(tplPath)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(outDir, filepath.Base("coordinator-"+repo+"--"+change+".md"))
	return p, os.WriteFile(p, []byte(coord.FillBrief(string(tpl), repo, change, statusFile, false)), 0o644)
}

// extraFor is what the repo view needs beyond git for the repo at path on
// machine: its fleet name, a coordinator status reader over the given
// (already loaded) fleet, and its lead's status task and live state (found
// as status.Build finds leads: fleet label, else a local lead by cwd).
func extraFor(c hc.Client, f fleet.Fleet, home, machine, path string) repoview.Extra {
	x := repoview.Extra{
		Repo: f.RepoAt(machine, path),
		Read: func(m, repo, change string) json.RawMessage { return status.ReadCoord(home, c, f, m, repo, change) },
	}
	x.LeadTask, x.LeadState = status.LeadTask(status.LeadAt(c, f, home, machine, path))
	return x
}

// routes mounts /status and the bridge endpoints behind the Host guard.
func routes(port string, statusH, bridgeH http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/status", statusH)
	mux.Handle("/crew", statusH) // the serve.Server's second report
	for _, p := range []string{"/repo", "/space", "/doc", "/overview"} {
		mux.Handle(p, bridgeH)
	}
	return hostGuard(port, mux)
}

// hostGuard answers 403 unless the Host header names the loopback listener
// (127.0.0.1 or localhost on the listen port), which blocks DNS rebinding.
func hostGuard(port string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "127.0.0.1:"+port && r.Host != "localhost:"+port {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// newRelay is the relay of striker serve: the fleet loaded per tick, the ledger
// ~/.striker/relay.json, the briefs of home.Dir(), the herdr-app runner.
func newRelay(c hc.Client, fleetPath string) (*relay.Relay, error) {
	uh, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	l, err := relay.LoadLedger(filepath.Join(uh, ".striker", "relay.json"))
	if err != nil {
		return nil, err
	}
	logf := func(format string, a ...any) { fmt.Fprintf(os.Stderr, "striker: "+format+"\n", a...) }
	return &relay.Relay{
		C:     c,
		Herdr: hc.Exec{Bin: "herdr-app"}.Run,
		Fleet: func() fleet.Fleet {
			f, err := fleet.Load(fleetPath)
			if err != nil {
				logf("relay: %v", err)
			}
			return f
		},
		Briefs: filepath.Join(home.Dir(), "briefs"),
		L:      l,
		W:      &relay.Watcher{C: c, L: l, Logf: logf},
		Logf:   logf,
	}, nil
}

func runServe(c hc.Client, fleetPath string, args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:7522", "listen address (loopback only)")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	host, port, err := net.SplitHostPort(*addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "striker: invalid --addr:", err)
		return 2
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		fmt.Fprintf(os.Stderr, "striker: serve only binds loopback addresses, not %q\n", host)
		return 2
	}
	// each repo's GitHub slug and open PRs: gh at most once a minute per repo
	pulls := &prs.Cache{GH: ghExec{hc.Exec{Bin: "gh"}}, Git: func(m string) gitrepo.Runner { return gitrepo.For(hc.Exec{}, m) },
		Every: 60 * time.Second}
	build := func() status.Report {
		f, err := fleet.Load(fleetPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "striker:", err)
		}
		uh, _ := os.UserHomeDir()
		rep := status.Build(c, f, uh, time.Now())
		pulls.Fill(&rep, time.Now())
		return rep
	}
	s := serve.New(build, 20*time.Second)
	s.Add("/crew", func() any {
		f, _ := fleet.Load(fleetPath)
		uh, _ := os.UserHomeDir()
		return crew.Build(c, f, filepath.Join(uh, ".striker", "crew.json"), filepath.Join(uh, ".striker", "agents"), time.Now())
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go s.Run(ctx)
	if r, err := newRelay(c, fleetPath); err != nil {
		fmt.Fprintln(os.Stderr, "striker: relay off:", err) // an unreadable ledger: better nothing than twice
	} else {
		go r.Run(ctx, 10*time.Second)
	}
	extra := func(machine, path string) repoview.Extra {
		f, _ := fleet.Load(fleetPath) // once per request; no fleet: remote status dirs unknown, reported per coordinator
		uh, _ := os.UserHomeDir()
		return extraFor(c, f, uh, machine, path)
	}
	live := func(machine, path string) status.Repo {
		f, _ := fleet.Load(fleetPath)
		uh, _ := os.UserHomeDir()
		return status.For(c, f, uh, machine, path)
	}
	bh := bridge.Handler(bridge.NewSource(c, ghExec{hc.Exec{Bin: "gh"}}, extra, live))
	srv := &http.Server{Addr: *addr, Handler: routes(port, s.Handler(), bh)}
	go func() { <-ctx.Done(); srv.Close() }()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fail(err)
	}
	return 0
}

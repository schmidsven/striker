# Board PR Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Striker's board shows every open PR of a repo and a button for each `PR #<n>` in `needs_you`; a click
opens the PR on GitHub.

**Architecture:** A new Go package `internal/prs` resolves each repo's GitHub slug (`git remote get-url origin`,
local or through `hc exec`) and its open PRs (`gh pr list -R`), cached, and fills them into the `/status`
report in `runServe`. The LCARS board gets pure helpers in `board.js` and draws buttons in `striker.js`.

**Tech Stack:** Go 1.x (stdlib), herdr mod JavaScript (gpui-kit), node for `bridge.check.mjs`.

**Spec:** `openspec/changes/board-pr-links/design.md`

## Global Constraints

- `/status` fields: `github` (`owner/repo`, omitempty), `prs` (`[{number,title,url,draft,branch}]`, omitempty),
  `prs_error` (omitempty).
- `gh pr list -R <slug> --state open --json number,title,url,isDraft,headRefName --limit 50`, no directory.
- PR list cached per slug, refreshed at most every 60 s; slug cached per machine+path for the process' life,
  a failed slug lookup retried next build.
- Failing `gh`: keep last list, `prs_error` = first line of the error.
- Board: at most 5 PR rows, then `+<k> MORE ↗` → `https://github.com/<slug>/pulls`; rows `TOUCH` high;
  `PRS: <error>` in ROLE.alert at `TEXT_MIN`; needs_you button text `PR #<n> ↗`.
- A click on a PR button never triggers the row's lead click.
- Shell rules from AGENTS.md: one simple command per call, absolute paths.

## Review Focus

- Repo without `origin` or with a non-GitHub origin: no `github`, no `prs`, no error, board unchanged.
- `gh` not installed / not logged in: `prs_error` set, board shows `PRS: …`, the rest of the column intact.
- The same `PR #29` twice in one text: one button only.
- `PR#29`, `pr #29` and `PR #29,` (punctuation) all found; `#29` alone or `issue #29` not.
- A repo on another machine: slug via `hc exec --on <machine>`, `gh` still local.

---

### Task 1: /status: GitHub slug and open PRs per repo

**Files:**
- Create: `striker/internal/prs/prs.go`, `striker/internal/prs/prs_test.go`
- Modify: `striker/internal/status/status.go` (`Repo` struct), `striker/cmd/striker/main.go` (`runServe` build)

**Interfaces:**
- Produces:
  - `status.PR{Number int "number"; Title string "title"; URL string "url"; Draft bool "draft"; Branch string
    "branch"}` (in status, so prs → status is the only import direction).
  - `status.Repo` gains `GitHub string \`json:"github,omitempty"\``, `PRs []PR \`json:"prs,omitempty"\``,
    `PRsError string \`json:"prs_error,omitempty"\``.
  - `prs.Parse(b []byte) ([]status.PR, error)`: gh JSON (`number,title,url,isDraft,headRefName`) → sorted by
    number ascending.
  - `type prs.Cache struct { GH issues.GH; Git func(machine string) gitrepo.Runner; Every time.Duration }` with
    `func (c *Cache) Fill(rep *status.Report, now time.Time)`: per repo with a `Path`, slug from
    `Git(machine).Git(path, "remote", "get-url", "origin")` + `issues.Slug`, then PRs per slug.
    Machine: `*r.Machine` or `""`.

- [ ] **Step 1: Write the failing tests** in `prs_test.go` with fakes for `issues.GH` and `gitrepo.Runner`
  (count calls):
  - `TestParse`: input `[{"number":31,"title":"b","url":"u31","isDraft":true,"headRefName":"x"},{"number":29,…}]`
    → `[{29,…},{31,"b","u31",true,"x"}]`.
  - `TestFillSlugAndPRs`: one local repo, origin `git@github.com:o/r.git`, gh answers two PRs → `GitHub=="o/r"`,
    `len(PRs)==2`, gh called with exactly the Global Constraints argv.
  - `TestFillNoGitHub`: origin `https://gitlab.com/o/r` and a repo whose git fails → no `GitHub`, no `PRs`, no
    `PRsError`, gh never called.
  - `TestFillCaches`: two `Fill` 30 s apart → one gh call; at 61 s → two; slug lookup once in total.
  - `TestFillGhFails`: first fill ok (2 PRs), second at 61 s gh errors `"gh: not logged in\nmore"` → `PRs` still
    the 2, `PRsError=="gh: not logged in"`.
  - `TestFillRemote`: repo with machine `remote1` → `Git("remote1")` used.
  - `TestReportJSON`: a `status.Report` with one repo with `GitHub` and one PR marshals `"github":"o/r"` and
    `"prs":[{"number":29,"title":…,"url":…,"draft":false,"branch":…}]`; a repo without them has neither key.

- [ ] **Step 2: Run** `go -C /Users/schmidsven/develop/dg/striker-board-pr-links/striker test ./internal/prs/`
  Expected: build failure (package/fields missing). Commit the red tests.

- [ ] **Step 3: Implement** `status.PR` + fields, `prs.Parse`, `prs.Cache.Fill` (maps guarded by a mutex: `Fill`
  runs from the report refresher). In `runServe`'s `build`: one `cache := &prs.Cache{GH: ghExec{hc.Exec{Bin:
  "gh"}}, Git: func(m string) gitrepo.Runner { if m == "" { return gitrepo.Local{} }; return gitrepo.Remote{HC:
  hc.Exec{Bin: "hc"}, Machine: m} }, Every: 60 * time.Second}` built once outside, `cache.Fill(&rep, time.Now())`
  after `status.Build`. (Check how `hc.Client` exposes its runner; reuse it rather than a new `hc.Exec` if it
  does.)

- [ ] **Step 4: Run** `go -C /Users/schmidsven/develop/dg/striker-board-pr-links/striker test ./...` → all ok.

- [ ] **Step 5: Commit** with `tasks.md` line 1 ticked: `feat: /status names GitHub repo and open PRs`.

### Task 2: Board helpers prLinks and prRows

**Files:**
- Modify: `lcars/board.js`, `lcars/bridge.check.mjs`

**Interfaces:**
- Produces:
  - `prLinks(text: string, slug: string|null) → [{ label: "PR #<n>", url: "https://github.com/<slug>/pull/<n>" }]`
    — matches `/\bPR\s*#(\d+)/gi`, unique by number, in order; no slug → `[]`.
  - `prRows(prs: array|null, slug: string|null, max = 5) → { rows: [{ key: "<n>", number: "#<n>", title,
    draft: bool, url }], more: { label: "+<k> MORE", url: "https://github.com/<slug>/pulls" } | null }` — first
    `max` in the given order; `more` only when more than `max` and a slug exists.

- [ ] **Step 1: Write failing checks** in `bridge.check.mjs`:
  - `prLinks("PR #29 und PR #31 mergen", "o/r")` → two links, urls `…/o/r/pull/29`, `…/pull/31`.
  - `prLinks("pr#29, PR #29.", "o/r")` → one link.
  - `prLinks("issue #29 und #30", "o/r")` → `[]`; `prLinks("PR #29", null)` → `[]`; `prLinks(null, "o/r")` → `[]`.
  - `prRows` with 7 PRs → 5 rows, `more.label === "+2 MORE"`, `more.url === "https://github.com/o/r/pulls"`;
    with 2 → `more === null`; `prRows(null, "o/r")` → `{ rows: [], more: null }`; draft carried through.

- [ ] **Step 2: Run** `node /Users/schmidsven/develop/dg/striker-board-pr-links/lcars/bridge.check.mjs` → fails
  (missing export). Commit the red checks.

- [ ] **Step 3: Implement** both in `board.js`.

- [ ] **Step 4: Run** the check → `ok`.

- [ ] **Step 5: Commit** with `tasks.md` line 2 ticked: `feat: board helpers for PR links`.

### Task 3: Board UI

**Files:**
- Create: `lcars/open.js` (`export function openUrl(url)`, moved from `main.js:67-71` with `OPENER`)
- Modify: `lcars/main.js` (import `openUrl`), `lcars/striker.js` (`column()`, both needs_you renderers)

**Interfaces:**
- Consumes: `prLinks`, `prRows` (Task 2); `repo.github`, `repo.prs`, `repo.prs_error` (Task 1).

- [ ] **Step 1:** Move `openUrl` to `open.js`; `main.js` imports it. `node …/bridge.check.mjs` still `ok`.
- [ ] **Step 2:** needs_you rows (lead `striker.js:228-233`, coordinator `:268-272`): after the text, one button
  per `prLinks(n.text, repo.github)`: `TOUCH` high, 2 px ROLE.alert border, text `PR #<n> ↗` at `TEXT_MIN`
  bold; its click opens the url and stops propagation (gpui: handle on the button element so the row's
  `press` does not fire — check how `press` is built in `striker.js` and use the same mechanism with
  `stop_propagation` if available). Text and buttons wrap (`flex_wrap`) in narrow columns.
- [ ] **Step 3:** `OPEN PRS` section in `column()` after the needs_you block: `label("open prs", ROLE.label)`,
  then `prRows(repo.prs, repo.github)` rows: `TOUCH` high, `#<n>` bold, `DRAFT` in ROLE.neutral when draft,
  title truncated, `↗` at the end, whole row clickable → `openUrl(url)`; `more` as last row. Left out when no
  rows. `repo.prs_error` → `PRS: <ERROR>` line, ROLE.alert, `TEXT_MIN`.
- [ ] **Step 4: Verify live:** rebuild `striker` (`go -C …/striker build -o bin/striker ./cmd/striker` in the
  worktree is not live; the person tests after merge) — here: `node …/bridge.check.mjs` → `ok`, and
  `go -C …/striker vet ./...` clean. Live check is the person's after merge: open board, a repo with an open PR
  shows it, click opens the browser.
- [ ] **Step 5: Commit** with `tasks.md` line 3 ticked: `feat: board shows open PRs and PR buttons`.

### Finish

- `openspec validate board-pr-links --strict`, push `feature/board-pr-links`, open PR.

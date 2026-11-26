# PR Merge Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `striker serve` tells a repo's lead when one of its PRs was merged or closed.

**Architecture:** `prs.Cache` diffs each successful open-PR list against the previous one and hands vanished PRs,
with the repo's lead addresses, to a `Gone` callback. `prs.Notifier.Gone` asks `gh pr view` for the state and sends
`[Striker] …` to each lead through `hc send`.

**Spec:** `openspec/changes/pr-merge-notice/design.md`

## Global Constraints

- No notice on the first list after start, after a failed `gh pr list`, or for a PR still `OPEN`.
- `gh pr view <n> -R <slug> --json state`, no directory; output `{"state":"MERGED"}`.
- Text: `PR #<n> (<branch>) in <slug> ist gemergt. Steht er in deinem needs_you, trag ihn aus.`;
  closed: `… ist geschlossen, nicht gemergt. …`; sent as `lead.Message(text)`.
- Shell rules from AGENTS.md: one simple command per call, absolute paths.

---

### Task 1: Cache: report PRs that left the open list

**Files:** Modify `striker/internal/prs/prs.go`, `striker/internal/prs/prs_test.go`

- `Cache` gains `Gone func(slug string, pr status.PR, leads []string)` and a private `leads map[string][]string`
  (slug → lead addresses), set in `Fill` from `r.Lead.Address` (nil lead or empty address skipped, order of repos).
- `lookList`: after a successful parse, if the slug had a successful list before, call `Gone` for each old PR whose
  number is missing in the new list, after unlocking.
- Tests (red first): `TestGoneMerged` (list 29+31, then 31 only → one call with PR 29 and lead `t1`),
  `TestGoneNotOnFirstList`, `TestGoneNotOnGhError` (error then recovery without 29 → exactly one call),
  `TestGoneNilCallback` (no panic).

### Task 2: Notifier

**Files:** Create `striker/internal/prs/notice.go`, `striker/internal/prs/notice_test.go`

- `type Notifier struct { GH issues.GH; Send func(addr, text string) error; Logf func(string, ...any) }`,
  `func (n *Notifier) Gone(slug string, pr status.PR, leads []string)`.
- Tests (red first): merged → `Send("t1", "[Striker] PR #29 (feature/a) in o/r ist gemergt. Steht er in deinem
  needs_you, trag ihn aus.")` and the gh call `["", "pr","view","29","-R","o/r","--json","state"]`; closed → the
  closed text; open → no send; gh error → no send; no leads → no gh call, no send; two leads → two sends; nil Logf
  tolerated.

### Task 3: runServe wiring

**Files:** Modify `striker/cmd/striker/main.go`

- `pulls.Gone = (&prs.Notifier{GH: <same ghExec>, Send: c.Send, Logf: <stderr logger>}).Gone`.
- Verify: `go test ./...` in `striker/`, `go vet ./...`.

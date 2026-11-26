# Design: PR merge notice

## Intent

The person merges or closes PRs on GitHub, not through Striker. The lead that asked for it must learn it at once
(Striker's rule "Sofort zurückmelden"), without the person or Striker's Claude relaying it by hand.

## Goals / Non-goals

- Goal: every PR that leaves a repo's open list while `striker serve` runs is reported once to that repo's lead,
  as merged or closed.
- Non-goal: coordinators. The lead knows its coordinators and passes it on; a later change can address them.
- Non-goal: repos outside `fleet.json` (herdr-mods itself): `serve` lists no PRs for them today.
- Anti-goal: false notices. A PR that only fell out of the `--limit 50` window, or a failed `gh` call, must not
  produce a message.

## Approaches

1. **Diff in the PR cache (chosen).** `prs.Cache` already refreshes each slug's open list. After a successful
   refresh it compares with the previous successful list; each missing PR goes to a callback. The callback asks
   `gh pr view <n> -R <slug> --json state` and sends only for `MERGED` or `CLOSED`.
   Cheap (one extra `gh` call per vanished PR), no new state on disk.
2. Poll `gh pr list --state merged` per repo and keep a ledger of reported PRs. More `gh` calls, a new file, and
   it needs a start point to avoid flooding old merges.
3. GitHub webhooks / `gh event listen`. Needs a public endpoint or a preview feature; not available on the Mac.

## Design

- `prs.Cache` gains `Gone func(slug string, pr status.PR, leads []string)`. `Fill` remembers, per slug, the lead
  addresses of the repos with that slug (from `r.Lead.Address`, empty leads skipped).
- In `lookList`, after a successful parse: if a previous successful list exists, every PR in it whose number is not
  in the new list is passed to `Gone` (outside the lock), with the leads known at that time. The first list after
  start has no previous one: no notices (a restart never floods).
- A failed refresh keeps the last list and never calls `Gone`; the next successful refresh diffs against the last
  successful list.
- `prs.Notifier{GH issues.GH; Send func(addr, text string) error; Logf func(string, ...any)}` with method
  `Gone(slug, pr, leads)`: runs `gh pr view <n> -R <slug> --json state`; `MERGED` → "ist gemergt", `CLOSED` → "ist
  geschlossen, nicht gemergt", anything else or an error → log, no message. No leads → log, no message.
- Text: `[Striker] PR #29 (feature/a) in o/r ist gemergt. Steht er in deinem needs_you, trag ihn aus.`
  (`lead.Message` adds the prefix.)
- `runServe` wires `Gone: (&prs.Notifier{GH: gh, Send: c.Send, Logf: logf}).Gone`. `lookList` already runs
  through `Bg` (a goroutine in `serve`), so a slow `gh pr view` never holds the report.

## Left to the builder

Log format; test layout (fakes as in `prs_test.go`).

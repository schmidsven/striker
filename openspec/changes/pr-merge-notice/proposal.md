# Proposal

## Why

A lead puts "PR #n prüfen und mergen" into `needs_you`. When the person merges the PR on GitHub, nobody tells the
lead: the question stays in its status file and keeps blinking on the board. `striker serve` already lists each
repo's open PRs every 60 s, so it sees the PR vanish, but does nothing with it.

## What Changes

- When a PR drops out of a repo's open list, `striker serve` asks GitHub whether it was merged or closed and sends
  the repo's lead `[Striker] PR #<n> (<branch>) in <owner/repo> ist gemergt.` (or `… ist geschlossen, nicht
  gemergt.`), asking it to take the PR out of `needs_you`.

## Impact

`striker/internal/prs` (diff of lists, notifier), `striker/cmd/striker/main.go` (`runServe` wiring). No brief or
board changes: leads already act on `[Striker]` messages.

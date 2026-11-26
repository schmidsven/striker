# Proposal

## Why

Pull requests waiting on the person show on Striker's board only as text in `needs_you` ("PR #29 … prüfen und
mergen?"). The person cannot click them and has to look each PR up on GitHub by hand.

## What Changes

- `/status` names each repo's GitHub repository (`github`: `owner/repo`, from `origin`) and its open PRs
  (`prs`, from `gh pr list`, cached 60 s).
- Each board column lists the repo's open PRs (up to 5, then `+<k> MORE`); a click opens the PR.
- The board finds `PR #<n>` in a `needs_you` text (lead and coordinators) and shows a button `PR #<n> ↗` that
  opens `https://github.com/<owner>/<repo>/pull/<n>` in the browser.

## Impact

`striker/internal/status`, `lcars/board.js`, `lcars/striker.js`, `lcars/bridge.check.mjs`. No brief changes:
today's `needs_you` texts work as they are.

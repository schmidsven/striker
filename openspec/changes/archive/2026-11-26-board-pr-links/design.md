# Design: clickable PRs on Striker's board

## Intent

A PR waiting on the person opens with one click from Striker's board, and every open PR of a repo shows there,
also ones no agent put in `needs_you` (forgotten, or opened by hand). Goal: no searching on GitHub. Several open
PRs per repo, several per `needs_you` text. Non-goal: PR checks, reviews or merge state beyond open/draft.
Anti-goal: the click on a `needs_you` row stops going to the lead.

## Approaches

1. **PR number from the text (picked).** `/status` carries the repo's GitHub slug; the board finds `PR #<n>` in
   the text and builds the URL. Works with today's status files, no brief changes.
2. Field `url` in `needs_you`, written by leads and coordinators. Cleaner data, but only once every agent has a
   new brief and fills it in.
3. Both. Most robust, twice the work.

The person picked 1, and on top every open PR per repo from GitHub (`gh pr list`).

## Striker (`/status`)

- `status.Repo` gets `GitHub string \`json:"github,omitempty"\``: `issues.Slug` of
  `git remote get-url origin` in the repo's `path`, through `gitrepo` (local, or on the repo's machine as its
  user, like `repoview`). No origin or not GitHub: empty, not an error.
- The slug barely changes: cached per machine and path for the life of `striker serve`; a failed lookup is
  retried on the next build.
- `status.Repo` gets `PRs []PR \`json:"prs"\`` (`number`, `title`, `url`, `draft`, `branch`) and
  `PRsError string \`json:"prs_error,omitempty"\``: `gh pr list -R <slug> --state open --json
  number,title,url,isDraft,headRefName --limit 50`, run locally without a directory (like `issues.Closed`), so
  remote repos work too. Oldest first by number. No slug: `prs` empty, no error.
- `gh` costs a GitHub API call per repo: the list is cached per slug and refreshed at most every 60 s (the
  report itself every 20 s). A failing `gh` (not installed, not logged in) keeps the last list and sets
  `prs_error` to its first line.

## Board (`lcars/board.js`, `lcars/striker.js`)

- Pure `prLinks(text, slug)` in `board.js`: every `PR #<n>` (case-insensitive, also `PR#<n>`) once, in order of
  appearance, as `{ label: "PR #<n>", url: "https://github.com/<slug>/pull/<n>" }`; no slug → `[]`.
- Each `needs_you` row (lead and coordinator) gets one button per link beside the text: `TOUCH` high, ROLE.alert
  outline, text `PR #<n> ↗`. A click opens the URL (`exec` with `open` / `xdg-open` / `start`, like
  `openUrl` in `main.js`, moved to a shared module) and does not reach the row's lead click.

- Each column's body gets a section `OPEN PRS` (after the `needs_you` rows, before phase and task), one row
  per open PR: `TOUCH` high, `#<n>` then the title truncated, `DRAFT` in neutral for drafts, ↗ at the end. A
  click opens the PR's `url`. At most 5 rows; more → a last row `+<k> MORE ↗` opening
  `https://github.com/<slug>/pulls`. No open PRs: the section is left out. `prs_error`: one `TEXT_MIN` line in
  ROLE.alert, `PRS: <error>`.

```
[ABNAHME]  PR #29 (feature/confirmed-event) prüfen und mergen?   [PR #29 ↗]

OPEN PRS
 #29  Confirmed-History-Event mit Begründung              ↗
 #31  DRAFT  Renovate: update go deps                     ↗
```

## Left to the builder

Button placement in narrow columns (wrap under the text when needed); the shared module's name.

# Bugs

Known bugs, until there is a real tracker. One entry per bug: id, found, where, what, status. A fix names the
id in its commit (`Fixes B<n>`) and moves the entry to "Fixed".

## Open

- **B1** (2026-11-24, docs coordinator) `striker start-lead` for a local repo (no `machine`) builds a broken
  status-file path unless `status_dir` in `fleet.json` has an entry with an empty key.
- **B2** (2026-11-24, docs coordinator) `striker dispatch` names task terminals `<role>-<task>` only, so two
  coordinators of different changes both get e.g. `implementer-1`; they cannot be told apart (seen in a fleet
  repo: four `<repo>-relay-probe-*` sessions, the lead could not find its coordinator). Names should carry the
  change.
- **B3** (2026-11-24, docs coordinator) Bridge OVERVIEW in a worktree space (`<repo>-<change>`) shows
  "NO LEAD" instead of the repo's lead.
- **B4** (2026-11-25, striker coordinator, cut-over) `striker/setup/awayteam.sh` does not take over a previous
  state directory under `/var/lib/` (status and agents files), keeps awayteam's existing `settings.json` with its
  old paths (it installs the settings only when there is no `statusLine`), and leaves an old sudoers file beside
  the new one. A renamed state directory needed hand-made `cp`, `sed` and `rm` on the remote machine. The script
  should migrate the old directory, rewrite the paths in the settings and remove the old sudoers file.
- **B5** (2026-11-25, striker coordinator, screenshots) On Windows `Stop-ScheduledTask -TaskName Striker` ends
  only the `conhost.exe --headless` wrapper; `striker serve` keeps running and holds port 7522, so a new serve
  (the task restarted, or the demo's) fails with "Only one usage of each socket address". The installer and
  `docs-site/demo/README.md` should end the `striker` process themselves after stopping the task.
- **B6** (2026-11-25, striker coordinator, screenshots) Crew names of ended terminals stay taken in
  `~/.striker/crew.json`: after many short-lived task agents every name of the pool is used, and a new agent
  gets the fallback `CREWMAN <n>` (the demo coordinator became `LT CREWMAN 1`). Names should be freed when their
  terminal is gone.
- **B7** (2026-11-25, moving the working copy) Running `install.ps1` from a new folder leaves the old one's
  `striker\bin` in the user PATH and keeps an existing Claude status line in `~/.claude/settings.json` that
  points at the old binary. The installer should replace its own earlier PATH entry and status line.
- **B8** (2026-11-26, macOS install) `install.sh` sets `STRIKER_HOME` only in the LaunchAgent plist. In a
  shell, `striker status` falls back to `~/striker/striker` and fails with "open …/fleet.json: no such file or
  directory" when the working copy lives elsewhere (here `~/develop/dg/striker`). `home.Dir()` should find the
  directory from the binary's own location (`bin/..`), or the installer should set `STRIKER_HOME` for the shell.

## Fixed

- **B9** (2026-11-26, macOS install) Nothing started Striker's own Claude: after a fresh install Fleet
  Operations had no Claude terminal (and the layout's `striker-prompt` pointed at a foreign `t16`). Now the
  LCARS mod opens the space STRIKER in Striker's repo (`/status` `striker_repo`) at Herdr's start when no
  Striker runs.

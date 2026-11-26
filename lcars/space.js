// Which repo a Herdr space shows, and how a crew entry reads (no gpui imports, so node can check it:
// bridge.check.mjs). A space's first terminal is a poor guide: behind `sudo -i` its cwd is the user's home.

import { WORD } from "./palette.js";
import { parseAddress } from "./addr.js";

const up = (s) => String(s ?? "").toUpperCase();
const machineOf = (m) => (m == null || m === "" || m === "local" ? null : String(m));

// labels as an object, from an object or from "key=value" strings
function labelsOf(raw) {
  if (Array.isArray(raw)) {
    const out = {};
    for (const s of raw) {
      const i = String(s).indexOf("=");
      if (i > 0) out[String(s).slice(0, i)] = String(s).slice(i + 1);
    }
    return out;
  }
  return raw && typeof raw === "object" ? { ...raw } : {};
}

// Striker's own terminal by its label striker.self, from herdr's terminals(); null when none carries it (then the
// Claude in the space STRIKER is Striker).
export function strikerSelf(list) {
  const t = (Array.isArray(list) ? list : []).find((x) => labelsOf(x?.labels)["striker.self"]);
  return t?.address ?? null;
}

// What to start when Striker is missing: herdr's space.new params for a space STRIKER in his repo (`repo`, from
// /status striker_repo) with Claude told to read his role, or null when there is nothing to do: no repo known, a
// terminal labelled striker.self (`list`, herdr's terminals()), or a local space STRIKER (`spaces`) already open.
export function strikerLaunch(repo, list, spaces) {
  if (!repo || strikerSelf(list)) return null;
  if ((Array.isArray(spaces) ? spaces : []).some((s) => !machineOf(s?.machine) && up(s?.name) === "STRIKER")) return null;
  return {
    name: "STRIKER",
    folder: repo,
    tab: "striker",
    argv: ["claude", "--remote-control", "striker", "Lies striker/CLAUDE.md: das ist deine Rolle als Striker."],
  };
}

// The terminals of `space` (herdr's SpaceInfo): the panes of its tabs that hold a terminal, each with its live
// cwd and its labels from `list` (herdr's terminals()), matched across address forms ("t7" / "remote1/t7").
export function spaceTerminals(space, panes, list) {
  if (!space) return [];
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const own = machineOf(space.machine);
  const key = (address, machine) => { const a = parseAddress(address, machine); return `${a.machine ?? ""}|${a.id}`; };
  const byKey = new Map((Array.isArray(list) ? list : []).map((t) => [key(t?.address, t?.machine ?? own), t]));
  return (Array.isArray(panes) ? panes : []).filter((p) => tabs.has(p.tab) && p.terminal).map((p) => ({
    address: p.terminal,
    cwd: p.cwd ?? null,
    labels: labelsOf(byKey.get(key(p.terminal, own))?.labels),
  }));
}

// Where the repo of `space` is: { path, machine } or null.
// 1. the fleet entry (`/status` repos) whose `space` is the space's name: its `space_path`, on its machine
//    (one on the space's machine preferred);
// 2. a coordinator's terminal in the space (labels striker.repo + striker.coordinator): the space's folder, which
//    `striker start-coordinator` made the worktree, on the coordinator's machine from `/status`;
// 3. a local lead terminal in the space (`localLeads`, the space's terminals labelled striker.lead): its cwd;
// 4. a local space's first terminal with a live cwd (where the space is now; Herdr's folder is where it was
//    made); remote spaces skip this, their cwd is home behind `sudo -i`;
// 5. the space's folder.
// `terms` are the space's terminals with their labels (spaceTerminals).
export function repoPathFor(space, statusRepos, localLeads = [], terms = []) {
  if (!space) return null;
  const own = machineOf(space.machine);
  const repos = Array.isArray(statusRepos) ? statusRepos : [];
  const named = repos.filter((r) => r && r.space && r.space === space.name && (r.space_path || r.path));
  const fleet = named.find((r) => machineOf(r.machine) === own) ?? named[0];
  if (fleet) return { path: fleet.space_path || fleet.path, machine: machineOf(fleet.machine) };

  for (const t of Array.isArray(terms) ? terms : []) {
    const repo = t?.labels?.["striker.repo"], change = t?.labels?.["striker.coordinator"];
    if (!repo || !change) continue;
    const r = repos.find((x) => x?.name === repo);
    const c = (r?.coordinators ?? []).find((x) => x?.change === change);
    const path = space.folder || t.cwd;
    if (!path) continue;
    const machine = c ? parseAddress(c.address, r.machine ?? own).machine : own;
    return { path, machine };
  }

  const lead = (Array.isArray(localLeads) ? localLeads : []).find((t) => t?.cwd);
  if (lead) return { path: lead.cwd, machine: own };
  // where a local space is now: its first terminal's live cwd (a remote one's is home behind sudo -i: skipped)
  if (!own) {
    const term = (Array.isArray(terms) ? terms : []).find((t) => t?.cwd);
    if (term) return { path: term.cwd, machine: null };
  }
  return space.folder ? { path: space.folder, machine: own } : null;
}

// The Bridge's whole-view text for a /space or /repo error: a folder that is not a repo says so.
export function repoNotice(error) {
  if (/is not a git worktree/i.test(String(error ?? ""))) return "NO REPO FOR THIS SPACE";
  return up(`REPO UNREADABLE: ${error ?? "NO ANSWER"}`);
}

// A crew entry's second line without Striker: <SPACE> · <STATE WORD>.
export function crewLabel(agent, spaceName) {
  return `${up(spaceName)} · ${WORD[agent?.status] ?? up(agent?.status)}`;
}

// A token count briefly, as Striker's status line writes it: 999, 812K, 1.2M, 25M.
export function shortTokens(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.floor(n / 1000)}K`;
  if (n < 1e7) return `${(Math.floor(n / 1e5) / 10).toFixed(1)}M`;
  return `${Math.floor(n / 1e6)}M`;
}

// The /crew entry of a herdr agent (Striker's crew: name, rank, repo, model, tokens), matched by machine and
// terminal id across address forms; null when Striker has none.
export function crewEntry(crew, agent) {
  const want = parseAddress(agent?.address, agent?.machine);
  return (crew?.agents ?? []).find((e) => {
    const got = parseAddress(e?.address);
    return got.id === want.id && got.machine === want.machine;
  }) ?? null;
}

// A crew row's two lines. With Striker's entry: "<RANK> <NAME>" and "<REPO> · <STATE> · <MODEL> · <TOKENS>" (parts
// without data left out, the space name when Striker knows no repo); without: program · tab, and crewLabel.
export function crewLines(agent, entry) {
  const state = WORD[agent?.status] ?? up(agent?.status);
  if (!entry?.name) return [up(`${agent?.program?.name ?? agent?.app ?? "agent"} · ${agent?.tab_name}`), crewLabel(agent, agent?.space_name)];
  const parts = [up(entry.repo || agent?.space_name), state, entry.model ? up(entry.model) : null,
    entry.tokens > 0 ? shortTokens(entry.tokens) : null];
  return [`${entry.rank ? `${entry.rank} ` : ""}${entry.name}`, parts.filter(Boolean).join(" · ")];
}

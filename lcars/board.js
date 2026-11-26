// The Striker board's pure parts (no gpui imports, so node can check them: bridge.check.mjs). striker.js draws.
// In: one repo of Striker's /status (`coordinators: [{change, address, state, status}]`, status may be
// {"error": …}) and herdr's live agents by address.

import { ROLE, STATUS, WORD } from "./palette.js";

export const KIND = { antrag: "ANTRAG", abnahme: "ABNAHME", frage: "FRAGE", recht: "RECHT" };

const up = (s) => String(s ?? "").toUpperCase();

// the last part of a path, upper case: the worktree folder a coordinator works in ("/srv/alpha-rb" → "ALPHA-RB")
const folder = (p) => {
  const parts = String(p ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? up(parts[parts.length - 1]) : null;
};

// A repo's coordinators as board lines: the live state from herdr wins over the polled one; a status error keeps
// the coordinator listed (with the error, never in alert); alert only when it needs the person (needs_you
// entries, or its terminal is blocked). nameOf(address) gives Striker's crew name ({ label: "LT WERF", short:
// "WERF" }) or null; without one the line says COORD as before. The worktree is the folder of the terminal's cwd.
export function boardCoords(repo, live, nameOf = () => null) {
  const list = Array.isArray(repo?.coordinators) ? repo.coordinators : [];
  return list.filter((c) => c && c.change).map((c) => {
    const agent = live?.get?.(c.address);
    const state = agent?.status ?? (c.state || null);
    const st = c.status && typeof c.status === "object" && !c.status.error ? c.status : null;
    const error = c.status?.error ? String(c.status.error) : null;
    const needs = (Array.isArray(st?.needs_you) ? st.needs_you : []).filter((n) => n && n.text);
    const needy = needs.length > 0 || state === "blocked";
    const word = needy ? "NEEDS YOU" : WORD[state] ?? up(state ?? "UNKNOWN");
    const name = (c.address && nameOf(c.address)) || null;
    return {
      change: String(c.change), address: c.address ?? null, state, needs, needy, error, task: st?.task ?? null,
      updated: st?.updated ?? null, who: name?.short ?? null, name: name?.label ?? null,
      label: name ? `${name.label} · ${up(c.change)} · ${word}` : `COORD ${up(c.change)} · ${word}`,
      worktree: folder(agent?.cwd),
      color: needy ? ROLE.alert : STATUS[state] ?? ROLE.neutral,
    };
  });
}

// The small line of a board column's header: who asks the person, else the lead and its state.
// lead: { name: "LCDR PATA" | null } or null (no lead); word: the lead's state word (WORKING, COMPLETE, ...).
export function headLine({ lead, leadNeedy = false, word = "", coords = [] }) {
  if (leadNeedy) return `${lead?.name ?? "LEAD"} · NEEDS YOU`;
  const asking = coords.filter((c) => c.needy);
  if (asking.length) {
    const c = asking[0];
    const more = asking.length > 1 ? ` · +${asking.length - 1}` : "";
    return `${c.name ? `${c.name} ·` : "COORD"} ${up(c.change)} · NEEDS YOU${more}`;
  }
  if (!lead) return "NO LEAD";
  return `${lead.name ?? "LEAD"} · ${word}`;
}

// Where a click on a column's head goes: the terminal of whoever asks the person (the lead, else the first
// asking coordinator), else the lead's; null without either. lead: { address } or null.
export function asker({ lead, leadNeedy = false, coords = [] }) {
  if (leadNeedy && lead?.address) return lead.address;
  const c = coords.find((x) => x.needy && x.address);
  if (c) return c.address;
  return lead?.address ?? null;
}

const gh = (slug) => `https://github.com/${slug}`;

// The PRs a needs_you text names ("PR #29", "pr#29"; a bare "#29" is not one), each once in order of appearance,
// as buttons to the repo's GitHub (slug "owner/repo" from /status `github`); none without a slug.
export function prLinks(text, slug) {
  if (!slug || !text) return [];
  const seen = new Set();
  const out = [];
  for (const m of String(text).matchAll(/\bPR\s*#(\d+)/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ label: `PR #${m[1]}`, url: `${gh(slug)}/pull/${m[1]}` });
  }
  return out;
}

// A column's OPEN PRS (/status `prs`): the first `max` as rows, the rest as one row to the repo's pulls page.
export function prRows(prs, slug, max = 5) {
  const list = Array.isArray(prs) ? prs.filter((p) => p && p.number) : [];
  const rows = list.slice(0, max).map((p) => ({ key: String(p.number), number: `#${p.number}`, title: String(p.title ?? ""),
    draft: !!p.draft, url: p.url }));
  const more = list.length > max && slug ? { label: `+${list.length - max} MORE`, url: `${gh(slug)}/pulls` } : null;
  return { rows, more };
}

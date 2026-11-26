// Striker's board for the LCARS frame: every repo of Striker's fleet as an LCARS
// column, with its lead's live status, its phase, progress and what waits on the person.
// The data comes from `striker serve` (127.0.0.1:7522/status, the same answer Striker reads), polled by the
// sidebar and kept in shared state "striker.fleet", so every part of the frame shows the same.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, run, shared, setShared, spaces, layout, checking } from "herdr";
import { parseAddress } from "./addr.js";
import { withPromptTerminal } from "./prompt.js";
import { stardate } from "./stardate.js";
import { C, ROLE, STATUS, WORD, TEXT_MIN, TEXT_BODY, TOUCH } from "./palette.js";
import { KIND, boardCoords, asker, headLine, prLinks, prRows } from "./board.js";
import { openUrl } from "./open.js";
import { crewEntry, strikerSelf } from "./space.js";

export const FLEET_KEY = "striker.fleet";
export const VIEW_KEY = "striker.view"; // "board" while the board is shown, else terminals
export const POLL = 20000;
const STATUS_URL = "http://127.0.0.1:7522/status";

const PHASES = [["design", "DESIGN"], ["plan", "PLAN"], ["implement", "BUILD"], ["review", "REVIEW"], ["push", "PUSH"]];
const GAP = 4;

const up = (s) => String(s ?? "").toUpperCase();
const two = (n) => String(n).padStart(2, "0");

// --- data ---------------------------------------------------------------------------------------

let asking = 0; // when the last poll started; one at a time across this mod's copies
export async function pollFleet() {
  if (asking && Date.now() - asking < 90000) return;
  asking = Date.now();
  const prev = shared(FLEET_KEY);
  try {
    let next;
    try {
      const r = await fetch(STATUS_URL);
      if (r.ok) {
        let data = null;
        try { data = await r.json(); } catch { /* unparsable body, handled below */ }
        next = data && typeof data === "object"
          ? { ok: true, at: Date.now(), updated: data.updated ?? null, repos: data.repos ?? [] }
          : { ...(prev ?? {}), ok: false, error: "STRIKER SERVE BAD ANSWER", at: Date.now() };
      } else {
        next = { ...(prev ?? {}), ok: false, error: `STRIKER SERVE ANSWERED ${r.status}`, at: Date.now() };
      }
    } catch {
      next = { ...(prev ?? {}), ok: false, error: "STRIKER SERVE NOT RUNNING", at: Date.now() };
    }
    // only a visible change is written, so a quiet fleet never redraws the window: the payload
    // without the volatile `at`/`updated`, or a changed scan text (the second of `updated`, STALE)
    const core = (s) => JSON.stringify({ ...(s ?? {}), at: 0, updated: 0 });
    if (core(next) !== core(prev) || (prev ? scanText(next, Date.now()) !== scanText(prev, Date.now()) : true)) setShared(FLEET_KEY, next);
  } finally {
    asking = 0;
  }
}

// Striker's crew (names, ranks, model, tokens) for the sidebar's CREW rows, from /crew into shared "striker.crew";
// written only when it changed. Striker not answering keeps the last answer (the rows fall back per agent).
export const CREW_KEY = "striker.crew";
const CREW_URL = "http://127.0.0.1:7522/crew";
let askingCrew = 0;
export async function pollCrew() {
  if (askingCrew && Date.now() - askingCrew < 90000) return;
  askingCrew = Date.now();
  try {
    const r = await fetch(CREW_URL);
    if (!r.ok) return;
    const data = await r.json();
    if (!data || !Array.isArray(data.agents)) return;
    if (JSON.stringify(data) !== JSON.stringify(shared(CREW_KEY))) setShared(CREW_KEY, data);
  } catch { /* striker serve not running or an old one without /crew */ } finally {
    askingCrew = 0;
  }
}

// One repo, merged: the lead's live status from Herdr wins over the script's (it is instant); its coordinators
// (one per change) with theirs. A coordinator that needs the person makes the repo need them too.
function view(repo, live, nameOf = () => null) {
  const lead = repo.lead;
  const agent = lead ? live.get(lead.address) : null;
  const state = agent?.status ?? (lead?.state || null);
  const st = repo.status && !repo.status.error ? repo.status : null;
  const needs = (st?.needs_you ?? []).filter((n) => n && n.text);
  const coords = boardCoords(repo, live, nameOf);
  const leadNeedy = needs.length > 0 || state === "blocked";
  const leadName = lead ? nameOf(lead.address) : null;
  return { repo, lead, leadName, agent, state, st, needs, coords, leadNeedy, needy: leadNeedy || coords.some((c) => c.needy) };
}

// Striker's crew name of a terminal ({ label: "LCDR PATA", short: "PATA" }), or null while Striker has none
function crewNames() {
  const crew = shared(CREW_KEY);
  return (address) => {
    const e = crewEntry(crew, { address });
    return e?.name ? { label: [e.rank, e.name].filter(Boolean).join(" "), short: e.name } : null;
  };
}

export function fleetCounts() {
  const f = shared(FLEET_KEY);
  if (!f?.repos) return null;
  const live = new Map(agents().map((a) => [a.address, a]));
  const all = f.repos.map((r) => view(r, live));
  return {
    need: all.filter((v) => v.needy).length,
    working: all.filter((v) => !v.needy && v.state === "working").length,
    repos: all.length,
  };
}

// --- actions ------------------------------------------------------------------------------------

export function showBoard(on) {
  setShared(VIEW_KEY, on ? "board" : null);
  run("layout.select", { stack: "work-view", child: on ? "striker-board" : "main" });
}
// Striker: the Claude with the label striker.self (e.g. as the lead of herdr-mods), else the one in the space STRIKER
const strikerAgent = () => {
  const self = strikerSelf(terminals());
  if (self) {
    const want = parseAddress(self);
    return agents().find((a) => { const p = parseAddress(a.address, a.machine); return p.id === want.id && p.machine === want.machine; })
      ?? { address: self };
  }
  return agents().find((a) => up(a.space_name) === "STRIKER");
};

// Point the layout's striker-prompt block at Striker's current terminal (it changes when Striker is restarted).
// Only Striker on this computer: a layout block shows local terminals by their bare id.
export function fixStrikerPrompt() {
  if (checking()) return;
  const a = strikerAgent();
  if (!a) return;
  const { machine, id } = parseAddress(a.address, a.machine);
  if (machine) return;
  const next = withPromptTerminal(layout(), id);
  if (next) run("layout.set", { layout: next });
}
// On the board, Striker's prompt sits under it (the layout's striker-prompt block): give it the keyboard.
// Elsewhere, go to Striker's own pane.
const talkToStriker = () => {
  const a = strikerAgent();
  if (a && shared(VIEW_KEY) === "board") { run("pane.focus", { terminal: a.address }); return; }
  if (a) { showBoard(false); run("agent.focus", { terminal: a.address }); return; }
  const s = spaces().find((s) => up(s.name) === "STRIKER");
  if (s) { showBoard(false); run("space.select", { id: s.id }); }
};
const focusLead = (address) => { showBoard(false); run("agent.focus", { terminal: address }); };

// --- drawing ------------------------------------------------------------------------------------

function ago(iso, now) {
  const t = Date.parse(iso ?? "");
  if (!t) return null;
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "JUST NOW";
  if (m < 60) return `${m} MIN AGO`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} H AGO` : `${Math.round(h / 24)} DAYS AGO`;
}

const press = (el, fn) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(() => fn());
const label = (text, color) => div().text_size(TEXT_MIN).font_weight(700).text_color(color ?? ROLE.label).child(up(text));

// a PR named in a needs_you text: an alert-outlined button that opens it; its press does not reach the row (lead)
const prButton = (id, link) => h_flex().id(id).h(TOUCH).flex_none().px(10).items_center().rounded(TOUCH / 2)
  .border(2).border_color(ROLE.alert).text_size(TEXT_MIN).font_weight(700).text_color(ROLE.alert)
  .cursor_pointer().hover((s) => s.opacity(0.85))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { cx?.stop_propagation?.(); openUrl(link.url); })
  .child(`${link.label} ↗`);

// one needs_you row: kind, text, a button per PR the text names
const needRow = (id, n, slug, onRow, indent = 0) => h_flex().id(id).w_full().gap(8).items_start().flex_wrap().pl(indent)
  .when(!!onRow, (e) => press(e, onRow))
  .child(div().flex_none().w(86).h(24).bg(ROLE.alert).flex().items_center().justify_center()
    .text_size(TEXT_MIN).font_weight(700).text_color(ROLE.ink).child(KIND[n.kind] ?? up(n.kind ?? "FRAGE")))
  .child(div().flex_1().min_w(120).text_size(TEXT_BODY).text_color(ROLE.text).child(String(n.text)))
  .children(prLinks(n.text, slug).map((l) => prButton(`${id}-pr-${l.label.slice(4)}`, l)));

// a column's OPEN PRS: up to five rows, then +<k> MORE; a gh error as one alert line
function openPrs(id, repo) {
  const { rows, more } = prRows(repo.prs, repo.github);
  if (!rows.length && !repo.prs_error) return null;
  const row = (key, url, kids) => press(h_flex().id(`${id}-pr-${key}`).w_full().h(TOUCH).flex_none().gap(8).items_center(),
    () => openUrl(url)).children(kids);
  return v_flex().w_full().gap(GAP)
    .child(label("open prs", ROLE.label))
    .children(rows.map((p) => row(p.key, p.url, [
      div().flex_none().text_size(TEXT_BODY).font_weight(700).text_color(ROLE.text).child(p.number),
      ...(p.draft ? [div().flex_none().text_size(TEXT_MIN).font_weight(700).text_color(ROLE.neutral).child("DRAFT")] : []),
      div().flex_1().min_w(0).truncate().text_size(TEXT_BODY).text_color(ROLE.text).child(p.title),
      div().flex_none().text_size(TEXT_BODY).text_color(ROLE.label).child("↗"),
    ])))
    .when(!!more, (e) => e.child(row("more", more?.url, [
      div().flex_1().text_size(TEXT_MIN).font_weight(700).text_color(ROLE.label).child(`${more?.label} ↗`)])))
    .when(!!repo.prs_error, (e) => e.child(div().w_full().text_size(TEXT_MIN).text_color(ROLE.alert)
      .child(up(`PRS: ${repo.prs_error}`))));
}

// a slab with its label bottom-right, the LCARS way
function slab(id, color, text, h, extra) {
  const el = div().id(id).w_full().h(h).flex_none().bg(color).flex().items_end().justify_end().px(10).pb(2)
    .text_color(ROLE.ink).text_size(15).font_weight(700).child(up(text));
  return extra ? extra(el) : el;
}

function phaseRow(id, phase) {
  const at = PHASES.findIndex(([p]) => p === phase);
  return h_flex().w_full().h(24).flex_none().gap(GAP).children(PHASES.map(([p, word], i) => {
    const color = i === at ? ROLE.active : at >= 0 && i < at ? C.tan : ROLE.track;
    return div().id(`${id}-phase-${p}`).flex_1().h_full().bg(color).flex().items_center().justify_center()
      .text_size(TEXT_MIN).font_weight(700).text_color(i === at || (at >= 0 && i < at) ? ROLE.ink : ROLE.neutral).child(word);
  }));
}

function progressRow(id, progress) {
  const total = Math.max(0, Math.min(40, Number(progress?.total) || 0));
  const done = Math.max(0, Math.min(total, Number(progress?.done) || 0));
  if (!total) return null;
  return h_flex().w_full().h(16).flex_none().gap(2).items_center()
    .children(Array.from({ length: total }, (_, i) => div().id(`${id}-seg-${i}`).flex_1().h_full()
      .bg(i < done ? ROLE.working : ROLE.track).when(i === 0, (e) => e.rounded_l(8)).when(i === total - 1, (e) => e.rounded_r(8))))
    .child(div().flex_none().pl(6).text_size(TEXT_MIN).font_weight(700).text_color(ROLE.working).child(`${two(done)}/${two(total)}`));
}

// what people read; name stays the key (ids, lead label, status file)
const title = (repo) => repo.title || repo.name;

function column(v, now) {
  const { repo, lead, state, st, needs, needy } = v;
  const id = `striker-${repo.name}`;
  const phase = st?.phase ?? null;
  const prs = openPrs(id, repo);
  // a finished task is done, whatever its lead does now
  const head = needy ? ROLE.alert : phase === "done" ? ROLE.done : STATUS[state] ?? ROLE.neutral;
  const word = phase === "done" ? "COMPLETE" : WORD[state] ?? up(state ?? "UNKNOWN");
  // the small line names who asks (crew name, and the change when a coordinator asks), else the lead and its state
  const who = headLine({ lead: lead ? { name: v.leadName?.label ?? null } : null, leadNeedy: v.leadNeedy, word, coords: v.coords });
  const header = div().id(`${id}-head`).w_full().h(76).flex_none().bg(head).rounded_tl(24).rounded_tr(8)
    .flex().flex_col().justify_end().items_end().gap(2).px(12).pb(4).text_color(ROLE.ink).font_weight(700)
    .when(needy, (e) => e.loop("opacity", { from: 0.55, to: 1, period: 900 }))
    // a click goes to whoever asks, else to the lead
    .when(!!asker({ lead, leadNeedy: v.leadNeedy, coords: v.coords }), (e) =>
      press(e, () => focusLead(asker({ lead, leadNeedy: v.leadNeedy, coords: v.coords }))))
    .child(div().text_size(TEXT_MIN).child(who))
    .child(div().text_size(30).child(up(title(repo))));

  // the body scrolls when a repo has more questions and notes than the column is tall
  const body = v_flex().id(`${id}-body`).w_full().flex_1().min_h(0).overflow_y_scrollbar().gap(10).p(10).border_l(14).border_color(head)
    // what waits on the person comes first
    .when(needs.length > 0, (e) => e.child(v_flex().w_full().gap(GAP).children(needs.map((n, i) =>
      needRow(`${id}-need-${i}`, n, repo.github, lead?.address ? () => focusLead(lead.address) : null)))))
    .when(!!prs, (e) => e.child(prs))
    .when(!!phase && phase !== "idle" && phase !== "done", (e) => e.child(v_flex().w_full().gap(4)
      .child(label("phase", ROLE.label)).child(phaseRow(id, phase))))
    .child(v_flex().w_full().gap(2)
      .child(label("task", ROLE.label))
      .child(div().w_full().text_size(16).text_color(st?.task ? ROLE.text : ROLE.neutral).child(st?.task ?? "NO TASK")))
    .when(!!st?.progress?.total, (e) => e.child(v_flex().w_full().gap(4).child(label("progress", ROLE.label)).child(progressRow(id, st.progress))))
    .when(!!st?.note, (e) => e.child(v_flex().w_full().gap(2).child(label("status", ROLE.label))
      .child(div().w_full().text_size(TEXT_BODY).text_color(ROLE.text).child(String(st.note)))))
    .when(!!repo.status?.error, (e) => e.child(div().w_full().text_size(TEXT_MIN).text_color(ROLE.alert).child(up(`STATUS: ${repo.status.error}`))))
    .when(!st && !repo.status?.error && !!lead, (e) => e.child(div().text_size(TEXT_MIN).text_color(ROLE.neutral).child("NO STATUS FILE YET")));

  const leadLine = lead
    ? h_flex().id(`${id}-lead`).w_full().h(TOUCH).flex_none().gap(6).items_center()
      .child(div().w(14).h_full().bg(STATUS[state] ?? ROLE.neutral).rounded_l(15)
        .when(state === "blocked", (e) => e.loop("opacity", { from: 0.4, to: 1, period: 700 })))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(TEXT_MIN).font_weight(700).text_color(ROLE.text).truncate()
          .child(`${v.leadName?.label ?? "LEAD"} · ${WORD[state] ?? up(state ?? "")}`))
        .child(div().text_size(TEXT_MIN).text_color(ROLE.neutral).truncate()
          .child(up([lead.address, lead.msg, st?.updated ? `UPDATED ${ago(st.updated, now)}` : null].filter(Boolean).join(" · ")))))
      .when(true, (e) => press(e, () => focusLead(lead.address)))
    : slab(`${id}-nolead`, ROLE.neutral, "no lead · ask striker", 30);

  // the repo's coordinators, one per change, each with what it asks the person; a status error keeps it listed
  const coordLines = v.coords.map((c, k) => v_flex().id(`${id}-coord-${k}`).w_full().flex_none().gap(GAP)
    .child(h_flex().id(`${id}-coord-${k}-line`).w_full().h(TOUCH).flex_none().gap(6).items_center()
      .child(div().w(14).h_full().bg(c.color).rounded_l(15)
        .when(c.needy, (e) => e.loop("opacity", { from: 0.4, to: 1, period: 700 })))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(TEXT_MIN).font_weight(700).text_color(ROLE.text).truncate().child(c.label))
        .child(div().text_size(TEXT_MIN).text_color(ROLE.neutral).truncate()
          .child(up([c.address, c.worktree, c.task, c.error ? `STATUS: ${c.error}` : null, c.updated ? `UPDATED ${ago(c.updated, now)}` : null]
            .filter(Boolean).join(" · ")))))
      .when(!!c.address, (e) => press(e, () => focusLead(c.address))))
    .children(c.needs.map((n, i) =>
      needRow(`${id}-coord-${k}-need-${i}`, n, repo.github, c.address ? () => focusLead(c.address) : null, 20))));

  return v_flex().id(id).flex_1().min_w(220).h_full().gap(GAP)
    .child(header)
    .child(body)
    .child(leadLine)
    .children(coordLines)
    .child(div().w_full().h(18).flex_none().bg(head).rounded_bl(18));
}

// SCAN time comes from the report's own `updated`; old or failed data is marked STALE
function scanText(f, now) {
  if (!f?.at) return "SCANNING";
  const t = Date.parse(f.updated ?? "") || f.at;
  const stale = f.ok === false || now - t > 60000;
  return `SCAN ${stardate(t)}${stale ? " · STALE" : ""}`;
}

export function board(now) {
  const f = shared(FLEET_KEY);
  // live agents with the cwd of their pane (agents() has none): a coordinator line names its worktree folder
  const cwds = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.cwd ?? null]));
  const live = new Map(agents().map((a) => [a.address, { ...a, cwd: a.cwd ?? cwds.get(a.address) ?? null }]));
  const all = (f?.repos ?? []).map((r) => view(r, live, crewNames()));
  const header = h_flex().w_full().h(56).flex_none().gap(GAP)
    .child(div().id("striker-title").flex_1().h_full().bg(ROLE.frame).rounded_tl(28).flex().items_end().justify_between()
      .px(14).pb(4).text_color(ROLE.ink).font_weight(700)
      .child(div().text_size(TEXT_MIN).child(scanText(f, now)))
      .child(div().text_size(30).child("STRIKER · FLEET OPERATIONS")))
    .child(slab("striker-talk", C.tan, "talk to striker", 56, (e) => press(e.w(150).ml(12).rounded(28).pr(28), talkToStriker)))
    .child(slab("striker-terminals", ROLE.neutral, "terminals", 56, (e) => press(e.w(130).rounded(28).pr(28), () => showBoard(false))
      .hover((s) => s.bg(ROLE.hover))));

  const columns = !f
    ? div().flex_1().text_size(16).text_color(ROLE.neutral).child("SCANNING THE FLEET …")
    : all.length
      ? h_flex().id("striker-columns").w_full().flex_1().min_h(0).gap(12).children(all.map((v) => column(v, now)))
      : div().flex_1().text_size(16).text_color(ROLE.neutral).child("NO REPOS FROM STRIKER SERVE");

  return v_flex().id("striker-board").size_full().bg(ROLE.bg).gap(10).pt(4)
    .child(header)
    .when(f?.ok === false && !!f?.error, (e) => e.child(div().text_size(TEXT_MIN).text_color(ROLE.alert).truncate().child(up(`SCAN FAILED: ${f.error}`))))
    .child(columns);
}

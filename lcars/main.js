// LCARS: the frame of the lcars layout. One mod draws every part; the layout says which with props().part:
// "top" (the upper elbow, arm and title), "side" (spaces and crew as LCARS buttons), "tabs" (the tab pills)
// and "bottom" (the lower elbow and the status arm); in the work area "board" (Striker), "bridge", "bridge-rule" and "bridge-bottom"
// (the space's plan and the field under it, bridge.js). As a popup it is "machines" (where a new space goes).
// Right-clicks open Herdr's own menu mod, so rename, close, split and worktrees work as in its other layouts.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, machines, run, props, setAgentOrder, window, openOverlay, closeOverlay, home, shared, setShared, nextCommand } from "herdr";
import { openUrl } from "./open.js";
import * as fs from "fs/promises";
import { board, pollFleet, pollCrew, fixStrikerPrompt, fleetCounts, showBoard, VIEW_KEY, CREW_KEY, POLL as FLEET_POLL } from "./striker.js";
import { C, ROLE, STATUS, SPACE_COLORS, TEXT_MIN, TEXT_BODY, TOUCH } from "./palette.js";
import { crewLines, crewEntry } from "./space.js";
import { stardate } from "./stardate.js";
import { bridge, bridgeBottom, bridgeRule, bottomCommand, checkBottom, restoreBottom, pollBridge, showBridge, pickChange, BRIDGE_KEY, TICK as BRIDGE_TICK } from "./bridge.js";

// leaving Striker's board or the Bridge: any click that picks a space, tab or agent shows the terminals again
const toTerminals = () => {
  if (shared(VIEW_KEY) === "board") showBoard(false);
  if (shared(BRIDGE_KEY)) showBridge(null);
};
// Striker's board and the Bridge share the work area: showing the board hides the Bridge
const toBoard = (on) => { if (on) { restoreBottom(); setShared(BRIDGE_KEY, null); } showBoard(on); };

const SIDE = 210; // the sidebar's width, which the elbows match
const ARM = 20; // the thickness of the horizontal arms
const GAP = 4; // black between LCARS blocks

const up = (s) => String(s ?? "").toUpperCase();
const two = (n) => String(n).padStart(2, "0");

// The shapes say what a thing is (docs/lcars-colors.md):
// a section heading is text on black with a rule, a display is a square block, a button has a round right end.
const SECTION = 12; // black above every section heading
const MACHINE = 72; // the width of a machine's block in the sidebar
const pill = (el, h) => el.rounded_tr(h / 2).rounded_br(h / 2).pr(h / 2);
function section(id, label) {
  return h_flex().id(id).w_full().h(20).flex_none().mt(SECTION).gap(6).items_center()
    .child(div().w(18).h(12).flex_none().bg(ROLE.frame))
    .child(div().flex_none().text_size(TEXT_MIN).font_weight(700).text_color(ROLE.section).child(up(label)))
    .child(div().flex_1().h(2).bg(ROLE.section));
}

// a block of LCARS colour with a black label set in its bottom-right corner
function slab(id, color, label, h, extra) {
  let el = div().id(id).w_full().h(h).flex_none().bg(color).flex().items_end().justify_end().px(10).pb(2)
    .text_color(ROLE.ink).text_size(15).font_weight(700).child(up(label));
  return extra ? extra(el) : el;
}

// Shepherdr (its web app runs on this computer; its port is in ~/.shepherdr/server.json): what waits on the human, read from
// GET /api/snapshot every POLL ms. null is "not running", never an error; nothing is drawn before the first answer.
const POLL = 12000;
async function shepherdr() {
  let port = 7787;
  try { port = JSON.parse(await fs.readFile(`${home()}/.shepherdr/server.json`, "utf8")).port || port; } catch {}
  const url = `http://127.0.0.1:${port}`;
  const res = await fetch(`${url}/api/snapshot`);
  if (!res.ok) return null;
  const snap = await res.json();
  const places = new Map((snap.places ?? []).map((p) => [p.id, p]));
  const tasks = (snap.tasks ?? []).filter((t) => places.has(t.place) && !t.archived);
  const asks = Object.keys(snap.asks ?? {}).filter((id) => places.has(id) && snap.asks[id]);
  const count = (...st) => tasks.filter((t) => st.includes(t.status)).length;
  // merging counts as working: Shepherdr is busy with it
  return { url, need: asks.length + count("need"), ready: count("ready"), working: count("work", "merging") };
}

// Herdr's menu mod at the pointer: tab is "space", "tab", "pane" or "global"
const menu = (tab, target) => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab, target } });
// Herdr's new menu: a terminal, each installed agent, a new space, worktrees
const newMenu = () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
// a right-click handler that opens one menu; stopping the press keeps the bar behind from opening its own
const onRight = (open) => (_e, cx) => { cx.stop_propagation(); open(); };
const globalMenu = () => menu("global", {});
// where a new space goes, when there is more than this computer
function newSpace() {
  const away = machines().filter((m) => m.name);
  if (!away.length) return run("space.new", {});
  // padding, title, then a TOUCH row per machine
  openOverlay({ mod: "lcars", kind: "popup", width: 230, height: 12 + 30 + (GAP + TOUCH) * (away.length + 1),
    frame: "none", props: { part: "machines" } });
}

export default class Lcars extends View {
  init(_props, cx) {
    this.now = Date.now();
    const part = _props?.part ?? props()?.part;
    // the top part's stardate is a clock with seconds; every other part only needs the time now and then
    cx.timer.every(part === "top" ? 1000 : 15000, (cx) => { this.now = Date.now(); cx.notify(); });
    // the status arm shows Shepherdr; it polls on its own and redraws only when the answer changed
    this.shep = undefined; // undefined: not asked yet, null: not running
    // the sidebar no longer shows Shepherdr; the status arm still does, and only while it runs
    if (part === "bottom") {
      this.poll(cx);
      cx.timer.every(POLL, (cx) => this.poll(cx));
    }
    // Striker's fleet: the sidebar (always shown) keeps it fresh for the board and the status arm
    if (part === "side" || part === "board") {
      cx.spawn(async () => { await pollFleet(); });
      if (part === "side") {
        cx.spawn(async () => { await pollCrew(); fixStrikerPrompt(); });
        cx.timer.every(FLEET_POLL, (cx) => cx.spawn(async () => { await pollFleet(); await pollCrew(); fixStrikerPrompt(); }));
      }
    }
    // the Bridge asks Striker for its space only while it is shown; the tick itself fetches nothing
    if (part === "bridge") {
      this.specScroll = ScrollHandle.new(); // SPEC mode's reading area: a heading click scrolls it
      cx.spawn(async () => { await pollBridge(); });
      cx.timer.every(BRIDGE_TICK, (cx) => cx.spawn(async () => { await pollBridge(); }));
    }
    // the bottom field's rule keeps the layout file from holding a terminal the Bridge no longer shows
    if (part === "bridge-rule") {
      checkBottom();
      cx.timer.every(BRIDGE_TICK, () => checkBottom());
    }
    if (part === "bridge-bottom") this.bottomBox = {};
    // key commands (keys.json, herdr-app do): lcars.overview, lcars.plan, lcars.spec, lcars.terminals, lcars.coordinator, lcars.repo;
    // the tab bar is always shown
    if (part === "tabs") {
      cx.spawn(async () => {
        for (;;) {
          const c = await nextCommand();
          const pick = /^plan[:\s]+(\S+)$/.exec(String(c ?? ""));
          if (pick) pickChange(pick[1]); // lcars.plan:<change>: PLAN of a change without a worktree
          else if (c === "overview" || c === "plan" || c === "spec") showBridge(c);
          else if (c === "terminals") toTerminals();
          else if (c === "coordinator" || c === "repo") bottomCommand(c);
        }
      });
    }
  }

  poll(cx) {
    if (this.polling && Date.now() - this.polling < 60000) return; // an earlier ask is still out
    this.polling = Date.now();
    cx.spawn(async (cx) => {
      let next = null;
      try { next = await shepherdr(); } catch {}
      this.polling = 0;
      if (JSON.stringify(next) !== JSON.stringify(this.shep)) { this.shep = next; cx.notify(); }
    });
  }

  render() {
    const part = props()?.part;
    if (part === "top") return this.top();
    if (part === "side") return this.side();
    if (part === "tabs") return this.tabs();
    if (part === "bottom") return this.bottom();
    if (part === "machines") return this.machines();
    if (part === "board") return board(this.now);
    if (part === "bridge") return bridge(this.now, this.specScroll);
    if (part === "bridge-rule") return bridgeRule(this.now);
    if (part === "bridge-bottom") return bridgeBottom(this.now, this.bottomBox);
    return div().child(`lcars: unknown part ${part}`);
  }

  machines() {
    const close = () => closeOverlay(props()?.overlay);
    const all = [{ name: null, layout: "ready" }, ...machines().filter((m) => m.name)];
    const row = (m, i) => {
      const ready = m.layout === "ready";
      return slab(`new-space-${m.name ?? "local"}`, ready ? SPACE_COLORS[i % SPACE_COLORS.length] : ROLE.neutral,
        `${m.name ?? "this computer"}${ready ? "" : " · " + m.layout}`, TOUCH, (el) => el
          .when(ready, (el) => pill(el, TOUCH).cursor_pointer().hover((st) => st.opacity(0.85))
            // no machine means the focused space's for clicks; "" is this computer
            .on_click(() => { close(); run("space.new", { machine: m.name ?? "" }); })));
    };
    return v_flex().size_full().bg(ROLE.bg).rounded(14).p(6).gap(GAP)
      .child(slab("new-space-title", ROLE.frame, "new space on", 30, (el) => el.rounded_tl(12).rounded_tr(12)))
      .children(all.map(row));
  }

  top() {
    const space = spaces().find((s) => s.active);
    const elbow = div().w(SIDE).h_full().flex_none().bg(ROLE.frame).rounded_tl(44)
      .flex().items_end().justify_end().px(10).pb(4).text_color(ROLE.ink).text_size(TEXT_MIN).font_weight(700)
      .child(up(space?.machine ?? "this computer"));
    const arm = h_flex().w_full().h(ARM).flex_none().gap(GAP)
      .child(div().w(160).h_full().bg(ROLE.frame))
      .child(div().w(70).h_full().bg(C.peach))
      .child(div().flex_1().h_full().bg(C.tan))
      .child(div().w(46).h_full().bg(ROLE.frame).rounded_tr(10).rounded_br(10));
    // the concave inner corner: black with a rounded top-left corner, over the elbow's orange
    const title = div().w_full().flex_1().bg(ROLE.frame).child(
      h_flex().size_full().bg(ROLE.bg).rounded_tl(26).items_center().justify_end().gap(14).pr(4)
        .child(div().text_color(ROLE.text).text_size(TEXT_MIN).font_weight(700).child(`STARDATE ${stardate(this.now)}`))
        .child(div().text_color(ROLE.frame).text_size(30).font_weight(700).child(up(space?.name ?? "HERDR"))));
    return h_flex().id("top").size_full().bg(ROLE.bg).on_mouse_down("right", onRight(globalMenu))
      .child(elbow)
      .child(v_flex().flex_1().h_full().child(arm).child(title));
  }

  side() {
    const list = spaces();
    const crew = agents();
    setAgentOrder(crew.map((a) => a.address));
    // a space is a row of text on black with an oval for its state: orange when active, red and blinking when blocked
    const space = (s) => {
      const state = s.active ? ROLE.active : STATUS[s.status] ?? ROLE.neutral;
      return h_flex().id(`space-${s.id}`).w_full().h(TOUCH).flex_none().gap(6).items_center().pl(6).pr(4)
        .font_weight(700).cursor_pointer().hover((st) => st.bg(ROLE.track))
        .when(s.status === "blocked" && !s.active, (el) => el.loop("opacity", { from: 0.55, to: 1, period: 900 }))
        .on_click(() => { toTerminals(); run("space.select", { id: s.id }); })
        .on_mouse_down("right", onRight(() => menu("space", { id: s.id })))
        .child(div().flex_none().text_size(TEXT_MIN).text_color(ROLE.neutral).child(two(s.index)))
        .child(div().flex_1().min_w(0).text_size(TEXT_BODY).truncate()
          .text_color(s.active ? ROLE.active : s.status === "blocked" ? ROLE.alert : ROLE.text).child(up(s.name)))
        .child(div().flex_none().w(22).h(12).rounded(6).bg(state));
    };
    // a machine is a block of the sidebar in its own colour, as tall as its spaces, with a rule along their top
    const machine = (name, rows, i) => {
      const color = SPACE_COLORS[i % SPACE_COLORS.length];
      return h_flex().id(`machine-${name ?? "local"}`).w_full().flex_none().gap(GAP).items_stretch()
        // one word per line, right-aligned: "THIS COMPUTER" does not fit the 72 px block on one line at TEXT_MIN
        .child(v_flex().w(MACHINE).flex_none().min_h(TOUCH).bg(color).items_end().px(6).pt(2)
          .text_color(ROLE.ink).text_size(TEXT_MIN).font_weight(700)
          .children(up(name ?? "this computer").split(" ").map((w) => div().child(w))))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().w_full().h(2).flex_none().bg(color))
          .children(rows));
    };
    // a crew row: Striker's name and rank, then repo · state · model · tokens (crewLines; without Striker as before)
    const crewData = shared(CREW_KEY);
    const member = (a) => {
      const [name, line] = crewLines(a, crewEntry(crewData, a));
      return h_flex().id(`agent-${a.address}`).w_full().h(TOUCH).flex_none().gap(6).items_center()
        .cursor_pointer().hover((st) => st.opacity(0.85))
        .on_click(() => { toTerminals(); run("agent.focus", { terminal: a.address }); })
        .on_mouse_down("right", onRight(() => menu("pane", { pane: a.pane, terminal: a.address })))
        .child(div().w(14).h_full().bg(STATUS[a.status] ?? ROLE.neutral).rounded_l(TOUCH / 2)
          .when(a.status === "blocked", (el) => el.loop("opacity", { from: 0.4, to: 1, period: 700 })))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(TEXT_MIN).font_weight(700).text_color(a.focused ? ROLE.active : ROLE.text).truncate().child(name))
          .child(div().text_size(TEXT_MIN).text_color(STATUS[a.status] ?? ROLE.neutral).truncate().child(line)));
    };
    // spaces grouped by machine, this computer first
    const groups = new Map([[null, []]]);
    for (const s of list) {
      const key = s.machine || null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(space(s));
    }
    const byMachine = [...groups].filter(([, rows]) => rows.length).map(([name, rows], i) => machine(name, rows, i));
    // one scroll area: with TOUCH rows many spaces and agents outgrow the window
    return v_flex().id("side").size_full().bg(ROLE.bg).gap(GAP).overflow_y_scrollbar()
      .on_mouse_down("right", onRight(globalMenu))
      .child(div().w_full().h(18).flex_none().bg(ROLE.frame)) // carries the top elbow down
      .children(byMachine)
      .child(slab("space-new", ROLE.neutral, "+ new space", TOUCH, (el) => pill(el, TOUCH).cursor_pointer()
        .hover((st) => st.bg(ROLE.hover)).on_click(() => newSpace()).on_mouse_down("right", onRight(newSpace))))
      .child(section("fleet-label", "fleet"))
      .child(this.strikerSlab())
      .child(section("crew-label", "crew"))
      .child(v_flex().id("crew").w_full().flex_none().gap(2).pr(4).children(crew.map(member)))
      .child(div().w_full().flex_1().min_h(10).bg(ROLE.neutral)); // runs into the bottom elbow
  }

  // Striker's board button: orange while the board shows, red and pulsing while a repo needs the person,
  // else gold; the left side counts what waits. A click switches between the board and the terminals.
  strikerSlab() {
    const n = fleetCounts();
    const on = shared(VIEW_KEY) === "board";
    const need = n?.need ?? 0;
    const color = on ? ROLE.active : need ? ROLE.alert : ROLE.done;
    return pill(h_flex(), TOUCH).id("striker-slab").w_full().h(TOUCH).flex_none().bg(color).items_end().justify_between().pl(10).pb(2)
      .text_color(ROLE.ink).font_weight(700).cursor_pointer().hover((st) => st.opacity(0.85))
      .when(need > 0 && !on, (el) => el.loop("opacity", { from: 0.55, to: 1, period: 900 }))
      .on_click(() => toBoard(!on))
      .child(div().text_size(TEXT_MIN).child(n ? (need ? `${two(need)} NEED YOU` : `${two(n.repos)} REPOS`) : "SCANNING"))
      .child(div().text_size(TEXT_BODY).child(on ? "TERMINALS" : "STRIKER"));
  }

  // the tab bar: the Bridge's pseudo-tabs OVERVIEW, PLAN and SPEC first (the shown one orange, else peach), then the
  // space's tabs. No index numbers. While the Bridge shows, no real tab is marked active.
  tabs() {
    const space = spaces().find((s) => s.active);
    const view = shared(BRIDGE_KEY);
    // every tab is a TOUCH-high pill (the layout's tabs block is as high), TOUCH wide at least
    const pseudo = (mode, word) => h_flex().id(`tab-bridge-${mode}`).h(TOUCH).min_w(TOUCH).flex_none().px(18).rounded(TOUCH / 2)
      .bg(view === mode ? ROLE.frame : C.peach).items_center().justify_center()
      .text_color(ROLE.ink).text_size(TEXT_BODY).font_weight(700).cursor_pointer()
      .hover((st) => st.opacity(0.85))
      .on_click(() => showBridge(mode))
      .child(word);
    const pill = (t) => {
      const color = t.active && !view ? ROLE.active : STATUS[t.status] ?? C.tan;
      return h_flex().id(`tab-${t.id}`).h(TOUCH).min_w(TOUCH).flex_none().px(18).rounded(TOUCH / 2).bg(color).items_center()
        .justify_center().text_color(ROLE.ink).text_size(TEXT_BODY).font_weight(700).cursor_pointer()
        .hover((st) => st.opacity(0.85))
        .when(t.status === "blocked" && !t.active, (el) => el.loop("opacity", { from: 0.5, to: 1, period: 800 }))
        .on_click(() => { toTerminals(); run("tab.select", { id: t.id }); })
        .on_mouse_down("right", onRight(() => menu("tab", { id: t.id, space: space.id })))
        .child(up(t.name));
    };
    return h_flex().id("tab-bar").size_full().gap(GAP + 2).items_center().overflow_x_scrollbar()
      .on_mouse_down("right", onRight(globalMenu))
      .child(pseudo("overview", "OVERVIEW"))
      .child(pseudo("plan", "PLAN"))
      .child(pseudo("spec", "SPEC"))
      .children((space?.tabs ?? []).filter((t) => !t.settled).map(pill))
      .child(h_flex().id("tab-new").h(TOUCH).min_w(TOUCH).flex_none().px(14).rounded(TOUCH / 2).bg(ROLE.neutral).items_center()
        .justify_center()
        .text_color(ROLE.ink).text_size(22).font_weight(700).cursor_pointer().hover((st) => st.bg(ROLE.hover))
        .on_click(() => newMenu()).on_mouse_down("right", onRight(newMenu)).child("+"));
  }

  bottom() {
    const crew = agents();
    const count = (s) => crew.filter((a) => a.status === s).length;
    const away = machines().filter((m) => m.name).length;
    const elbow = div().id("menu").w(SIDE).h_full().flex_none().bg(ROLE.neutral).rounded_bl(40)
      .flex().items_start().justify_end().pr(10).text_color(ROLE.ink).text_size(TEXT_MIN).font_weight(700)
      .cursor_pointer().hover((st) => st.bg(ROLE.hover)).on_click(() => menu("global", {}))
      .child(h_flex().h(TOUCH).gap(2).items_center()
        // the gear opens Herdr's settings, in a TOUCH box; stopping its press keeps the elbow's MENU from opening too
        .child(div().id("settings").size(TOUCH).flex().items_center().justify_center().cursor_pointer()
          .hover((st) => st.opacity(0.6))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .on_click(() => run("app.settings"))
          .child(svg("mods/lcars/gear.svg").size(18).text_color(ROLE.ink)))
        .child("MENU"));
    // a clickable cell of the status row: as high as the row (TOUCH), at least TOUCH wide
    const cell = (id, color, text, click) => h_flex().id(id).h_full().min_w(TOUCH).px(10).items_center().justify_center()
      .text_color(color).cursor_pointer().hover((st) => st.opacity(0.7)).on_click(click).child(text);
    const status = div().w_full().flex_1().bg(ROLE.neutral).child(
      h_flex().size_full().bg(ROLE.bg).rounded_bl(22).items_center().gap(18).pl(18).text_size(TEXT_MIN).font_weight(700)
        .child(div().text_color(count("working") ? ROLE.working : ROLE.neutral).child(`${two(count("working"))} WORKING`))
        .child(div().text_color(count("blocked") ? ROLE.alert : ROLE.neutral).child(`${two(count("blocked"))} NEED YOU`))
        .child(div().text_color(count("done") ? ROLE.done : ROLE.neutral).child(`${two(count("done"))} DONE`))
        .child(div().text_color(C.peach).child(`${two(away + 1)} MACHINES`))
        // Striker: repos whose lead needs the person; click opens the board
        .when(!!fleetCounts(), (el) => el.child(cell("striker-status", fleetCounts().need ? ROLE.alert : ROLE.neutral,
          `${two(fleetCounts().need)} STRIKER`, () => toBoard(true))))
        // Shepherdr: what waits on the human (needs an answer, or is ready to merge); click opens it. Quiet when it is not running
        .when(!!this.shep, (el) => el.child(cell("shepherdr-status",
          this.shep.need ? ROLE.alert : this.shep.ready ? ROLE.done : ROLE.neutral,
          `${two(this.shep.need + this.shep.ready)} SHEPHERDR`, () => openUrl(this.shep.url))))
        .child(div().flex_1())
        .child(cell("palette", ROLE.text, `${window()?.platform === "macos" ? "⌘" : "CTRL"} SHIFT P`,
          () => run("app.palette"))));
    const arm = h_flex().w_full().h(16).flex_none().gap(GAP)
      .child(div().w(120).h_full().bg(ROLE.neutral))
      .child(div().flex_1().h_full().bg(C.tan))
      .child(div().w(90).h_full().bg(C.peach))
      .child(div().w(46).h_full().bg(ROLE.frame).rounded_tr(8).rounded_br(8));
    return h_flex().id("bottom").size_full().bg(ROLE.bg).on_mouse_down("right", onRight(globalMenu))
      .child(elbow)
      .child(v_flex().flex_1().h_full().child(status).child(arm));
  }
}

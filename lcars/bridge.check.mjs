// Checks the Bridge's block diff (lcars/blocks.js) the REPO tree's geometry (lcars/tree.js), terminal addresses (lcars/addr.js),
// a space's repo (lcars/space.js) and the OVERVIEW's pure parts (lcars/overview.js). Run: node lcars/bridge.check.mjs → prints "ok".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitBlocks, diffBlocks } from "./blocks.js";
import { treeLayout, columnXs, laneColor, laneState, labelWidth, fitLabel, progressText, TOP, LANE, FUTURE, LABEL_H,
  LABEL_MAX, LABEL_MIN, LABEL_CHAR, LABEL_GAP, LABEL_TEXT, NOW_H, MAX_STEP, FUTURE_STEP } from "./tree.js";
import { overviewRows, coordCard, changeColor, changeStatus, changeLive, planCard, READY_TEXT, interruptedText, nowTask, afterText,
  briefingLine, itemLabel, registerSummary, isMainCheckout, defaultMode, changeSpace, repoName, docHeadings, tocText, newestFirst,
  doneSummary, defaultOpen, tocLine, barColors, firstMode, commitsLine, specList } from "./overview.js";
import { boardCoords, asker, headLine, prLinks, prRows } from "./board.js";
import { terminalState, parseAddress, cardBottom, ruleColor } from "./addr.js";
import { repoPathFor, spaceTerminals, repoNotice, crewLabel, crewLines, crewEntry, shortTokens, strikerSelf, strikerLaunch, strikerTerminal } from "./space.js";
import { ROLE, TEXT_MIN, TEXT_BODY, TOUCH } from "./palette.js";
import { withPromptTerminal, promptBlock } from "./prompt.js";
import { crossing } from "./tree.js";
import { stardate } from "./stardate.js";

const kinds = (d) => d.map((b) => `${b.kind}:${b.md.split("\n")[0]}`);

// a hunk replacing one paragraph: removed then added; the untouched heading stays same
{
  const base = "# Title\n\nFirst para.\n\n## Data\n\nOld para\nsecond line.\n\nLast para.\n";
  const text = "# Title\n\nFirst para.\n\n## Data\n\nNew para\nsecond line.\n\nLast para.\n";
  const hunks = [{ old_start: 7, old_lines: 1, new_start: 7, new_lines: 1, removed: ["Old para"], added: ["New para"] }];
  assert.deepEqual(kinds(diffBlocks(base, text, hunks)), [
    "same:# Title", "same:First para.", "same:## Data", "removed:Old para", "added:New para", "same:Last para.",
  ]);
}

// CRLF text splits like LF, and no \r is left in a block
{
  const lf = "# A\n\npara one\nstill one\n\n- item\n- item two\n\n```js\nx\n\ny\n```\n\n## B\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(splitBlocks(crlf), splitBlocks(lf));
  assert.deepEqual(splitBlocks(lf), ["# A", "para one\nstill one", "- item\n- item two", "```js\nx\n\ny\n```", "## B"]);
  const d = diffBlocks(crlf, crlf.replace("para one", "para 1"), [{ old_start: 3, old_lines: 1, new_start: 3, new_lines: 1 }]);
  assert.ok(d.every((b) => !b.md.includes("\r")));
  assert.deepEqual(kinds(d), ["same:# A", "removed:para one", "added:para 1", "same:- item", "same:```js", "same:## B"]);
}

// a heading directly followed by a paragraph is two blocks; a paragraph followed by a list is two blocks
assert.deepEqual(splitBlocks("## H\ntext\n- a\n- b"), ["## H", "text", "- a\n- b"]);

// a pure deletion (new_lines 0): one removed block, nothing added
{
  const base = "## H\n\nkeep\n\ngone\n\nend\n";
  const text = "## H\n\nkeep\n\nend\n";
  const d = diffBlocks(base, text, [{ old_start: 4, old_lines: 2, new_start: 3, new_lines: 0 }]);
  assert.deepEqual(kinds(d), ["same:## H", "same:keep", "removed:gone", "same:end"]);
}

// a pure insertion (old_lines 0) of a new paragraph: added, nothing removed
{
  const base = "## H\n\nkeep\n";
  const text = "## H\n\nkeep\n\nnew one\n";
  const d = diffBlocks(base, text, [{ old_start: 3, old_lines: 0, new_start: 4, new_lines: 2 }]);
  assert.deepEqual(kinds(d), ["same:## H", "same:keep", "added:new one"]);
}

// a hunk touching only blank lines: no crash, every block same
{
  const base = "a\n\n\nb\n";
  const text = "a\n\nb\n";
  const d = diffBlocks(base, text, [{ old_start: 3, old_lines: 1, new_start: 2, new_lines: 0 }]);
  assert.deepEqual(kinds(d), ["same:a", "same:b"]);
}

// no hunks: everything same; a missing base (new file) with no hunks too
assert.deepEqual(kinds(diffBlocks("x\n\ny", "x\n\ny", [])), ["same:x", "same:y"]);
assert.deepEqual(kinds(diffBlocks(undefined, "x", undefined)), ["same:x"]);

// --- the REPO tree's geometry (tree.js) ---
{
  const graph = {
    cols: 7, now: 2,
    lanes: [{ index: 0, plan: "", label: "main", blocked_by: [] }, { index: 1, plan: "a", label: "A", blocked_by: [] },
      { index: 2, plan: "b", label: "B", blocked_by: ["a"] }, { index: 3, plan: "c", label: "C", blocked_by: [] }],
    nodes: [
      { id: "c0", col: 0, lane: 0, kind: "commit", future: false }, { id: "c1", col: 1, lane: 0, kind: "commit", future: false },
      { id: "c2", col: 2, lane: 0, kind: "commit", future: false },
      // c: two done tasks with no edge between them (dependency-less neighbours)
      { id: "tc1", col: 1, lane: 3, kind: "task", plan: "c", state: "done", future: false },
      { id: "tc2", col: 2, lane: 3, kind: "task", plan: "c", state: "done", future: false },
      { id: "ta1", col: 3, lane: 1, kind: "task", plan: "a", state: "todo", future: true },
      { id: "ta2", col: 4, lane: 1, kind: "task", plan: "a", state: "todo", future: true },
      { id: "ma", col: 5, lane: 0, kind: "merge", plan: "a", future: true },
      { id: "tb1", col: 6, lane: 2, kind: "task", plan: "b", state: "todo", future: true },
    ],
    edges: [{ from: "c2", to: "ta1", future: true }, { from: "ta1", to: "ta2", future: true }, { from: "ta2", to: "ma", future: true },
      { from: "ma", to: "tb1", future: true }],
  };
  const plans = [{ topic: "a", state: "active" }, { topic: "b", state: "blocked" }, { topic: "c", state: "merged" }];
  const t = treeLayout(graph, { width: 400, height: 104, plans, topic: "a" });
  const solid = t.strokes.filter((s) => !s.dash);
  // nothing solid right of NOW
  for (const s of solid) for (const [x] of s.segs.flatMap((g) => g.pts)) assert.ok(x <= t.nowX + 0.001, `solid at ${x} > ${t.nowX}`);
  // the done strand of c runs on between its tasks, solid, in done gold
  const cY = TOP + 3 * LANE;
  assert.ok(solid.some((s) => s.color === ROLE.done && s.segs.some((g) => g.pts.every(([, y]) => y === cY))));
  // a's lane is blue and dashed (future), b's gray
  assert.ok(t.strokes.some((s) => s.color === ROLE.working && s.dash && s.alpha === FUTURE));
  assert.ok(t.strokes.some((s) => s.color === ROLE.neutral && s.dash));
  // the trunk: solid then dashed
  assert.ok(t.strokes.some((s) => s.color === ROLE.frame && s.width === 3 && !s.dash));
  assert.ok(t.strokes.some((s) => s.color === ROLE.frame && s.width === 3 && s.dash));
  // labels
  const texts = t.labels.map((l) => l.text);
  assert.ok(texts.includes("A · THIS PLAN"), texts.join("|"));
  assert.ok(texts.includes("B · AFTER A"), texts.join("|"));
  // marks: done filled, todo dashed ring
  assert.ok(t.marks.some((m) => m.fill === ROLE.done));
  assert.ok(t.marks.some((m) => m.ring === ROLE.neutral && m.dash));
  // an empty graph does not throw
  assert.equal(treeLayout({}, { width: 100, height: 100 }).marks.length, 0);
  // MAIN left of the trunk; a change's label on its lane, right-aligned, ending before the fork and its first node
  assert.deepEqual([t.labels[0].text, t.labels[0].x, t.labels[0].w], ["MAIN", 0, t.labelW]);
  const forkOf = { 1: "c2", 2: "ma" }; // a's entry from the trunk head, b's from a's merge
  for (const l of t.labels.slice(1)) {
    const lane = (l.y + LABEL_H / 2 - TOP) / LANE;
    assert.ok(Number.isInteger(lane), `label ${l.text} not centred on a lane`);
    assert.equal(l.align, "right");
    const first = Math.min(...graph.nodes.filter((n) => n.lane === lane).map((n) => t.xs[n.col]));
    const fork = forkOf[lane] ? t.xs[graph.nodes.find((n) => n.id === forkOf[lane]).col] : Infinity;
    assert.ok(Math.abs(l.x + l.w - (Math.min(first, fork) - LABEL_GAP)) < 0.001, `label ${l.text} ends at ${l.x + l.w}`);
    assert.ok(l.x >= 0 && l.text.length * LABEL_CHAR <= l.w + 0.001, `label ${l.text} does not fit its box`);
  }
  for (const s of t.strokes) for (const [x] of s.segs.flatMap((g) => g.pts)) assert.ok(x >= t.x0 - 0.001, `stroke at ${x} < ${t.x0}`);
  for (const m of t.marks) assert.ok(m.x - m.r >= t.x0, `mark at ${m.x} left of the trunk start`);
  // a sub-lane (parallel tasks, label "") gets no label of its own; progress from the plan's tasks
  const g2 = { ...graph, lanes: [...graph.lanes, { index: 4, plan: "a", label: "", blocked_by: [] }],
    nodes: [...graph.nodes, { id: "ta3", col: 4, lane: 4, kind: "task", plan: "a", state: "todo", future: true }],
    edges: [...graph.edges, { from: "ta1", to: "ta3", future: true }] };
  const plans2 = [{ topic: "a", state: "active", tasks: [{ state: "done" }, { state: "todo" }, { state: "todo" }] }, ...plans.slice(1)];
  const t2 = treeLayout(g2, { width: 400, height: 200, plans: plans2, topic: "a" });
  const t2a = t2.labels.filter((l) => l.text.startsWith("A"));
  assert.deepEqual(t2a.map((l) => l.text), ["A 1/3 · THIS PLAN"]);
  assert.equal(t2a[0].y, TOP + LANE - LABEL_H / 2);
}

// the label column: as wide as the longest label, between LABEL_MIN and LABEL_MAX; long names are cut, the suffix first
{
  assert.equal(labelWidth(["MAIN"]), LABEL_MIN);
  assert.equal(labelWidth(["MAIN", "STRIKER-GO-BUNDLE"]), 17 * LABEL_CHAR);
  assert.equal(labelWidth(["MAIN", "X".repeat(80)]), LABEL_MAX);
  assert.equal(fitLabel("REPO-OVERVIEW", "THIS PLAN", 25), "REPO-OVERVIEW · THIS PLAN");
  assert.equal(fitLabel("STRIKER-GO-BUNDLE", "AFTER REPO-OVERVIEW", 25), "STRIKER-GO-BUNDLE");
  assert.equal(fitLabel("A-VERY-LONG-CHANGE-NAME-INDEED", "", 10), "A-VERY-LO…");
  // progress stays with the name before the suffix does; the name alone before it is cut
  assert.equal(fitLabel("LCARS-TOUCH-ROLLOUT", "THIS PLAN", 40, "5/7"), "LCARS-TOUCH-ROLLOUT 5/7 · THIS PLAN");
  assert.equal(fitLabel("LCARS-TOUCH-ROLLOUT", "THIS PLAN", 25, "5/7"), "LCARS-TOUCH-ROLLOUT 5/7");
  assert.equal(fitLabel("LCARS-TOUCH-ROLLOUT", "THIS PLAN", 20, "5/7"), "LCARS-TOUCH-ROLLOUT");
  assert.equal(progressText({ tasks: [{ state: "done" }, { state: "todo" }] }), "1/2");
  assert.equal(progressText({ tasks: [] }), "");
  assert.equal(progressText(undefined), "");
  assert.equal(LABEL_TEXT >= TEXT_MIN, true);
  // labels never overlap, at any lane count: one per lane, LABEL_H ≤ LANE, each inside its own box
  for (const n of [1, 2, 5, 8, 12]) {
    const lanes = [{ index: 0, plan: "" }, ...Array.from({ length: n }, (_, i) => ({ index: i + 1,
      plan: i % 3 ? `c${i}` : `a-rather-long-change-name-${i}`, label: "x", blocked_by: i % 2 ? ["other-change"] : [] }))];
    const nodes = lanes.slice(1).map((l) => ({ id: `n${l.index}`, col: 1, lane: l.index, kind: "task", plan: l.plan, state: "todo", future: true }));
    const t = treeLayout({ cols: 3, now: 0, lanes, nodes, edges: [] }, { width: 600, height: 400, topic: "c1" });
    assert.equal(t.labelW, LABEL_MIN);
    assert.equal(t.x0, t.labelW + LABEL_GAP);
    assert.equal(t.labels.length, n + 1);
    const boxes = t.labels.map((l) => [l.y, l.y + LABEL_H]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], `labels overlap at ${n} lanes`);
    for (const l of t.labels) assert.ok(l.text.length * LABEL_CHAR <= l.w + 0.001, `label ${l.text} wider than its box`);
    assert.ok(t.xs.every((x) => x >= t.x0));
  }
  // the NOW tag above the trunk, clear of it
  assert.ok(NOW_H < TOP - 5);
}

// 30 trunk commits and one plan of 8 open tasks after NOW: the gap after NOW keeps room for the tag, the other future
// gaps are at most FUTURE_STEP; commits show as ticks
{
  const nodes = [];
  const edges = [];
  for (let c = 0; c < 30; c++) nodes.push({ id: `c${c}`, col: c, lane: 0, kind: "commit", future: false });
  for (let i = 0; i < 8; i++) nodes.push({ id: `t${i}`, col: 30 + i, lane: 1, kind: "task", plan: "p", state: "todo", future: true });
  nodes.push({ id: "m", col: 38, lane: 0, kind: "merge", plan: "p", future: true });
  const graph = { cols: 39, now: 29, lanes: [{ index: 0, plan: "" }, { index: 1, plan: "p", blocked_by: [] }], nodes, edges };
  const width = 1000;
  const t = treeLayout(graph, { width, height: 104, plans: [{ topic: "p", state: "active" }], topic: "p" });
  assert.ok(t.xs[30] - t.xs[29] >= 44, `gap after NOW ${t.xs[30] - t.xs[29]}`);
  for (let c = 31; c <= 38; c++) assert.ok(t.xs[c] - t.xs[c - 1] <= FUTURE_STEP + 0.001, `future gap into ${c}`);
  // past plan columns keep up to MAX_STEP: 3 past plan columns and 10 future ones in a wide box
  const mixed = columnXs(14, Array.from({ length: 13 }, (_, c) => ({ col: c + 1, lane: 1, kind: "task" })), 2000, 3);
  assert.equal(mixed[2] - mixed[1], MAX_STEP);
  for (let c = 5; c < 14; c++) assert.equal(mixed[c] - mixed[c - 1], FUTURE_STEP);
  // NOW stays between its column and the next
  assert.ok(t.nowX > t.xs[29] && t.nowX < t.xs[30]);
  // the trunk commits are drawn as ticks (short frame strokes across the trunk)
  const ticks = t.strokes.filter((s) => s.color === ROLE.frame && s.width === 1.5).flatMap((s) => s.segs);
  assert.equal(ticks.length, 30);
  // the whole drawing fits the width
  assert.ok(t.xs[38] <= width);
  // many plan columns in a narrow box: every gap shrinks, still in order and inside
  const xs = columnXs(80, Array.from({ length: 80 }, (_, c) => ({ col: c, lane: 1, kind: "task" })), 300);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]) && xs[79] <= 300);
}

// lanes below the field are counted, not drawn
{
  const lanes = Array.from({ length: 8 }, (_, i) => ({ index: i, plan: i ? `p${i}` : "", blocked_by: [] }));
  const nodes = lanes.slice(1).map((l) => ({ id: `n${l.index}`, col: 1, lane: l.index, kind: "task", plan: l.plan, state: "todo", future: true }));
  const t = treeLayout({ cols: 2, now: 0, lanes, nodes, edges: [] }, { width: 300, height: 104 });
  // a lane fits while its label does: TOP + i·LANE + LABEL_H/2 ≤ 104 → 30 + 20i + 9 ≤ 104 → lanes 1..3; 4..7 do not
  assert.equal(TOP + 3 * LANE + LABEL_H / 2 <= 104 && TOP + 4 * LANE + LABEL_H / 2 > 104, true);
  assert.equal(t.hidden, 4);
}

// --- terminal addresses (addr.js) ---
{
  const list = [{ address: "t5", state: "live" }, { address: "remote1/t7", state: "live" }, { address: "t9", state: "finished" }];
  assert.equal(terminalState("t5", list), "live");
  assert.equal(terminalState("t7", list, "remote1"), "live"); // Striker's bare address for a remote space
  assert.equal(terminalState("remote1/t7", list), "live");
  assert.equal(terminalState("t9", list), "gone"); // listed as finished
  assert.equal(terminalState("t6", list), "gone"); // this computer listed, t6 not among them
  assert.equal(terminalState("beta/t3", list), "unknown"); // nothing of beta listed: not known gone
  assert.equal(terminalState("t5", []), "unknown");
  assert.equal(terminalState("t5", list, "local"), "live");
  assert.deepEqual(parseAddress("remote1/t7"), { machine: "remote1", id: "t7" });
}

// --- cards open the agent's terminal (addr.js): WORKING and NEEDS YOU, with an agent ---
{
  const agent = { address: "t5" };
  assert.deepEqual(cardBottom("working", agent, "#7 · IMPL · LIVE"), { kind: "terminal", address: "t5", label: "#7 · IMPL · LIVE", alert: false });
  assert.deepEqual(cardBottom("needs_you", agent, "#7 · IMPL · LIVE"), { kind: "terminal", address: "t5", label: "#7 · IMPL · LIVE", alert: true });
  assert.equal(cardBottom("needs_you", undefined, "x"), null);
  assert.equal(cardBottom("done", agent, "x"), null);
  assert.equal(cardBottom("todo", agent, "x"), null);
  // the rule's colour: NEEDS YOU alert, coordinator frame, other terminals working, the tree section
  assert.equal(ruleColor({ kind: "terminal", label: "#7 · IMPL · LIVE", alert: true }), ROLE.alert);
  assert.equal(ruleColor({ kind: "terminal", label: "COORDINATOR · X" }), ROLE.frame);
  assert.equal(ruleColor({ kind: "terminal", label: "#7 · IMPL · LIVE" }), ROLE.working);
  assert.equal(ruleColor({ kind: "repo" }), ROLE.section);
  assert.equal(ruleColor(null), ROLE.section);
}

// --- a space's repo (space.js) ---
{
  const fleet = [
    { name: "alpha", machine: "remote1", path: "/srv/alpha", space: "alpha-space", space_path: "/srv/alpha", coordinators: [] },
    { name: "herdr-mods", machine: null, path: "/Users/p/herdr-mods", space: "herdr-mods", space_path: "/Users/p/herdr-mods",
      coordinators: [{ change: "repo-overview", address: "t4", state: "working", status: {} }] },
  ];
  // a remote space whose terminal sits in the home folder (sudo -i): the fleet entry named like the space wins
  const coex = { id: "remote1/s1", name: "alpha-space", machine: "remote1", folder: "/home/you" };
  assert.deepEqual(repoPathFor(coex, fleet, [], [{ address: "remote1/t2", cwd: "/home/you", labels: {} }]),
    { path: "/srv/alpha", machine: "remote1" });
  // no fleet match, a local lead in the space: its cwd
  const mine = { id: "s2", name: "scratch", machine: null, folder: "/Users/p" };
  assert.deepEqual(repoPathFor(mine, fleet, [{ address: "t7", cwd: "/Users/p/beta", labels: { "striker.lead": "beta" } }], []),
    { path: "/Users/p/beta", machine: null });
  // neither: the space's folder (Review Focus 5)
  assert.deepEqual(repoPathFor(mine, fleet, [], []), { path: "/Users/p", machine: null });
  // Ruling 16: no fleet match, no lead: a local space's first terminal's live cwd, before the folder it was made in
  const madeElsewhere = { id: "s6", name: "work", machine: null, folder: "/home/you/gamma" };
  assert.deepEqual(repoPathFor(madeElsewhere, fleet, [], [{ address: "t2", cwd: null, labels: {} }, { address: "t3", cwd: "/Users/p/herdr-mods", labels: {} }]),
    { path: "/Users/p/herdr-mods", machine: null });
  // a remote space's terminal cwd is home behind sudo -i: skipped, the folder stays
  const remote = { id: "remote1/s7", name: "elsewhere", machine: "remote1", folder: "/srv/x" };
  assert.deepEqual(repoPathFor(remote, fleet, [], [{ address: "remote1/t5", cwd: "/root", labels: {} }]), { path: "/srv/x", machine: "remote1" });
  // no folder either: nothing
  assert.equal(repoPathFor({ id: "s3", name: "x", machine: null, folder: "" }, fleet, [], []), null);
  // Ruling 11: a coordinator's terminal (striker.repo + striker.coordinator) maps its space to the worktree, before a local lead
  const coordSpace = { id: "s4", name: "herdr-mods-repo-overview", machine: null, folder: "/Users/p/herdr-mods-repo-overview" };
  const coordTerms = [
    { address: "t9", cwd: "/Users/p", labels: { "striker.lead": "other" } },
    { address: "t4", cwd: "/Users/p/herdr-mods-repo-overview/lcars", labels: { "striker.repo": "herdr-mods", "striker.coordinator": "repo-overview" } },
  ];
  assert.deepEqual(repoPathFor(coordSpace, fleet, [coordTerms[0]], coordTerms),
    { path: "/Users/p/herdr-mods-repo-overview", machine: null });
  // a remote coordinator behind sudo -i (cwd home): still its space's folder, on the coordinator's machine
  const remoteCoord = { id: "remote1/s5", name: "alpha-omega", machine: "remote1", folder: "/srv/alpha-omega" };
  const fleet2 = [{ ...fleet[0], coordinators: [{ change: "omega", address: "remote1/t3", state: "idle", status: {} }] }];
  assert.deepEqual(repoPathFor(remoteCoord, fleet2, [], [{ address: "remote1/t3", cwd: "/root", labels: { "striker.repo": "alpha", "striker.coordinator": "omega" } }]),
    { path: "/srv/alpha-omega", machine: "remote1" });
  // the space's terminals with their labels: panes of its tabs, matched to terminals() across address forms
  const space = { id: "remote1/s1", machine: "remote1", tabs: [{ id: "remote1/tab1" }] };
  const panes = [{ pane: "p1", tab: "remote1/tab1", terminal: "remote1/t2", cwd: "/home/you" },
    { pane: "p2", tab: "remote1/tab9", terminal: "remote1/t5", cwd: "/x" }, { pane: "p3", tab: "remote1/tab1", terminal: null }];
  const terms = [{ address: "remote1/t2", labels: { "striker.lead": "alpha" } }, { address: "remote1/t5", labels: {} }];
  assert.deepEqual(spaceTerminals(space, panes, terms), [{ address: "remote1/t2", cwd: "/home/you", labels: { "striker.lead": "alpha" } }]);
  // labels as "k=v" strings are read too; a terminal not in terminals() has no labels
  assert.deepEqual(spaceTerminals({ id: "s2", machine: null, tabs: [{ id: "tab2" }] },
    [{ pane: "p", tab: "tab2", terminal: "t7", cwd: "/a" }, { pane: "q", tab: "tab2", terminal: "t8", cwd: "/b" }],
    [{ address: "t7", labels: ["striker.lead=beta"] }]),
  [{ address: "t7", cwd: "/a", labels: { "striker.lead": "beta" } }, { address: "t8", cwd: "/b", labels: {} }]);
  // Review Focus 5: a folder that is not a repo says so; other errors stay errors
  assert.equal(repoNotice("/Users/p is not a git worktree"), "NO REPO FOR THIS SPACE");
  assert.equal(repoNotice("STRIKER SERVE NOT RUNNING"), "REPO UNREADABLE: STRIKER SERVE NOT RUNNING");
  assert.equal(repoNotice(null), "REPO UNREADABLE: NO ANSWER");
  // crew entries: <SPACE> · <STATE WORD>
  assert.equal(crewLabel({ status: "working" }, "alpha-space"), "ALPHA-SPACE · WORKING");
  assert.equal(crewLabel({ status: "blocked" }, "beta"), "BETA · NEEDS YOU");
  assert.equal(crewLabel({ status: "odd" }, "x"), "X · ODD");
  // crew rows from Striker's /crew: <RANK> <NAME>, then <REPO> · <STATE> · <MODEL> · <TOKENS>
  const a = { address: "remote1/t18", status: "working", app: "claude-code", tab_name: "claude", space_name: "alpha-space" };
  const entry = { address: "remote1/t18", name: "PATA", rank: "LCDR", repo: "alpha", model: "Opus 5.5", tokens: 1234567 };
  assert.deepEqual(crewLines(a, entry), ["LCDR PATA", "ALPHA · WORKING · OPUS 5.5 · 1.2M"]);
  assert.deepEqual(crewLines(a, { ...entry, model: "", tokens: 0 }), ["LCDR PATA", "ALPHA · WORKING"]);
  assert.deepEqual(crewLines(a, { ...entry, repo: "", tokens: 812345 }), ["LCDR PATA", "ALPHA-SPACE · WORKING · OPUS 5.5 · 812K"]);
  // no entry: today's two lines
  assert.deepEqual(crewLines(a, null), ["CLAUDE-CODE · CLAUDE", "ALPHA-SPACE · WORKING"]);
  assert.deepEqual(crewLines({ ...a, program: { name: "Claude Code" } }, undefined), ["CLAUDE CODE · CLAUDE", "ALPHA-SPACE · WORKING"]);
  assert.deepEqual([shortTokens(999), shortTokens(1000), shortTokens(812345), shortTokens(1000000), shortTokens(25000000)],
    ["999", "1K", "812K", "1.0M", "25M"]);
  // /crew entries found by address across forms (a bare address on its machine, "local")
  const crew = { agents: [entry, { address: "t3", name: "MARYNA" }] };
  assert.equal(crewEntry(crew, { address: "t18", machine: "remote1" })?.name, "PATA");
  assert.equal(crewEntry(crew, { address: "remote1/t18" })?.name, "PATA");
  assert.equal(crewEntry(crew, { address: "local/t3" })?.name, "MARYNA");
  assert.equal(crewEntry(crew, { address: "t9" }), null);
  assert.equal(crewEntry(null, { address: "t3" }), null);
}

// --- edges between lanes (tree.js crossing) ---
{
  const X = (c) => c * 10, Y = (l) => l * 100;
  // one column: one curve
  assert.deepEqual(crossing({ col: 1, lane: 2 }, { col: 2, lane: 0 }, X, Y), [{ kind: "curve", pts: [[10, 200], [20, 0]] }]);
  // a merge over three columns: along its lane, then the bend in the last gap
  assert.deepEqual(crossing({ col: 29, lane: 2 }, { col: 32, lane: 0 }, X, Y),
    [{ kind: "line", pts: [[290, 200], [310, 200]] }, { kind: "curve", pts: [[310, 200], [320, 0]] }]);
  // a fork over three columns: the bend in the first gap, then along the new lane
  assert.deepEqual(crossing({ col: 3, lane: 0 }, { col: 6, lane: 1 }, X, Y),
    [{ kind: "curve", pts: [[30, 0], [40, 100]] }, { kind: "line", pts: [[40, 100], [60, 100]] }]);
}

// --- Striker's prompt block (prompt.js) ---
{
  const tree = { type: "row", children: [{ id: "side", type: "block", content: { mod: "lcars" } },
    { id: "work-view", type: "stack", children: [{ type: "column", children: [
      { id: "board", type: "block", content: { mod: "lcars", props: { part: "board" } } },
      { id: "striker-prompt", type: "block", content: { terminal: "t12" }, size: { weight: 2 } }] }] }] };
  const before = JSON.stringify(tree);
  const next = withPromptTerminal(tree, "t14");
  const prompt = next.children[1].children[0].children[1];
  assert.deepEqual(prompt, { id: "striker-prompt", type: "block", content: { terminal: "t14" }, size: { weight: 2 } });
  assert.equal(JSON.stringify(tree), before); // the given tree is left alone
  assert.deepEqual(next.children[0], tree.children[0]);
  assert.equal(withPromptTerminal(next, "t14"), null); // already right: nothing to set
  assert.equal(withPromptTerminal({ type: "row", children: [] }, "t14"), null); // no prompt block, no board
  // Herdr dropped the block (its terminal ended): it comes back as the board column's last child
  const dropped = { type: "row", children: [{ id: "striker-board", type: "column", gap: 8, children: [
    { id: "striker-board-view", type: "block", content: { mod: "lcars", props: { part: "board" } } }] }] };
  const back = withPromptTerminal(dropped, "t16");
  assert.equal(back.children[0].children.length, 2);
  assert.deepEqual(back.children[0].children[1], promptBlock("t16"));
  // the block put back is the one in layouts/lcars.json, tall enough for Claude's prompt (300 px)
  const file = JSON.parse(readFileSync(new URL("../layouts/lcars.json", import.meta.url), "utf8"));
  const find = (n) => !n || typeof n !== "object" ? null : n.id === "striker-prompt" ? n
    : Object.values(n).reduce((hit, v) => hit ?? find(v), null);
  const inFile = find(file);
  assert.deepEqual({ ...inFile, content: null }, { ...promptBlock("x"), content: null });
  assert.deepEqual(promptBlock("x").size, { px: 300 });
  assert.equal(back.children[0].gap, 8);
  assert.equal(dropped.children[0].children.length, 1);
  assert.equal(withPromptTerminal(back, "t16"), null);
  assert.equal(withPromptTerminal(tree, ""), null);
  assert.equal(withPromptTerminal(null, "t14"), null);
}

// --- the OVERVIEW (overview.js) ---
{
  const ov = {
    briefing: { address: "t3", state: "idle", task: "Omega Aufgabe 5", phase: "betrieb", progress: { done: 4, total: 6 },
      note: "", updated: "2026-11-22T08:00:00Z", commits: [] },
    context: { file: "README.md", title: "herdr-mods", lead: "My mods." },
    inventory: {
      capabilities: [{ path: "openspec/specs/retro", requirements: 3 }],
      changes: [
        { name: "repo-overview", state: "in progress", done: 6, total: 7, worktree: null, agent: null, interrupted_at: "7", depends_on: ["lcars-bridge"], branch: "repo-overview" },
        { name: "rohdaten", state: "blocked", done: 0, total: 5, worktree: null, agent: null, interrupted_at: "", depends_on: ["repo-overview"], branch: "rohdaten" },
      ],
      archived: [{ name: "lcars-bridge", date: "2026-11-21" }],
      legacy: [],
    },
    // a coordinator item belongs to its change row; a lead item has no id; a register item may carry a kind
    open_items: [{ source: "lead", title: "Decide A", kind: "entscheidung" }, { source: "coordinator", id: "repo-overview", title: "Go on?" },
      { source: "register", id: "OI-1", title: "Ears", anchor: "OI-1" }],
    warnings: [],
  };
  // rows: Vision, the active changes in order, Register, Done
  const rows = overviewRows(ov);
  assert.deepEqual(rows.map((r) => r.kind), ["vision", "change", "change", "register", "done"]);
  assert.deepEqual(rows.filter((r) => r.kind === "change").map((r) => r.change.name), ["repo-overview", "rohdaten"]);
  assert.deepEqual(rows[3].items.map((i) => i.title), ["Decide A", "Ears"]);
  assert.deepEqual(rows[4].archived.map((a) => a.name), ["lcars-bridge"]);
  // empty or missing answer parts: still the frame rows, no throw
  assert.deepEqual(overviewRows({}).map((r) => r.kind), ["vision", "register", "done"]);
  // legacy plans (no openspec/): open ones as change rows, merged ones under Done
  const leg = overviewRows({ inventory: { legacy: [{ name: "a", title: "A", state: "active", done: 1, total: 2 },
    { name: "b", title: "B", state: "merged", done: 2, total: 2 }, { name: "c", title: "C", state: "planned", done: 0, total: 3 }] } });
  assert.deepEqual(leg.filter((r) => r.kind === "change").map((r) => `${r.change.name}:${r.change.state}`), ["a:in progress", "c:planned"]);
  assert.ok(leg.every((r) => r.kind !== "change" || r.legacy));
  assert.deepEqual(leg.find((r) => r.kind === "done").archived.map((a) => a.name), ["b"]);

  // a change's card column: needs_you > working > done
  const items = ov.open_items;
  assert.equal(coordCard({ name: "x", state: "needs_you", agent: "t4", done: 1, total: 2 }, items).col, "needs_you");
  assert.equal(coordCard({ name: "repo-overview", state: "in progress", agent: "t4", done: 1, total: 2 }, items).col, "needs_you"); // listed in needs_you
  assert.deepEqual(coordCard({ name: "repo-overview", state: "in progress", agent: "t4" }, items).asks.map((i) => i.title), ["Go on?"]);
  assert.equal(coordCard({ name: "x", state: "in progress", agent: "t4", done: 1, total: 2 }, items).col, "working");
  assert.equal(coordCard({ name: "x", state: "in progress", agent: "t4", done: 2, total: 2 }, items).col, "working");
  assert.equal(coordCard({ name: "x", state: "in progress", agent: null, done: 2, total: 2 }, items).col, "done");
  assert.equal(coordCard({ name: "x", state: "planned", agent: null, done: 0, total: 2 }, items), null);
  // INTERRUPTED: a neutral card in WORKING, never alert unless listed in needs_you
  const intr = coordCard({ name: "x", state: "in progress", agent: null, interrupted_at: "3", done: 2, total: 4 }, items);
  assert.deepEqual([intr.col, intr.kind], ["working", "interrupted"]);
  assert.equal(coordCard({ name: "repo-overview", state: "in progress", agent: null, interrupted_at: "7", done: 6, total: 7 }, items).col, "needs_you");
  assert.equal(changeColor({ state: "in progress", interrupted_at: "3" }), ROLE.neutral);
  assert.equal(changeColor({ state: "needs_you", interrupted_at: "3" }), ROLE.alert);
  assert.equal(changeColor({ state: "in progress", live: true, done: 1, total: 3 }), ROLE.working);
  assert.equal(changeColor({ state: "done" }), ROLE.done);
  assert.equal(changeColor({ state: "blocked" }), ROLE.neutral);
  assert.equal(changeColor({ state: "planned" }), null); // an outline only

  // the colour says what is happening: blue only while someone is on it
  const st = (c) => [changeStatus(c), changeColor(c)];
  // every task ticked, not archived, nobody on it: READY TO ARCHIVE, gold (herdr-mods' repo-overview at 7/7)
  assert.deepEqual(st({ state: "in progress", done: 7, total: 7, agent: null, live: false }), ["ready", ROLE.done]);
  assert.deepEqual(st({ state: "in progress", done: 7, total: 7, agent: null, interrupted_at: "" }), ["ready", ROLE.done]); // no `live`: older serve
  const ready = coordCard({ name: "x", state: "in progress", done: 7, total: 7, agent: null, live: false }, []);
  assert.deepEqual([ready.col, ready.kind], ["done", "ready"]);
  assert.equal(READY_TEXT, "READY TO ARCHIVE");
  // live: coordinator, or Striker's live (task agent, lead): blue, also with everything ticked
  assert.deepEqual(st({ state: "in progress", done: 7, total: 7, agent: "t4" }), ["working", ROLE.working]);
  assert.deepEqual(st({ state: "in progress", done: 0, total: 3, agent: null, live: true }), ["working", ROLE.working]);
  assert.deepEqual(coordCard({ name: "x", state: "in progress", done: 1, total: 3, agent: null, live: true }, []).kind, "live");
  // ticked and open, nobody on it: INTERRUPTED, neutral (striker-go-bundle at 7/8)
  assert.deepEqual(st({ state: "in progress", done: 7, total: 8, agent: null, live: false, interrupted_at: "7.2" }), ["interrupted", ROLE.neutral]);
  assert.deepEqual(st({ state: "in progress", done: 2, total: 4, agent: null, live: false, interrupted_at: "" }), ["interrupted", ROLE.neutral]);
  // no ticks, nobody on it (a worktree only): planned, an outline; blocked and needs_you as before
  assert.deepEqual(st({ state: "in progress", done: 0, total: 4, agent: null, live: false }), ["planned", null]);
  assert.equal(coordCard({ name: "x", state: "in progress", done: 0, total: 4, agent: null, live: false }, []), null);
  assert.deepEqual(st({ state: "blocked", done: 0, total: 4, live: false }), ["blocked", ROLE.neutral]);
  assert.deepEqual(st({ state: "needs_you", done: 7, total: 7, live: false }), ["needs_you", ROLE.alert]);
  // without `live` (older serve): a working task counts, an interrupted one does not
  assert.equal(changeLive({ state: "in progress", tasks: [{ state: "done" }, { state: "working" }] }), true);
  assert.equal(changeLive({ state: "in progress", done: 1, total: 2, tasks: [{ state: "done" }, { state: "interrupted" }] }), false);
  assert.equal(changeLive({ state: "in progress", coordinator: "t9" }), true);

  // PLAN: every task's card by its state, on its row
  const pc = (state) => { const c = planCard({ state }); return [c.col, c.kind, c.color, c.outline]; };
  assert.deepEqual(pc("working"), ["working", "working", ROLE.working, false]);
  assert.deepEqual(pc("needs_you"), ["needs_you", "needs_you", ROLE.alert, false]);
  assert.deepEqual(pc("interrupted"), ["working", "interrupted", ROLE.neutral, false]); // striker-go-bundle 7.2
  assert.deepEqual(pc("todo"), [null, "open", ROLE.neutral, true]); // no card: an open task stays in the list
  assert.deepEqual(pc("done"), ["done", "done", ROLE.done, false]);
  assert.deepEqual(pc(undefined), [null, "open", ROLE.neutral, true]);
  // only WORKING and NEEDS YOU with an agent open a terminal; INTERRUPTED, OPEN and DONE do not
  assert.equal(cardBottom("interrupted", { address: "t5" }, "x"), null);

  // sizes: no text under 14 px, body 16, touch targets 44
  assert.deepEqual([TEXT_MIN, TEXT_BODY, TOUCH], [14, 16, 44]);

  // the interrupted text: the last ticked task before the interrupted one
  const plan = { tasks: [{ id: "1", state: "done", title: "One" }, { id: "2", state: "done", title: "Two" }, { id: "3", state: "interrupted", title: "Three" }] };
  assert.equal(interruptedText({ interrupted_at: "3" }, plan), "INTERRUPTED · LAST DONE 2 TWO");
  assert.equal(interruptedText({ interrupted_at: "3" }, null), "INTERRUPTED AT TASK 3");
  assert.equal(interruptedText({ interrupted_at: "" }, plan), null);
  // ◂ NOW: working, else needs_you, else interrupted, else the first todo
  assert.equal(nowTask(plan.tasks).id, "3");
  assert.equal(nowTask([{ id: "1", state: "todo" }, { id: "2", state: "working" }]).id, "2");
  assert.equal(nowTask([{ id: "1", state: "done" }]), null);
  // "after X" only while blocked: the plan's blocked_by, else depends_on
  assert.equal(afterText({ state: "blocked", depends_on: ["a"] }, { blocked_by: ["b"] }), "AFTER B");
  assert.equal(afterText({ state: "blocked", depends_on: ["a"] }, null), "AFTER A");
  assert.equal(afterText({ state: "in progress", depends_on: ["a"] }, null), null);

  // the briefing line: phase, next step, progress, the lead and its age
  const now = Date.parse("2026-11-22T10:00:00Z");
  assert.equal(briefingLine(ov.briefing, now), "Phase betrieb · Omega Aufgabe 5 · 4/6 · lead t3 standing by · 2 h ago");
  assert.equal(briefingLine({ address: null, commits: [{ subject: "lcars: x" }] }, now), "NO LEAD STATUS · no lead");
  assert.equal(briefingLine({}, now), "NO LEAD STATUS · no lead");
  // open items without id or with a kind
  assert.equal(itemLabel({ source: "lead", title: "Decide A", kind: "entscheidung" }), "LEAD · ENTSCHEIDUNG · Decide A");
  assert.equal(itemLabel({ source: "register", id: "OI-1", title: "Ears" }), "OI-1 · Ears");
  assert.equal(registerSummary(rows[3].items), "OI-1 · 1 LEAD");
  assert.equal(registerSummary([]), "");

  // OVERVIEW is the default on a main checkout: --git-common-dir is <path>/.git (relative ".git" at the top)
  assert.equal(isMainCheckout("/Users/p/herdr-mods", ".git"), true);
  assert.equal(isMainCheckout("/Users/p/herdr-mods/", "/Users/p/herdr-mods/.git"), true);
  assert.equal(isMainCheckout("/Users/p/herdr-mods-x", "/Users/p/herdr-mods/.git"), false); // a linked worktree
  assert.equal(isMainCheckout("/Users/p/x", ""), false);
  assert.equal(defaultMode(true), "overview");
  assert.equal(defaultMode(false), "plan");

  // a change's worktree space: by folder, else named <repo>-<change>, on the same machine
  const spacesList = [{ id: "s1", name: "herdr-mods", folder: "/Users/p/herdr-mods", machine: null },
    { id: "s2", name: "whatever", folder: "/Users/p/herdr-mods-repo-overview", machine: null },
    { id: "o/s3", name: "alpha-retro", folder: "/srv/alpha-retro", machine: "remote1" }];
  assert.equal(changeSpace({ name: "repo-overview", worktree: "/Users/p/herdr-mods-repo-overview/" }, spacesList, "herdr-mods", null).id, "s2");
  assert.equal(changeSpace({ name: "retro", worktree: "/elsewhere" }, spacesList, "alpha", "remote1").id, "o/s3");
  assert.equal(changeSpace({ name: "retro", worktree: "/srv/alpha-retro" }, spacesList, "alpha", null), null); // other machine
  assert.equal(changeSpace({ name: "repo-overview", worktree: null }, spacesList, "herdr-mods", null), null);
  // the repo's name: its fleet entry, else the folder's name
  assert.equal(repoName([{ name: "alpha", machine: "remote1", path: "/srv/alpha", space_path: "/srv/alpha" }], "remote1", "/srv/alpha"), "alpha");
  assert.equal(repoName([], null, "/Users/p/herdr-mods"), "herdr-mods");

  // an open change row's table of contents: proposal/design `##` headings, code fences skipped
  assert.deepEqual(docHeadings("# P\n\n## Why\ntext\n```\n## not\n```\n## What Changes ##\n### sub\n## Impact {#imp}\n"), ["Why", "What Changes", "Impact"]);
  assert.deepEqual(docHeadings(null), []);
  assert.equal(tocText({ parts: [{ label: "proposal", heads: ["Why", "Impact"] }, { label: "design", heads: [] }, { label: "x", heads: ["A"] }] }),
    "proposal: Why · Impact  |  x: A");
  assert.equal(tocText(null), "");
  // Done: newest first, its card says how many and the newest date
  assert.deepEqual(newestFirst([{ name: "a", date: "2026-01-02" }, { name: "b", date: "" }, { name: "c", date: "2026-03-01" }]).map((a) => a.name), ["c", "a", "b"]);
  assert.equal(doneSummary([{ name: "a", date: "2026-01-02" }, { name: "c", date: "2026-03-01" }]), "2 DONE · 2026-03-01");
  assert.equal(doneSummary([]), "");
  // the row open by default: the first change in progress or needing the person
  assert.equal(defaultOpen(rows), "change:repo-overview");
  assert.equal(defaultOpen(overviewRows({})), null);

  // a coordinator item with no matching change row (no id, or an unknown change) stays in Register
  const orphan = overviewRows({ inventory: { changes: [{ name: "a", state: "in progress" }] },
    open_items: [{ source: "coordinator", id: "a", title: "on a" }, { source: "coordinator", id: "gone", title: "lost" },
      { source: "coordinator", title: "no id" }] });
  assert.deepEqual(orphan.find((r) => r.kind === "register").items.map((i) => i.title), ["lost", "no id"]);

  // the TOC line: /doc's headings, else /repo's toc while /doc loads or when it fails
  assert.equal(tocLine({ parts: [{ label: "proposal", heads: ["Why"] }] }, { toc: ["X"] }), "proposal: Why");
  assert.equal(tocLine(null, { toc: ["Why", "Goals"] }), "Why · Goals");
  assert.equal(tocLine({ parts: [{ label: "proposal", heads: [] }] }, { toc: ["Why"] }), "Why");
  assert.equal(tocLine(null, null), "");

  // the tick bar: ticked and next segments in the card's colour family (neutral for INTERRUPTED)
  assert.deepEqual(barColors(2, 4, ROLE.neutral), [ROLE.neutral, ROLE.neutral, ROLE.neutral, ROLE.track]);
  assert.deepEqual(barColors(1, 3), [ROLE.working, ROLE.active, ROLE.track]);
  assert.ok(barColors(2, 4, ROLE.neutral).every((c) => c !== ROLE.working && c !== ROLE.active));

  // first open: OVERVIEW on a main checkout unless the person chose a mode
  assert.equal(firstMode("plan", true, false), "overview");
  assert.equal(firstMode("plan", true, true), "plan");
  assert.equal(firstMode("spec", false, false), "spec");
}

// --- the briefing's NO LEAD STATUS, note and last commits (overview.js) ---
{
  const now = Date.parse("2026-11-22T10:00:00Z");
  // a lead without a status file: NO LEAD STATUS, then the lead
  assert.equal(briefingLine({ address: "t3", state: "working", task: "", phase: "", progress: null, note: "", updated: "", commits: [] }, now),
    "NO LEAD STATUS · lead t3 working");
  assert.equal(briefingLine({ address: null, commits: [{ subject: "x" }] }, now), "NO LEAD STATUS · no lead");
  // the note is part of the briefing
  assert.equal(briefingLine({ address: "t3", state: "idle", task: "T", note: "waiting for CI", updated: "2026-11-22T09:00:00Z" }, now),
    "T · waiting for CI · lead t3 standing by · 1 h ago");
  // the last commits, up to five, newest first
  const cs = ["a", "b", "c", "d", "e", "f"].map((s) => ({ subject: s }));
  assert.equal(commitsLine({ commits: cs }), "Last commits: a · b · c · d · e");
  assert.equal(commitsLine({ commits: [{ subject: "only" }, { subject: "" }] }), "Last commits: only");
  assert.equal(commitsLine({ commits: [] }), "NO COMMITS");
  assert.equal(commitsLine(null), "NO COMMITS");
}

// --- the Striker board's coordinators (board.js) ---
{
  const repo = { name: "alpha", title: "Alpha", coordinators: [
    { change: "omega", address: "remote1/t3", state: "working",
      status: { task: "Task 2.1", needs_you: [{ kind: "frage", text: "Which API?", task: "2.1" }, { text: "" }] } },
    { change: "retro", address: "remote1/t4", state: "idle", status: { error: "keine Statusdatei alpha--retro.json" } },
    { change: "zzz", address: "remote1/t5", state: "blocked", status: {} },
  ] };
  // live state from herdr wins over the polled one
  const live = new Map([["remote1/t4", { status: "working" }]]);
  const cs = boardCoords(repo, live);
  assert.deepEqual(cs.map((c) => c.label), ["COORD OMEGA · NEEDS YOU", "COORD RETRO · WORKING", "COORD ZZZ · NEEDS YOU"]);
  assert.deepEqual(cs.map((c) => c.color), [ROLE.alert, ROLE.working, ROLE.alert]);
  assert.deepEqual(cs[0].needs, [{ kind: "frage", text: "Which API?", task: "2.1" }]);
  assert.equal(cs[0].task, "Task 2.1");
  // a status error: the coordinator is still listed, the error is not an alert
  assert.equal(cs[1].error, "keine Statusdatei alpha--retro.json");
  assert.deepEqual(cs[1].needs, []);
  assert.ok(cs.every((c) => c.color !== ROLE.alert || c.needy));
  // no coordinators, or a missing list: none
  assert.deepEqual(boardCoords({ name: "x" }, new Map()), []);
  // idle without live state: standing by, neutral-ish idle colour
  assert.equal(boardCoords({ coordinators: [{ change: "a", address: "t1", state: "idle", status: null }] }, new Map())[0].label, "COORD A · STANDING BY");
  // a click on the head goes to whoever asks: the lead, else the first asking coordinator, else the lead
  const L = { address: "remote1/t1" };
  assert.equal(asker({ lead: L, leadNeedy: true, coords: cs }), "remote1/t1");
  assert.equal(asker({ lead: L, coords: cs }), "remote1/t3");
  assert.equal(asker({ lead: L, coords: [cs[1]] }), "remote1/t1");
  assert.equal(asker({ lead: null, coords: [] }), null);

  // crew names: the coordinator's line, its worktree folder, the NEXT MOVE lines and the header's small line
  const names = { "remote1/t3": { label: "LT WERF", short: "WERF" } };
  const live2 = new Map([["remote1/t3", { status: "working", cwd: "/srv/alpha-omega" }]]);
  const named = boardCoords(repo, live2, (a) => names[a] ?? null);
  assert.equal(named[0].label, "LT WERF · OMEGA · NEEDS YOU");
  assert.equal(named[0].worktree, "ALPHA-OMEGA");
  assert.equal(named[1].label, "COORD RETRO · STANDING BY"); // no name: as before
  assert.equal(named[1].worktree, null);
  assert.equal(named[0].who, "WERF");
  const data = { name: "LCDR PATA" };
  assert.equal(headLine({ lead: data, leadNeedy: true, word: "WORKING", coords: named }), "LCDR PATA · NEEDS YOU");
  assert.equal(headLine({ lead: data, word: "WORKING", coords: named }), "LT WERF · OMEGA · NEEDS YOU · +1");
  assert.equal(headLine({ lead: data, word: "WORKING", coords: [] }), "LCDR PATA · WORKING");
  assert.equal(headLine({ lead: null, coords: [] }), "NO LEAD");
  assert.equal(headLine({ lead: { name: null }, leadNeedy: true }), "LEAD · NEEDS YOU");
  assert.equal(headLine({ lead: { name: null }, coords: [cs[2]] }), "COORD ZZZ · NEEDS YOU");
}

// --- tree lanes and marks for the OpenSpec states (Ruling 6) ---
{
  const states = new Map([["a", "in progress"], ["b", "needs_you"], ["c", "done"], ["d", "planned"], ["e", "blocked"], ["f", "active"], ["g", "merged"]]);
  const lc = (plan) => laneColor({ index: 1, plan }, states);
  assert.deepEqual(["a", "b", "c", "d", "e", "f", "g"].map(lc),
    [ROLE.working, ROLE.alert, ROLE.done, ROLE.neutral, ROLE.neutral, ROLE.working, ROLE.done]);
  const graph = { cols: 3, now: 1, lanes: [{ index: 0, plan: "" }, { index: 1, plan: "a", blocked_by: [] }],
    nodes: [{ id: "t1", col: 1, lane: 1, kind: "task", plan: "a", state: "done", future: false },
      { id: "t2", col: 2, lane: 1, kind: "task", plan: "a", state: "interrupted", future: true }], edges: [] };
  const t = treeLayout(graph, { width: 300, height: 104, plans: [{ topic: "a", state: "in progress" }] });
  const m = t.marks.find((k) => k.x === t.xs[2]);
  assert.equal(m.ring, ROLE.neutral); // interrupted: neutral, a solid ring, not alert
  assert.ok(!m.dash);
  // an interrupted change (in progress, an interrupted task or interrupted_at): a neutral lane, not a working one
  assert.equal(laneState({ state: "in progress", tasks: [{ state: "done" }, { state: "interrupted" }] }), "interrupted");
  assert.equal(laneState({ state: "in progress", interrupted_at: "3", tasks: [] }), "interrupted");
  assert.equal(laneState({ state: "in progress", tasks: [{ state: "working" }] }), "in progress");
  assert.equal(laneState({ state: "needs_you", interrupted_at: "3" }), "needs_you");
  assert.equal(laneColor({ index: 1, plan: "i" }, new Map([["i", "interrupted"]])), ROLE.neutral);
  const ti = treeLayout(graph, { width: 300, height: 104, plans: [{ topic: "a", state: "in progress", tasks: graph.nodes }] });
  assert.ok(ti.strokes.every((s) => s.color !== ROLE.working)); // no blue lane for it
  // the OVERVIEW's rule for an OpenSpec lane: blue only while live, gold when every task is ticked, else neutral
  const done2 = [{ state: "done" }, { state: "done" }];
  assert.equal(laneState({ state: "in progress", live: false, tasks: done2 }), "ready");
  assert.equal(laneColor({ index: 1, plan: "r" }, new Map([["r", "ready"]])), ROLE.done);
  assert.equal(laneState({ state: "in progress", live: true, tasks: done2 }), "in progress");
  assert.equal(laneState({ state: "in progress", live: false, tasks: [{ state: "done" }, { state: "todo" }] }), "interrupted");
  assert.equal(laneState({ state: "in progress", live: false, tasks: [{ state: "todo" }] }), "planned");
  assert.equal(laneState({ state: "in progress", coordinator: "t9", tasks: [{ state: "todo" }] }), "in progress");
  assert.equal(laneState({ state: "done", tasks: done2 }), "done");
  // legacy plans keep their own states
  assert.equal(laneState({ state: "active", legacy: true, tasks: [] }), "active");
  assert.equal(laneState({ state: "planned", legacy: true, tasks: [{ state: "done" }] }), "planned");
  const tr = treeLayout(graph, { width: 300, height: 104, plans: [{ topic: "a", state: "in progress", live: false, tasks: done2 }] });
  assert.ok(tr.strokes.some((s) => s.color === ROLE.done) && tr.strokes.every((s) => s.color !== ROLE.working));
}

// --- Striker by his label striker.self ---
{
  assert.equal(strikerSelf([{ address: "t13", labels: {} }, { address: "t16", labels: { "striker.self": "1", "striker.lead": "herdr-mods" } }]), "t16");
  assert.equal(strikerSelf([{ address: "t16", labels: ["striker.self=1"] }]), "t16");
  assert.equal(strikerSelf([{ address: "t13" }]), null);
  assert.equal(strikerSelf(null), null);
}

// --- no Striker yet: start him in his repo, in the space STRIKER ---
{
  const repo = "/Users/p/dev/striker";
  const made = strikerLaunch(repo, [{ address: "t1", labels: {} }], [{ name: "Infrastruktur" }]);
  assert.equal(made.name, "STRIKER");
  assert.equal(made.folder, repo);
  assert.equal(made.argv[0], "claude");
  assert.deepEqual(made.argv.slice(1, 3), ["--remote-control", "striker"]);
  assert.match(made.argv[3], /striker\/CLAUDE\.md/);
  // already there: a space STRIKER (any case, on this computer) or a terminal labelled striker.self
  assert.equal(strikerLaunch(repo, [], [{ name: "striker" }]), null);
  assert.equal(strikerLaunch(repo, [{ address: "t16", labels: { "striker.self": "1" } }], []), null);
  // a STRIKER space on another machine is not him
  assert.equal(strikerLaunch(repo, [], [{ name: "STRIKER", machine: "remote1" }]).name, "STRIKER");
  // no repo known (an old striker serve): nothing
  assert.equal(strikerLaunch(null, [], []), null);
  assert.equal(strikerLaunch("", [], []), null);
}

// --- Striker's terminal in the space STRIKER, also while his Claude reports no status (no agent for herdr) ---
{
  const spaces = [{ name: "Infrastruktur", tabs: [{ id: "a" }] }, { name: "STRIKER", tabs: [{ id: "b" }] }];
  const panes = [{ tab: "a", terminal: "t10" }, { tab: "b", terminal: "t1s" }];
  assert.equal(strikerTerminal(spaces, panes, []), "t1s");
  assert.equal(strikerTerminal([{ name: "STRIKER", machine: "remote1", tabs: [{ id: "b" }] }], panes, []), null);
  assert.equal(strikerTerminal([spaces[0]], panes, []), null);
  assert.equal(strikerTerminal(null, null, null), null);
}

// --- SPEC on a main checkout lists every spec ---
{
  const ov = { inventory: { capabilities: [{ path: "bridge/repo-overview", requirements: 3 }], changes: [{ name: "striker-relay" }],
    legacy: [{ name: "old", title: "Old plan", spec: "docs/superpowers/specs/old-design.md" }, { name: "nospec", spec: "" }] } };
  assert.deepEqual(specList(ov), [
    { label: "bridge / repo-overview", file: "openspec/specs/bridge/repo-overview/spec.md" },
    { label: "CHANGE · striker-relay", file: "openspec/changes/striker-relay/design.md" },
    { label: "Old plan", file: "docs/superpowers/specs/old-design.md" },
  ]);
  assert.deepEqual(specList(null), []);
}

// --- the stardate is the local clock as one number ---
{
  assert.equal(stardate(new Date(2026, 10, 24, 15, 30, 42).getTime()), "20261124.153042");
  assert.equal(stardate(new Date(2026, 0, 2, 3, 4, 5).getTime()), "20260102.030405");
  assert.equal(stardate(new Date(2026, 11, 31, 23, 59, 59).getTime()), "20261231.235959");
}

// --- PR buttons in a needs_you text: every "PR #<n>" once, linked to the repo's GitHub ---
{
  assert.deepEqual(prLinks("PR #29 und PR #31 mergen", "o/r"), [
    { label: "PR #29", url: "https://github.com/o/r/pull/29" },
    { label: "PR #31", url: "https://github.com/o/r/pull/31" },
  ]);
  assert.deepEqual(prLinks("pr#29, PR #29.", "o/r"), [{ label: "PR #29", url: "https://github.com/o/r/pull/29" }]);
  assert.deepEqual(prLinks("issue #29 und #30", "o/r"), []);
  assert.deepEqual(prLinks("PR #29", null), []);
  assert.deepEqual(prLinks(null, "o/r"), []);
}

// --- OPEN PRS rows: at most 5, then +<k> MORE to the repo's pulls page ---
{
  const pr = (n, draft = false) => ({ number: n, title: `t${n}`, url: `u${n}`, draft, branch: "b" });
  const seven = prRows([1, 2, 3, 4, 5, 6, 7].map((n) => pr(n)), "o/r");
  assert.equal(seven.rows.length, 5);
  assert.deepEqual(seven.rows[0], { key: "1", number: "#1", title: "t1", draft: false, url: "u1" });
  assert.deepEqual(seven.more, { label: "+2 MORE", url: "https://github.com/o/r/pulls" });
  const two = prRows([pr(29), pr(31, true)], "o/r");
  assert.equal(two.more, null);
  assert.equal(two.rows[1].draft, true);
  assert.deepEqual(prRows(null, "o/r"), { rows: [], more: null });
  assert.equal(prRows([1, 2, 3, 4, 5, 6].map((n) => pr(n)), null).more, null);
}

console.log("ok");

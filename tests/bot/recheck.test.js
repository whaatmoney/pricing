import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, lastDueRefresh, ordersSince, renderBoard } from "../../bot/lib/board.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { recordDecision } from "../../bot/lib/lifecycle.js";
import { compareDecisions, decisionOptions, readRecheck, recheckCases } from "../../bot/lib/recheck.js";
import { importSnapshot } from "../../bot/lib/router-snapshot.js";
import { buildWorld, routerRow, tempDir, worldRouterRows, writeRouterExport } from "./helpers.js";

// A page priced on the world's first export, saved as v1, and the config the
// recheck reads. `later` writes the next weekly export and imports it.
function pricedWorld() {
  const world = buildWorld();
  const decision = buildDecision(world.options);
  const outputs = tempDir("qpc-recheck-");
  fs.writeFileSync(path.join(outputs, `CLAUDE-DECISION-${decision.caseId}-v1.json`), JSON.stringify({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } }));
  const o = world.options;
  const config = { routerHistoryFolder: o.routerFolder, storeDir: o.storeDir, salesExport: o.salesExportPath, priceLabDir: o.priceLabDir, calculatorHtml: o.calculatorHtml, outputsDir: outputs, casesDir: world.root, recheckFile: path.join(world.root, "recheck.json") };
  const later = (extraRows) => {
    const file = writeRouterExport(o.routerFolder, "092826 - LineItems_with_RouterHistory.xlsx", [...worldRouterRows(), routerRow({ wo: "7001WA", customer: "OTHER AEROSPACE INC", description: "P/N: ZZZ-9" }), ...extraRows]);
    assert.equal(importSnapshot(file, { storeDir: o.storeDir }).outcome, "accepted");
  };
  // Builds the way `recheck` does, with the fixed clock the fixture expects.
  const build = (casePath) => buildDecision({ ...decisionOptions(config, casePath), now: o.now });
  return { world, decision, config, later, build, open: new Set([decision.caseId]) };
}

const boardOf = (config) => buildBoard({ outputsDir: config.outputsDir, monitorStatePath: null, storeDir: config.storeDir, recheckPath: config.recheckFile });
const versions = (config, caseId) => fs.readdirSync(config.outputsDir).filter((name) => name.startsWith(`CLAUDE-DECISION-${caseId}-v`) && name.endsWith(".json")).sort();

test("a newer export that changes nothing for the page: stamped as checked, no new version, and the rebuild prompt gives way to the check", () => {
  const { decision, config, later, build, open } = pricedWorld();
  later([]);
  const before = boardOf(config);
  assert.equal(before.cases[0].staleSnapshot, true);
  assert.match(renderBoard(before), /newer Router History is in\. Ask to rebuild\./);

  const { results } = recheckCases({ config, openCaseIds: open, build });
  assert.deepEqual(results.map((item) => item.result), ["unchanged"]);
  assert.equal(results[0].snapshotFile, "092826 - LineItems_with_RouterHistory.xlsx");
  assert.deepEqual(versions(config, decision.caseId), [`CLAUDE-DECISION-${decision.caseId}-v1.json`]);

  const after = boardOf(config);
  assert.equal(after.cases[0].checked.result, "unchanged");
  const html = renderBoard(after);
  assert.doesNotMatch(html, /Ask to rebuild/);
  assert.match(html, /Checked against 092826 - LineItems_with_RouterHistory\.xlsx on .*: no change to the price or its history\./);
});

test("a work order for the part after the RFQ: the page is rebuilt as v2, the old version is kept, and the card says the part may be ordered", () => {
  const { decision, config, later, build, open } = pricedWorld();
  const v1 = fs.readFileSync(path.join(config.outputsDir, `CLAUDE-DECISION-${decision.caseId}-v1.json`), "utf8");
  // The fixture's RFQ was asked 2026-09-24.
  later([routerRow({ wo: "6001WA", received: "09/25/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-120", price: 7.25 })]);

  const { results } = recheckCases({ config, openCaseIds: open, build });
  assert.equal(results[0].result, "rebuilt");
  assert.equal(results[0].newVersion, 2);
  assert.ok(results[0].changes.some((change) => change.newRows > 0));
  assert.equal(fs.readFileSync(path.join(config.outputsDir, `CLAUDE-DECISION-${decision.caseId}-v1.json`), "utf8"), v1, "v1 is never rewritten");
  const v2 = JSON.parse(fs.readFileSync(path.join(config.outputsDir, `CLAUDE-DECISION-${decision.caseId}-v2.json`), "utf8"));
  assert.equal(v2.lifecycle.recommendationVersion, 2);
  assert.equal(v2.lifecycle.supersedes, 1);

  const board = boardOf(config);
  const [kase] = board.cases;
  assert.equal(kase.version, 2);
  assert.equal(kase.staleSnapshot, false);
  assert.equal(kase.repriced.version, 1);
  assert.deepEqual(kase.ordersSince.map((order) => [order.wo, order.date, order.unitPrice]), [["6001WA", "2026-09-25", 7.25]]);
  const html = renderBoard(board);
  assert.match(html, /Rebuilt on 092826 - LineItems_with_RouterHistory\.xlsx \(.*\) from v1: .*new history row/);
  assert.match(html, /Work order since the RFQ: WO 6001WA on Sep 25, 2026 at \$7\.25 \(L1, L2\)\. The part may already be ordered; check before quoting\./);
  assert.match(html, /Work order since asked<\/span>/);
  assert.match(html, /1 with a work order since asked/);
});

test("a case with any recorded decision is never rebuilt, a stamped check is not repeated, and a failed build is tried again next run", () => {
  const { decision, config, later, build, open } = pricedWorld();
  later([routerRow({ wo: "6001WA", received: "09/25/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-120", price: 7.25 })]);

  recordDecision({ outputsDir: config.outputsDir, caseId: decision.caseId, version: 1, lineId: "L1", choice: "alternative", unitPrice: 8, note: "test price", decidedBy: "Pat Reviewer", decidedAt: "2026-09-25T14:00:00Z", now: new Date("2026-09-25T14:05:00Z") });
  let builds = 0;
  const counted = (casePath) => { builds++; return build(casePath); };
  const decided = recheckCases({ config, openCaseIds: open, build: counted });
  assert.deepEqual(decided.results.map((item) => item.result), ["decided"]);
  assert.equal(builds, 0);
  assert.equal(versions(config, decision.caseId).length, 1);
  assert.deepEqual(recheckCases({ config, openCaseIds: open, build: counted }).results, [], "stamped: nothing to do on the next run");

  const other = pricedWorld();
  other.later([]);
  const failed = recheckCases({ config: other.config, openCaseIds: other.open, build: () => { throw new Error("search log has no gaps list"); } });
  assert.deepEqual(failed.results.map((item) => [item.result, item.error]), [["error", "search log has no gaps list"]]);
  assert.deepEqual(readRecheck(other.config.recheckFile), [], "errors are not stamped");
  assert.deepEqual(recheckCases({ config: other.config, openCaseIds: other.open, build: other.build }).results.map((item) => item.result), ["unchanged"]);
});

test("a decision recorded while the page is being rebuilt wins: no new version is saved over it", () => {
  const { decision, config, later, build, open } = pricedWorld();
  later([routerRow({ wo: "6001WA", received: "09/25/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-120", price: 7.25 })]);
  const racing = (casePath) => {
    const fresh = build(casePath);
    recordDecision({ outputsDir: config.outputsDir, caseId: decision.caseId, version: 1, lineId: "L1", choice: "alternative", unitPrice: 8, note: "test price", decidedBy: "Pat Reviewer", decidedAt: "2026-09-25T14:00:00Z", now: new Date("2026-09-25T14:05:00Z") });
    return fresh;
  };
  assert.deepEqual(recheckCases({ config, openCaseIds: open, build: racing }).results.map((item) => item.result), ["decided"]);
  assert.equal(versions(config, decision.caseId).length, 1);
});

test("a decision on the earlier version that lands after the rebuild (another run, merged later) deletes nothing and is shown on the card", () => {
  const { decision, config, later, build, open } = pricedWorld();
  later([routerRow({ wo: "6001WA", received: "09/25/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-120", price: 7.25 })]);
  assert.equal(recheckCases({ config, openCaseIds: open, build }).results[0].result, "rebuilt");
  recordDecision({ outputsDir: config.outputsDir, caseId: decision.caseId, version: 1, lineId: "L1", choice: "alternative", unitPrice: 8, note: "test price", decidedBy: "Pat Reviewer", decidedAt: "2026-09-25T14:00:00Z", now: new Date("2026-09-25T14:05:00Z") });

  assert.deepEqual(recheckCases({ config, openCaseIds: open, build }).results, [], "nothing is rechecked or removed");
  assert.equal(versions(config, decision.caseId).length, 2);
  const [kase] = boardOf(config).cases;
  assert.equal(kase.version, 2);
  assert.deepEqual(kase.decidedEarlier.map((entry) => [entry.version, entry.lineId, entry.decidedBy]), [[1, "L1", "Pat Reviewer"]]);
  assert.match(renderBoard(boardOf(config)), /A decision is recorded on an earlier version of this page \(v1 L1, Pat Reviewer Sep 25, 2026\)\. Decisions do not carry to a new version: check the earlier page before quoting\./);
});

test("a rebuilt version carries where it came from, so the card says so even without the check log", () => {
  const { decision, config, later, build, open } = pricedWorld();
  later([routerRow({ wo: "6001WA", received: "09/25/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-120", price: 7.25 })]);
  recheckCases({ config, openCaseIds: open, build });
  const v2 = JSON.parse(fs.readFileSync(path.join(config.outputsDir, `CLAUDE-DECISION-${decision.caseId}-v2.json`), "utf8"));
  assert.equal(v2.lifecycle.rebuiltByRecheck.from, 1);
  assert.equal(v2.lifecycle.rebuiltByRecheck.snapshotFile, "092826 - LineItems_with_RouterHistory.xlsx");
  fs.rmSync(config.recheckFile);
  assert.match(renderBoard(boardOf(config)), /Rebuilt on 092826 - LineItems_with_RouterHistory\.xlsx \(.*\) from v1:/);
});

test("recheck only ever creates the next version: an existing or newer version file is never rewritten", () => {
  const { decision, config, later, build, open } = pricedWorld();
  later([routerRow({ wo: "6001WA", received: "09/25/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-120", price: 7.25 })]);
  const v2 = path.join(config.outputsDir, `CLAUDE-DECISION-${decision.caseId}-v2.json`);
  // Another writer saves v2 while this case is being built.
  const racing = (casePath) => {
    const fresh = build(casePath);
    fs.writeFileSync(v2, JSON.stringify({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 2 }, marker: "other writer" }));
    return fresh;
  };
  const result = recheckCases({ config, openCaseIds: open, build: racing }).results[0];
  assert.equal(result.result, "error");
  assert.match(result.error, /newer version than v1/);
  assert.equal(JSON.parse(fs.readFileSync(v2, "utf8")).marker, "other writer");
  assert.equal(versions(config, decision.caseId).length, 2);
});

test("a page built on an export imported during the check is left for the next run, not credited to the wrong export", () => {
  const { config, later, build, open } = pricedWorld();
  later([]);
  const stale = (casePath) => {
    const fresh = build(casePath);
    for (const line of fresh.lines) line.history.database.snapshot = { ...line.history.database.snapshot, id: "imported-meanwhile" };
    return fresh;
  };
  const [result] = recheckCases({ config, openCaseIds: open, build: stale }).results;
  assert.equal(result.result, "error");
  assert.match(result.error, /imported during the check/);
  assert.deepEqual(readRecheck(config.recheckFile), []);
});

test("a missing or broken case file is reported and tried again next run, not stamped", () => {
  const { world, config, later, build, open } = pricedWorld();
  later([]);
  const text = fs.readFileSync(world.casePath, "utf8");
  fs.writeFileSync(world.casePath, "{ not json");
  const missing = recheckCases({ config, openCaseIds: open, build });
  assert.deepEqual(missing.results.map((item) => item.result), ["no-case-file"]);
  assert.match(missing.results[0].error, /unreadable case files: case\.json/);
  assert.deepEqual(readRecheck(config.recheckFile), []);
  fs.writeFileSync(world.casePath, text);
  assert.deepEqual(recheckCases({ config, openCaseIds: open, build }).results.map((item) => item.result), ["unchanged"]);
});

test("a rebuilt card says what moved: unit price, lot charge, price source and history rows", () => {
  const { decision, config, later } = pricedWorld();
  later([]);
  const stamp = { caseId: decision.caseId, version: 0, newVersion: 1, snapshotId: "x", snapshotFile: "092826 - LineItems_with_RouterHistory.xlsx", checkedAt: "2026-10-26T15:00:00Z", result: "rebuilt", changes: [
    { lineId: "L1", from: 8, to: 8, lotFrom: null, lotTo: 350, labelFrom: "repeat", labelTo: "repeat", newRows: 0, changedRows: 1, removedRows: 1 },
    { lineId: "L2", from: 7, to: 7.5, lotFrom: null, lotTo: null, labelFrom: "repeat", labelTo: "previous quote", newRows: 2, changedRows: 0, removedRows: 0 },
  ] };
  fs.writeFileSync(config.recheckFile, JSON.stringify({ schema: 1, checks: [stamp] }));
  const html = renderBoard(boardOf(config));
  assert.match(html, /from v0: L1 lot charge — → \$350\.00; L2 \$7\.00 → \$7\.50; L2 price now from previous quote \(was repeat\); 2 new history rows; 1 history row changed; 1 history row gone\./);
});

test("only open pages priced on an older export are checked", () => {
  const { config, later, build } = pricedWorld();
  let builds = 0;
  const counted = (casePath) => { builds++; return build(casePath); };
  assert.deepEqual(recheckCases({ config, openCaseIds: new Set(["TEST-ABC-100"]), build: counted }).results, [], "priced on the current export");
  later([]);
  assert.deepEqual(recheckCases({ config, openCaseIds: new Set(), build: counted }).results, [], "not open");
  assert.equal(builds, 0);
});

test("compareDecisions: a moved price, a new, changed or removed history row is a change; the same summary or new wording is not", () => {
  const line = (price, rows, scope = "300; oxygen not stated") => ({ lineId: "L1", recommendation: { preferred: price == null ? null : { unitPrice: price, label: "repeat" }, uncalculated: price == null ? "size missing" : null }, history: { timeline: rows.map((wo) => ({ source: "Work order (Router History)", date: "2026-09-01", evidence: `WO ${wo}, row 1`, unitPrice: 8, scope })) } });
  const decision = (price, rows, scope) => ({ lines: [line(price, rows, scope)], poLotMinimum: null });
  const change = (fields) => ({ lineId: "L1", from: 8, to: 8, lotFrom: null, lotTo: null, labelFrom: "repeat", labelTo: "repeat", newRows: 0, changedRows: 0, removedRows: 0, ...fields });
  assert.deepEqual(compareDecisions(decision(8, ["1"]), decision(8, ["1"])), []);
  assert.deepEqual(compareDecisions(decision(8, ["1"]), decision(9, ["1"])), [change({ to: 9 })]);
  assert.deepEqual(compareDecisions(decision(8, ["1"]), decision(8, ["1", "2"])), [change({ newRows: 1 })]);
  assert.deepEqual(compareDecisions(decision(8, ["1", "2"]), decision(8, ["1"])), [change({ removedRows: 1 })]);
  assert.deepEqual(compareDecisions(decision(8, ["1"]), decision(8, ["1"], "300; FOR OXYGEN SERVICE")), [change({ changedRows: 1 })], "same work order, corrected scope");
  // Two quantity tiers from one quote share a source, date and evidence.
  const tiers = (second) => ({ poLotMinimum: null, lines: [{ lineId: "L1", recommendation: { preferred: { unitPrice: 8, label: "repeat" } }, history: { timeline: [{ source: "QPC sent estimate", date: "2026-09-01", evidence: "mail", unitPrice: 9, quantity: 10 }, { source: "QPC sent estimate", date: "2026-09-01", evidence: "mail", unitPrice: second, quantity: 100 }] } }] });
  assert.deepEqual(compareDecisions(tiers(7), tiers(6.5)), [change({ changedRows: 1 })]);
  assert.deepEqual(compareDecisions(decision(null, []), decision(null, [])), []);
  const reworded = decision(null, []);
  reworded.lines[0].recommendation.uncalculated = "size missing, and a newer engine says more";
  assert.deepEqual(compareDecisions(decision(null, []), reworded), [], "a newer engine's wording alone is not a change");
});

test("ordersSince: work orders on or after the day asked, one entry per work order, other sources ignored", () => {
  const row = (source, date, evidence, unitPrice = 4) => ({ source, date, evidence, unitPrice });
  const decision = {
    rfq: { initiatedAt: "2026-10-08T14:22:22Z" },
    lines: [
      { lineId: "L1", history: { timeline: [row("Work order (Router History)", "2026-10-07", "WO 100, row 1"), row("Work order (Router History)", "2026-10-16", "WO 200, row 2"), row("QPC sent estimate", "2026-10-09", "mail")] } },
      { lineId: "L2", history: { timeline: [row("Work order (Router History)", "2026-10-16", "WO 200, row 3"), row("Work order (Router History)", "2026-10-08", "WO 150, row 4", null)] } },
    ],
  };
  assert.deepEqual(ordersSince(decision), [{ wo: "150", date: "2026-10-08", unitPrice: null, lineIds: ["L2"] }, { wo: "200", date: "2026-10-16", unitPrice: 4, lineIds: ["L1", "L2"] }]);
  assert.deepEqual(ordersSince({ rfq: {}, lines: [] }), []);
  // Asked at 5:30 PM Pacific on Oct 26 (already Oct 27 in UTC): an Oct 26 work order counts.
  const evening = { rfq: { initiatedAt: "2026-10-27T00:30:00Z" }, lines: [{ lineId: "L1", history: { timeline: [row("Work order (Router History)", "2026-10-26", "WO 300, row 5")] } }] };
  assert.deepEqual(ordersSince(evening).map((order) => order.wo), ["300"]);
});

test("a Pacific timetable keeps its local times across the daylight-saving change", () => {
  const schedule = { days: [1, 2, 3, 4, 5], first: "07:05", last: "16:35", everyMinutes: 30, graceMinutes: 30, timeZone: "America/Los_Angeles" };
  const at = (iso) => Date.parse(iso);
  // Friday 2026-10-30 is on daylight time (UTC-7): 8:00 AM local, the 7:05 run is due.
  assert.equal(lastDueRefresh(schedule, at("2026-10-30T15:00:00Z")), at("2026-10-30T14:05:00Z"));
  // Monday 2026-11-02 is on standard time (UTC-8): the same 7:05 is an hour later in UTC.
  assert.equal(lastDueRefresh(schedule, at("2026-11-02T16:00:00Z")), at("2026-11-02T15:05:00Z"));
  // Monday 7:20 AM local, before 7:05 plus grace: Friday's 4:35 PM run (daylight time).
  assert.equal(lastDueRefresh(schedule, at("2026-11-02T15:20:00Z")), at("2026-10-30T23:35:00Z"));
  // Weekend and evening: the day's last run.
  assert.equal(lastDueRefresh(schedule, at("2026-11-01T20:00:00Z")), at("2026-10-30T23:35:00Z"));
  assert.equal(lastDueRefresh(schedule, at("2026-11-03T06:00:00Z")), at("2026-11-03T00:35:00Z"));
  // Every half hour in the day.
  assert.equal(lastDueRefresh(schedule, at("2026-11-02T20:10:00Z")), at("2026-11-02T19:35:00Z"));
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, monitorLink, quoteSentStatus, renderBoard } from "../../bot/lib/board.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { readManifest } from "../../bot/lib/router-snapshot.js";
import { isCloudOnly, readLastSync, runSync } from "../../bot/lib/sync.js";
import { buildWorld, routerRow, tempDir, workbookBuffer, writeRouterExport } from "./helpers.js";

function syncedWorld(monitorQueue) {
  const world = buildWorld();
  const decision = buildDecision(world.options);
  const outputs = tempDir("qpc-sync-");
  fs.writeFileSync(path.join(outputs, `CLAUDE-DECISION-${decision.caseId}-v1.json`), JSON.stringify({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } }));
  const monitorState = path.join(world.root, "monitor.json");
  fs.writeFileSync(monitorState, JSON.stringify({ freshness: { source_cutoff: "2026-09-28T03:00:00Z", stale: false }, last_check_report: "outputs/RFQ-CHECK-2026-09-28-0300.md", operational_queue: monitorQueue }));
  const o = world.options;
  const config = { routerHistoryFolder: o.routerFolder, storeDir: o.storeDir, outputsDir: outputs, monitorState, syncLog: path.join(world.root, "sync-log.jsonl") };
  return { world, decision, config };
}

const boardFor = (queue) => {
  const { config } = syncedWorld(queue);
  return buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, storeDir: config.storeDir });
};

test("a case leaves the waiting list only when the monitor's status says a quote was sent", () => {
  const board = boardFor([
    { customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 3, status: "Quote sent; waiting on customer", evidence_ids: ["rfq"] },
    { customer: "Other Co", reference: "99 / XYZ-9", priority_section: 1, status: "New RFQ" },
  ]);
  const [kase] = board.cases;
  assert.equal(kase.state, "Quote sent (per monitor status)");
  assert.equal(kase.open, false);
  assert.equal(kase.monitor.section, 3);
  assert.deepEqual(board.monitor.sections, { 1: 1, 2: 0, 3: 1 });
  assert.deepEqual(board.monitor.withoutPage.map((item) => item.ask), ["Price RFQ: Other Co 99 / XYZ-9"]);
  const html = renderBoard(board);
  const po = boardFor([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 3, status: "Customer PO received and acknowledged", evidence_ids: ["rfq"] }]).cases[0];
  assert.equal(po.open, true);
  assert.equal(po.state, "Waiting on you");
  assert.match(html, /href="RFQ-CHECK-2026-09-28-0300\.md"/);
  assert.match(html, /<th>Company · reference<\/th><th>Sender<\/th><th>Email subject<\/th>/);
});

test("sync imports a new weekly export, flags cases priced on the older one, and never rebuilds a recommendation", () => {
  const { world, decision, config } = syncedWorld([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 1, status: "chased", evidence_ids: ["rfq"] }]);
  const before = readManifest(config.storeDir).current;
  const decisionFile = path.join(config.outputsDir, `CLAUDE-DECISION-${decision.caseId}-v1.json`);
  const recommendation = fs.readFileSync(decisionFile, "utf8");
  const rows = Array.from({ length: 9 }, (_, index) => routerRow({ wo: `${6000 + index}WA`, received: "09/25/2026" }));
  writeRouterExport(world.options.routerFolder, "092826 - LineItems_with_RouterHistory.xlsx", rows);

  const first = runSync({ config, limits: undefined, trigger: "test" });
  assert.deepEqual(first.errors, []);
  assert.equal(first.imports.length, 1);
  assert.equal(first.imports[0].fileName, "092826 - LineItems_with_RouterHistory.xlsx");
  assert.notEqual(readManifest(config.storeDir).current, before);
  assert.equal(fs.readFileSync(decisionFile, "utf8"), recommendation);
  const board = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, storeDir: config.storeDir });
  assert.equal(board.cases[0].staleSnapshot, true);
  assert.match(renderBoard(board), /newer Router History is in\. Ask to rebuild\./);

  const second = runSync({ config, trigger: "test" });
  assert.deepEqual(second.imports, []);
  assert.equal(readLastSync(config).at, second.at);
  assert.equal(fs.readFileSync(config.syncLog, "utf8").trim().split("\n").length, 2);
});

test("a page links to a monitor entry only on customer, full part number and revision, and never guesses between two", () => {
  const entry = (customer, reference, evidence = ["rfq"]) => ({ customer, reference, priority_section: 1, status: "RFQ chased", evidence_ids: evidence });
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-100 Rev B")]).cases[0].monitor.reference, "77 / ABC-100 Rev B");
  assert.equal(boardFor([entry("Other Aerospace", "77 / ABC-100 Rev B")]).cases[0].monitor, null);
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-100 Rev C")]).cases[0].monitor, null);
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-10")]).cases[0].monitor, null);
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-1000")]).cases[0].monitor, null);
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-100-1 Rev B")]).cases[0].monitor, null);
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-100 Rev B", ["some-other-email"])]).cases[0].monitor, null);
  const twice = boardFor([entry("Acme Precision Corp", "PO1 / ABC-100"), entry("Acme Precision Corp", "PO2 / ABC-100")]).cases[0];
  assert.equal(twice.monitor, null);
  assert.deepEqual(twice.monitorAmbiguous, ["PO1 / ABC-100", "PO2 / ABC-100"]);
  assert.match(renderBoard(boardFor([entry("Acme Precision Corp", "PO1 / ABC-100"), entry("Acme Precision Corp", "PO2 / ABC-100")])), /Monitor link unresolved: 2 entries match/);
});

test("section 1 is grouped by the monitor's status wording without hiding any row, and missing dates read as unknown", () => {
  const board = boardFor([
    { customer: "Beta", reference: "RFQ 12", priority_section: 1, status: "New RFQ; no response found" },
    { customer: "Gamma", reference: "PO 55", priority_section: 1, status: "PO acknowledgment unverified", explicit_due_date: "2026-09-25", due_basis: "Customer asked for PO acknowledgment" },
  ]);
  const html = renderBoard(board);
  assert.deepEqual(board.monitor.withoutPage.map((item) => [item.customer, item.pricing]), [["Beta", true], ["Gamma", false]]);
  assert.match(html, /Status mentions a quote, RFQ or inquiry <small>1<\/small>/);
  assert.match(html, /Status doesn&#39;t say \(may be a follow-up or an RFQ\) <small>1<\/small>/);
  assert.match(html, /Beta<\/span><div class="why-not">RFQ 12/);
  assert.match(html, /Gamma<\/span><div class="why-not">PO 55/);
  assert.match(html, /<td class="date">unknown<\/td>/);
  assert.match(html, /Customer asked for PO acknowledgment/);
});

test("a decision for one RFQ number never links to another RFQ for the same customer, part and revision", () => {
  const decision = { customer: { name: "Acme Corporation", aliases: ["ACME"] }, rfq: { reference: "ACME RFQ #4100", sourceMessageIds: ["m1"] }, lines: [{ request: { partNumber: "ABC-100", revision: "1", aliases: [] } }] };
  const other = { customer: "Acme", reference: "9999 / ABC-100 Rev1", evidence_ids: ["m1"] };
  const right = { customer: "Acme", reference: "4100 / ABC-100 Rev1", evidence_ids: ["m1"] };
  const rightNumberOtherEmail = { customer: "Acme", reference: "4100 / ABC-100 Rev1", evidence_ids: ["m2"] };
  assert.equal(monitorLink(decision, [other]).entry, null);
  assert.equal(monitorLink(decision, [other, right]).entry, right);
  assert.equal(monitorLink(decision, [rightNumberOtherEmail]).entry, null, "an agreeing RFQ number is not enough without a shared email");
  const noEmails = { ...decision, rfq: { reference: "ACME RFQ #4100" } };
  assert.equal(monitorLink(noEmails, [rightNumberOtherEmail]).entry, rightNumberOtherEmail, "with no case emails, the RFQ number decides");  const noNumber = { ...decision, rfq: { reference: "Email RFQ, no RFQ number assigned in checked sources", sourceMessageIds: ["m1"] } };
  assert.equal(monitorLink(noNumber, [other]).entry, other, "a reference without an RFQ number falls back to the shared email");
});

test("only status wording that plainly says a quote went out counts as sent", () => {
  for (const status of ["Quote sent; waiting on customer", "Quote already sent; internal part identification added", "Pat sent estimated quote; waiting on customer", "Sam sent quote attachment; contents unverified", "Quote sent; attachment scope unverified", "Sam quote sent; customer thanked QPC"]) {
    assert.equal(quoteSentStatus(status), true, status);
  }
  for (const status of ["not quoted", "quoted per ledger; unverified", "Quote sent; unverified", "Quote will be sent tomorrow", "Quote to be sent after approval", "Quote scheduled to be sent Monday", "Awaiting approval before quote sent", "Customer PO received and acknowledged", "QPC reports ready for pickup September25 13:30", "Draft quote prepared", "", null]) {
    assert.equal(quoteSentStatus(status), false, String(status));
  }
});

test("a failed import keeps the last good history and puts an alert on the board", () => {
  const { world, config } = syncedWorld([]);
  const before = readManifest(config.storeDir).current;
  const broken = path.join(world.options.routerFolder, "092826 - LineItems_with_RouterHistory.xlsx");
  fs.writeFileSync(broken, workbookBuffer({ Wrong: [["NOT", "THE", "HEADERS"], ["x", "y", "z"]] }));
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(broken, old, old);
  const record = runSync({ config, trigger: "test" });
  assert.equal(record.imports[0].outcome, "rejected");
  assert.equal(readManifest(config.storeDir).current, before);
  const html = fs.readFileSync(record.board.file, "utf8");
  assert.match(html, /class="status alert">Router History export 092826 - LineItems_with_RouterHistory\.xlsx was rejected/);
  assert.match(html, /Prices still use the last good snapshot/);
});

test("a stopped monitor shows as stale even when its own file says it is fresh, and the page checks its own age", () => {
  const { config } = syncedWorld([]);
  const state = JSON.parse(fs.readFileSync(config.monitorState, "utf8"));
  fs.writeFileSync(config.monitorState, JSON.stringify({ ...state, freshness: { source_cutoff: "2026-09-28T03:00:00Z", stale: false } }));
  const fresh = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, now: new Date("2026-09-28T04:00:00Z") });
  assert.equal(fresh.monitor.stale, false);
  assert.ok(!renderBoard(fresh).includes("Mail data is STALE"));
  const stopped = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, now: new Date("2026-09-28T06:00:00Z") });
  assert.equal(stopped.monitor.stale, true);
  const html = renderBoard(stopped);
  assert.match(html, /Mail data is STALE: the monitor&#39;s last successful check was/);
  assert.match(html, /const generated = Date\.parse\("2026-09-28T06:00:00\.000Z"\)/);
  assert.match(html, /The pricing sync or this Mac may have stopped/);
});

test("an export OneDrive has not downloaded is reported as waiting, not read and failed", () => {
  const { world, config } = syncedWorld([]);
  const before = readManifest(config.storeDir).current;
  const file = writeRouterExport(world.options.routerFolder, "092826 - LineItems_with_RouterHistory.xlsx", [routerRow({ received: "09/25/2026" })]);
  const cloudOnly = (target) => (target === file ? { size: 1000, blocks: 0 } : fs.statSync(target));
  assert.equal(isCloudOnly(file, cloudOnly), true);
  assert.equal(isCloudOnly(file), false);
  const record = runSync({ config, trigger: "test", statFile: cloudOnly });
  assert.deepEqual(record.imports, [{ fileName: "092826 - LineItems_with_RouterHistory.xlsx", outcome: "not-downloaded", failures: [] }]);
  assert.deepEqual(record.errors, []);
  assert.equal(readManifest(config.storeDir).current, before);
  assert.match(fs.readFileSync(record.board.file, "utf8"), /is in OneDrive but not downloaded to this Mac/);
});

test("the board shows the plan and a dated history that merges the session log with recorded events", () => {
  const { config } = syncedWorld([]);
  const trackerPath = path.join(config.outputsDir, "tracker.json");
  fs.writeFileSync(trackerPath, JSON.stringify({
    workingTowards: [{ status: "now", title: "Price the next batch", detail: "Section-1 requests", since: "2026-09-28" }, { status: "done", title: "Old item" }],
    history: [{ at: "2026-09-27", kind: "ruling", text: "Lot minimum is per PO" }],
  }));
  const board = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, storeDir: config.storeDir, trackerPath });
  assert.equal(board.plan.length, 2);
  assert.deepEqual(board.history.map((item) => item.kind), ["priced", "ruling"], "newest first; the page build comes from the record");
  const html = renderBoard(board);
  assert.match(html, /<h2 id="plan-title">Working towards<\/h2><span class="count">1<\/span>/);
  assert.match(html, /Working on now[\s\S]*Price the next batch/);
  assert.match(html, /<h2 id="history-title">History<\/h2>[\s\S]*Lot minimum is per PO/);
  assert.equal(buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState }).plan.length, 0, "no tracker file, no plan panel");
});

test("each case and unpriced RFQ links to its RFQ email in Outlook", () => {
  const board = boardFor([
    { customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 1, status: "New RFQ", evidence_ids: ["rfq"], evidence_links: ["https://outlook.example/rfq"] },
    { customer: "Other Co", reference: "RFQ9", priority_section: 1, status: "New RFQ", evidence_ids: ["AAMk_a-b="] },
  ]);
  assert.ok(board.cases[0].rfqLink);
  const other = board.monitor.withoutPage.find((item) => item.customer === "Other Co");
  assert.equal(other.rfqLink, "https://outlook.office365.com/owa/?ItemID=AAMk%2Ba%2Fb%3D&exvsurl=1&viewmodel=ReadMessageItem");
  assert.match(renderBoard(board), /Open RFQ email/);
});

test("rows show the company, the sender and the email subject of the original RFQ email", () => {
  const { config } = syncedWorld([
    { customer: "Other Co", reference: "RFQ9", priority_section: 1, status: "New RFQ", evidence_ids: ["later", "first"], events: [{ at: "2026-09-20T00:00:00Z", actor: "fallback@other.example" }] },
    { customer: "Uncached Co", reference: "RFQ10", priority_section: 1, status: "New RFQ", evidence_ids: ["none"], events: [{ at: "2026-09-21T00:00:00Z", actor: "buyer@uncached.example" }] },
  ]);
  const mailCachePath = path.join(config.outputsDir, "mail.json");
  fs.writeFileSync(mailCachePath, JSON.stringify({ messages: {
    first: { subject: "RFQ 9 for brackets", from: "pat@other.example", fromName: "Pat Buyer", receivedAt: "2026-09-19T10:00:00Z" },
    later: { subject: "RE: RFQ 9 for brackets", from: "pat@other.example", fromName: "Pat Buyer", receivedAt: "2026-09-22T10:00:00Z" },
  } }));
  const board = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, mailCachePath });
  const other = board.monitor.withoutPage.find((item) => item.customer === "Other Co");
  assert.deepEqual(other.email, { from: "pat@other.example", fromName: "Pat Buyer", subject: "RFQ 9 for brackets" });
  const uncached = board.monitor.withoutPage.find((item) => item.customer === "Uncached Co");
  assert.deepEqual(uncached.email, { from: "buyer@uncached.example", fromName: null, subject: null });
  assert.ok(board.cases[0].email.from, "a case shows its RFQ sender from the saved evidence");
  const html = renderBoard(board);
  assert.match(html, /Pat Buyer<\/span><div class="why-not">pat@other.example/);
  assert.match(html, /RFQ 9 for brackets/);
});

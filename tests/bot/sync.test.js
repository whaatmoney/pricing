import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { progressHtml } from "../../bot/lib/design.js";
import { buildBoard, caseGroup, confidenceRank, latestMessageLink, mirrorPages, monitorLink, progressOf, quoteSentStatus, readBrandBadge, renderBoard, writeBoard } from "../../bot/lib/board.js";
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
  assert.match(html, /<article class="card [^"]+" id="case-[^"]+" data-page="[^"]+" data-case="[^"]+" data-asked="\d{4}-\d{2}-\d{2}/, "cards carry an anchor, the RFQ id and the ask date");
  assert.doesNotMatch(html, /<ol class="tracker"[\s\S]*?<\/article>[\s\S]*id="ready"/, "no full tracker before the open groups");
  assert.match(html, /class="done-box"/);
  assert.doesNotMatch(html, /note-box|note-toggle/, "no notes on the board");
  assert.match(html, /class="toast"/, "copy feedback has a toast to show");
  assert.match(html, /data-sort="newest"[^>]*>Newest first/);
  assert.match(html, /data-sort="confident"[^>]*>Most confident<\/button><button type="button" data-sort="unsure"[^>]*>Least confident/);
  assert.match(html, /data-case="[^"]+" data-asked="[^"]*" data-confidence="[0-3]"/, "cards carry a confidence sort key");
});

test("confidence sort key: High 3, Medium 2, Low 1, and 0 while a line has no price", () => {
  const priced = [{ suggested: 8, decided: null }];
  assert.equal(confidenceRank({ lines: priced, confidence: { level: "High" } }), 3);
  assert.equal(confidenceRank({ lines: priced, confidence: { level: "Medium" } }), 2);
  assert.equal(confidenceRank({ lines: priced, confidence: { level: "Low" } }), 1);
  assert.equal(confidenceRank({ lines: [...priced, { suggested: null, decided: null }], confidence: { level: "Low" } }), 0);
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

test("a page links to a monitor entry on customer and full part number whatever the revision, and never guesses between two", () => {
  const entry = (customer, reference, evidence = ["rfq"]) => ({ customer, reference, priority_section: 1, status: "RFQ chased", evidence_ids: evidence });
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-100 Rev B")]).cases[0].monitor.reference, "77 / ABC-100 Rev B");
  assert.equal(boardFor([entry("Other Aerospace", "77 / ABC-100 Rev B")]).cases[0].monitor, null);
  assert.equal(boardFor([entry("Acme Precision Corp", "77 / ABC-100 Rev C")]).cases[0].monitor.reference, "77 / ABC-100 Rev C", "revision is not compared");
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

test("the monitor's shortened customer name links only with the exact reference the case names", () => {
  const decision = { customer: { name: "Acme Precision Corporation (Acme CNC LLC)", aliases: ["ACME PRECISION CORP"] }, rfq: { reference: "Acme RFQ 10735", monitorReference: "10735" }, lines: [] };
  const short = { customer: "Acme", reference: "10735" };
  assert.equal(monitorLink(decision, [short]).entry, short, "every word of the monitor's name is in the case's name");
  assert.equal(monitorLink(decision, [{ customer: "Acme", reference: "10736" }]).entry, null, "a different reference never links");
  assert.equal(monitorLink(decision, [{ customer: "Acme Aerospace", reference: "10735" }]).entry, null, "a word the case's names lack blocks the link");
  assert.equal(monitorLink({ ...decision, customer: { name: "Other Co", aliases: [] } }, [short]).entry, null);
});

test("the board links the newest sent or received message in the thread, never a draft", () => {
  const entry = { evidence_ids: ["m1", "m2", "m3"], evidence_links: ["L1", "L2", "L3"], events: [
    { at: "2026-09-01T10:00:00Z", message_id: "m1" }, { at: "2026-09-03T10:00:00Z", message_id: "m2", actor: "pat@shop.example" }, { at: "2026-09-04T10:00:00Z", message_id: "m3", is_draft: true }] };
  assert.deepEqual(latestMessageLink(entry, "L1"), { href: "L2", at: "2026-09-03T10:00:00Z", actor: "pat@shop.example" });
  assert.equal(latestMessageLink({ ...entry, events: entry.events.slice(0, 1) }, "L1"), null, "no separate button when the newest message is the RFQ itself");
  assert.equal(latestMessageLink(null, "L1"), null);
});

test("progress runs RFQ in -> Priced -> Decided -> Quote sent, with partial steps named", () => {
  const decision = { rfq: { initiatedAt: "2026-09-01T10:00:00Z" }, generatedAt: "2026-09-02T10:00:00Z" };
  const line = (suggested, decided = null) => ({ suggested, decided });
  const labels = (steps) => steps.map((step) => (step.done ? step.label : `(${step.pending})`)).join(" > ");
  assert.equal(labels(progressOf({ decision, lines: [line(null), line(null)], sent: false })), "RFQ in > (Needs facts) > (Your decision) > (Quote sent)");
  assert.equal(labels(progressOf({ decision, lines: [line(8), line(null)], sent: false })), "RFQ in > (Priced 1 of 2) > (Your decision) > (Quote sent)");
  const approved = { choice: "approved", unitPrice: 8, decidedAt: "2026-09-03T10:00:00Z" };
  const steps = progressOf({ decision, lines: [line(8, approved), line(9)], sent: false });
  assert.equal(labels(steps), "RFQ in > Priced > (Decided 1 of 2) > (Quote sent)");
  const monitor = { events: [{ at: "2026-09-04T10:00:00Z", meaning: "Draft ready" , is_draft: true }, { at: "2026-09-05T10:00:00Z", meaning: "Quote sent; waiting on customer" }], last_observed_activity_at: "2026-09-09T10:00:00Z" };
  const done = progressOf({ decision, lines: [line(8, approved), line(null, { ...approved, decidedAt: "2026-09-04T10:00:00Z" })], monitor, sent: true });
  assert.equal(labels(done), "RFQ in > Priced > Decided > Quote sent");
  assert.deepEqual(done.map((step) => step.at), ["2026-09-01T10:00:00Z", "2026-09-02T10:00:00Z", "2026-09-04T10:00:00Z", "2026-09-05T10:00:00Z"]);
  const mini = progressHtml(progressOf({ decision, lines: [line(null)], sent: false }), { compact: true });
  assert.match(mini, /<span class="tracker-mini warn" title="RFQ in [^"]+ → Needs facts \(now\) → Your decision → Quote sent"/, "the compact tracker names every step in its tooltip");
  assert.match(mini, /<span class="mini-label">Needs facts<\/span>/);
  assert.equal((mini.match(/mini-dot/g) || []).length, 4);
});

test("only status wording that plainly says a quote went out counts as sent", () => {
  for (const status of ["Quote sent; waiting on customer", "Quote already sent; internal part identification added", "Pat sent estimated quote; waiting on customer", "Sam sent quote attachment; contents unverified", "Quote sent; attachment scope unverified", "Sam quote sent; customer thanked QPC", "Customer confirmed quote receipt", "Customer confirmed receipt of the quote", "Quote receipt acknowledged by buyer", "Prior quote confirmed valid in customer-facing response"]) {
    assert.equal(quoteSentStatus(status), true, status);
  }
  for (const status of ["not quoted", "quoted per ledger; unverified", "Quote sent; unverified", "Quote will be sent tomorrow", "Quote to be sent after approval", "Quote scheduled to be sent Monday", "Awaiting approval before quote sent", "Customer PO received and acknowledged", "QPC reports ready for pickup September25 13:30", "Draft quote prepared", "Customer has not confirmed quote receipt", "Quote receipt unconfirmed", "Customer confirmed PO receipt", "Prior quote not confirmed valid in customer-facing response", "Quote confirmed valid internally", "Receipt reported; ECD October8", "", null]) {
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
  assert.ok(!renderBoard(fresh).includes("data is STALE"));
  const stopped = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, now: new Date("2026-09-28T06:00:00Z") });
  assert.equal(stopped.monitor.stale, true);
  const html = renderBoard(stopped);
  assert.match(html, /Codex mail monitor data is STALE: its last successful check was/);
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

test("the board's log holds a dated history that merges the session log with recorded events", () => {
  const { config } = syncedWorld([]);
  const trackerPath = path.join(config.outputsDir, "tracker.json");
  fs.writeFileSync(trackerPath, JSON.stringify({ history: [{ at: "2026-09-27", kind: "ruling", text: "Lot minimum is per PO" }] }));
  const board = buildBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, storeDir: config.storeDir, trackerPath });
  assert.deepEqual(board.history.map((item) => item.kind), ["priced", "ruling"], "newest first; the page build comes from the record");
  assert.match(renderBoard(board), /<h3 id="history-title">History <small>2<\/small><\/h3>[\s\S]*Lot minimum is per PO/);
});

test("open cases split into ready-for-your-yes and needs-facts, soonest due first, naming the missing fact", () => {
  const board = boardFor([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 1, status: "New RFQ", evidence_ids: ["rfq"], explicit_due_date: "2026-09-28" }]);
  const [kase] = board.cases;
  const priced = { ...kase, lines: kase.lines.map((line) => ({ ...line, suggested: 8.5 })) };
  const blocked = { ...kase, caseId: "B", customer: "Beta Corp", dueDate: null, lines: kase.lines.map((line) => ({ ...line, suggested: null, missing: "part size (L × W × H)" })) };
  assert.equal(caseGroup(priced), "ready");
  assert.equal(caseGroup(blocked), "facts");
  assert.equal(caseGroup({ ...kase, open: false, tone: "ok", state: "Quote sent (per monitor status)" }), "sent");
  const html = renderBoard({ ...board, generatedAt: "2026-09-28T18:00:00Z", cases: [blocked, priced] });
  assert.match(html, /id="ready"[\s\S]*Acme &lt;Precision&gt; Corp\.[\s\S]*Due today[\s\S]*id="facts"[\s\S]*Beta Corp[\s\S]*Needs part size \(L × W × H\)/);
  assert.match(html, /<b>1<\/b> ready for your yes/);
  assert.ok(!html.includes("Working towards"), "the plan lives in the RFQ Pricing list, not on the board");
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

test("the company badge comes from a private file, is embedded as an image, and is optional", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "badge-"));
  const badge = path.join(dir, "badge.svg");
  fs.writeFileSync(badge, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>');
  const uri = readBrandBadge(badge);
  assert.match(uri, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
  fs.writeFileSync(path.join(dir, "not.svg"), "<html><script>alert(1)</script></html>");
  assert.equal(readBrandBadge(path.join(dir, "not.svg")), null, "only an SVG is used");
  assert.equal(readBrandBadge(null), null);
  const board = boardFor([]);
  assert.match(renderBoard(board, { badge: uri }), /<img class="badge" src="data:image\/svg\+xml;base64,/);
  assert.ok(!renderBoard(board).includes('class="badge"'), "no badge configured, no image");
});

test("the pages mirror gets the board and current pages, updates only what changed, and drops superseded versions", () => {
  const { config } = syncedWorld([]);
  const { board } = writeBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, storeDir: config.storeDir });
  const [kase] = board.cases;
  fs.writeFileSync(path.join(config.outputsDir, kase.page), "<html>page</html>");
  const mirrorDir = path.join(config.outputsDir, "mirror");
  const first = mirrorPages({ outputsDir: config.outputsDir, mirrorDir, board });
  assert.deepEqual(first.copied.sort(), ["CLAUDE-DECISIONS-OPEN.html", kase.page].sort());
  assert.deepEqual(mirrorPages({ outputsDir: config.outputsDir, mirrorDir, board }).copied, [], "unchanged files are not rewritten");
  fs.writeFileSync(path.join(mirrorDir, "CLAUDE-DECISION-OLD-CASE-v1.html"), "old");
  fs.writeFileSync(path.join(mirrorDir, "notes.txt"), "someone else's file");
  const again = mirrorPages({ outputsDir: config.outputsDir, mirrorDir, board });
  assert.deepEqual(again.removed, ["CLAUDE-DECISION-OLD-CASE-v1.html"]);
  assert.ok(fs.existsSync(path.join(mirrorDir, "notes.txt")), "only mirrored page files are ever removed");
  assert.ok(fs.existsSync(path.join(config.outputsDir, kase.page)), "originals stay");
});

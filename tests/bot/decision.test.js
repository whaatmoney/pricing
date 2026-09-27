import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildDecision } from "../../bot/lib/decision.js";
import { renderHtml, renderMarkdown } from "../../bot/lib/render.js";
import { importSnapshot } from "../../bot/lib/router-snapshot.js";
import { nextVersion } from "../../bot/lib/versioning.js";
import { CALCULATOR_HTML, purchaseOrderText, routerRow, tempDir, workbookBuffer, writeRouterExport, writeRulesPackage } from "./helpers.js";

// One synthetic RFQ world that contains every trap the handoff lists:
// another customer on the same P/N, a longer token, changed revision, changed
// process, returned work, a lot-priced PO, an old quoted estimate, an internal
// forward, a quantity alternative and a line with no usable inputs.
function buildWorld() {
  const root = tempDir("qpc-world-");
  const folder = path.join(root, "router");
  const store = path.join(root, "store");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(folder);
  fs.mkdirSync(evidence);
  const router = [
    routerRow({ wo: "5001WA", description: "P/N: ABC-100 REV. B\nWO NO: W1-100" }),
    routerRow({ wo: "5002WA", customer: "OTHER AEROSPACE INC", price: 5 }),
    routerRow({ wo: "5003WA", description: "P/N: ABC100X REV. B", price: 6 }),
    routerRow({ wo: "4001WA", received: "01/10/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-090", price: 7.5, special: "FOR OXYGEN SERVICE" }),
    routerRow({ wo: "5001WA", description: "P/N: ABC-100 REV. B\nWO NO: W1-100\n**RETURN TO CUSTOMER**", price: 4.25 }),
    routerRow({ wo: "3001WA", received: "03/01/2026", description: "P/N: ABC-100 REV. C\nWO NO: W1-080", price: 9 }),
    routerRow({ wo: "2001WA", received: "02/01/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-070", price: 8, process: "CLEAN PER CC1246 LEVEL 100" }),
    routerRow({ wo: "1001WA", received: "12/01/2025", description: "P/N: ABC-100 REV. B\nWO NO: W1-060", price: 6 }),
  ];
  const exportFile = writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", router);
  assert.equal(importSnapshot(exportFile, { storeDir: store }).outcome, "accepted");

  const sales = path.join(root, "sales.xlsx");
  fs.writeFileSync(sales, workbookBuffer({ Sheet1: [
    ["SERVICE", "DATE", "INVOICE", "CUSTOMER", "DESCRIPTION", "QTY", "UNIT PRICE"],
    ["Cleaning", "12/05/2025", "INV-1", "Acme <Precision> Corp.", "P/N: ABC-100 REV. B\nWO NO: W1-060\nLEVEL 300R4 NOT FOR OXYGEN SERVICE", 400, 7.5],
  ] }));

  const rulesDir = writeRulesPackage(fs.mkdtempSync(path.join(root, "rules-")));
  const calculatorHtml = path.join(root, "calculator.html");
  fs.writeFileSync(calculatorHtml, CALCULATOR_HTML);

  const customerMail = { from: "buyer@acme.example", to: ["sales@qpc.example"], cc: [], bodyFormat: "text", attachments: [], mailbox: "sales@qpc.example" };
  fs.writeFileSync(path.join(evidence, "messages.json"), JSON.stringify({
    searchQueries: ["ABC-100"],
    messages: [
      { ...customerMail, id: "rfq", subject: "RFQ ABC-100", receivedAt: "2026-09-24T12:00:00Z", webLink: "https://mail.example/rfq", body: "Can you please provide pricing for:\nABC-100 Rev. B\nQty: 500\nCLEAN PER CC1246 LEVEL 300R4 NOT FOR OXYGEN SERVICE" },
      { ...customerMail, id: "po", subject: "PO1-100", receivedAt: "2026-05-27T12:00:00Z", webLink: "https://mail.example/po", body: "Please see attached PO", attachments: [{ name: "PO1-100.pdf", text: purchaseOrderText() }] },
      { ...customerMail, id: "lot-po", subject: "PO1-200", receivedAt: "2026-06-15T12:00:00Z", webLink: "https://mail.example/lot", body: "Please see attached PO", attachments: [{ name: "PO1-200.pdf", text: purchaseOrderText({ po: "PO1-200", uom: "Lot", unit: "350.00", extended: "350.00", quantity: 1, job: "W1- 110" }) }] },
      { id: "estimate", mailbox: "sales@qpc.example", subject: "Re: Pricing for Oxygen Service", from: "e@qpc.example", to: ["buyer@acme.example"], cc: [], receivedAt: "2026-02-27T12:00:00Z", webLink: "https://mail.example/est", bodyFormat: "text", attachments: [], body: "Without oxygen service, see the estimated pricing below:\nABC-100 | 5000 | $7.00\n\n* * *\n\n**From:** Estimator\n**Sent:** Monday\n\nFor oxygen service:\nABC-100 | 5000 | $9.00" },
      { id: "internal", mailbox: "sales@qpc.example", subject: "fwd ABC-100", from: "e@qpc.example", to: ["jay@qpc.example"], cc: [], receivedAt: "2026-02-20T12:00:00Z", webLink: "https://mail.example/int", bodyFormat: "text", attachments: [], body: "ABC-100 | 500 | $6.00" },
    ],
  }));
  fs.writeFileSync(path.join(evidence, "search-log.json"), JSON.stringify({ searchedAt: "2026-09-27T00:00:00Z", searches: [{ mailbox: "sales@qpc.example", query: "ABC-100", results: 5, complete: true }], gaps: ["Synthetic gap"] }));

  const sq1 = {
    category: { value: 4 },
    envelope: { length: 0.7, width: 0.7, height: 0.12, flag: "DIM: DRAWING" },
    geometry: { class: "Minimal", confidence: "MED" },
    cavities: { counts: { A: 0, B: 0, C: 0, D: 0 }, confidence: "MED" },
    cleanliness: { level: "300", flag: "CLN" },
    specGroup: { flag: "FEE: $0" },
    aclar: { required: false, flag: "ACLAR: N" },
    weight: { flag: "WT: NOT PROVIDED" },
    lengthSurcharge: { amount: 0, basis: "test" },
    specFee: { amount: 0, basis: "test" },
  };
  const sq3 = { batch: { size: 100, basis: "assumed", reason: "test" }, steps: [{ step: "setup", router: "-", class: "LOT", minutes: 60, basis: "estimate" }, { step: "handle", router: "-", class: "PER-PART", minutes: 0.5, basis: "estimate" }], measuredTimeSearch: "none" };
  const shared = { revision: "B", uom: "EA", currency: "USD", scope: { oxygen: "not-for", level: "300R4" }, process: { verbatim: "LEVEL 300R4 NOT FOR OXYGEN SERVICE", source: "rfq" }, material: { value: "A286", source: "test" }, drawing: { number: "1", revision: "B", title: "SEAL", caveat: "test", dimensions: { maxOdAfterCoating: 0.7, F_max: 0.12, source: "test" } }, packaging: { requirement: "bag", sources: ["test"], status: "extracted" }, sq1, sq3, sq5Anchor: { choice: "SQ2", reason: "test" }, calculator: { process: "300" } };
  const casePath = path.join(root, "case.json");
  fs.writeFileSync(casePath, JSON.stringify({
    caseId: "TEST-ABC-100",
    mode: "FIRST-PASS",
    customer: { name: "Acme <Precision> Corp.", aliases: ["ACME PRECISION CORP"], emailDomains: ["acme.example"] },
    internalDomains: ["qpc.example"],
    rfq: { initiatedAt: "2026-09-24T12:00:00Z", initiatedBy: "buyer@acme.example", latestAskAt: "2026-09-24T12:00:00Z", latestAskSummary: "RFQ", lastQpcResponse: "none", urgency: null },
    evidence: { messages: "evidence/messages.json", searchLog: "evidence/search-log.json" },
    lines: [
      { lineId: "L1", partNumber: "ABC-100", aliases: [], description: "Seal", quantity: 500, ...shared },
      { lineId: "L2", partNumber: "ABC-100", aliases: [], description: "Seal", quantity: 5000, ...shared },
      { lineId: "L3", partNumber: "DEF-200", aliases: [], description: "Unknown part", quantity: 10, ...shared, sq1: { ...sq1, envelope: { length: 0, width: 0, height: 0 } }, sq3: { ...sq3, steps: [] } },
    ],
    recommendationPolicy: "repeat-accepted-hold-v0",
  }));
  const options = { casePath, storeDir: store, routerFolder: folder, salesExportPath: sales, priceLabDir: rulesDir, calculatorHtml, now: new Date("2026-09-27T12:00:00Z") };
  return { root, exportFile, store, options };
}

const world = buildWorld();
const decision = buildDecision(world.options);
const [l1, l2, l3] = decision.lines;
const byEvidence = (line, text) => line.history.timeline.filter((entry) => entry.evidence.includes(text));

test("the accepted PO for the same part, revision, scope and quantity band leads, with the chain beside it", () => {
  assert.equal(l1.recommendation.preferred.unitPrice, 8.5);
  assert.match(l1.recommendation.preferred.basis, /PO1-100/);
  assert.equal(l1.recommendation.alternatives[0].unitPrice, l1.calculations.sq5.settled);
  assert.equal(l1.recommendation.lotMinimum.passes, true);
});

test("another customer's record and a longer part token never enter the history", () => {
  assert.equal(l1.history.database.summary.otherCustomer, 1);
  assert.equal(l1.history.database.summary.partialToken, 1);
  assert.equal(byEvidence(l1, "5002WA").length, 0);
  assert.equal(byEvidence(l1, "5003WA").length, 0);
});

test("changed revision, changed process, oxygen scope and returned work are shown but not used", () => {
  assert.equal(byEvidence(l1, "3001WA")[0].status, "different");
  assert.deepEqual(byEvidence(l1, "3001WA")[0].differences, ["revision C vs B"]);
  assert.deepEqual(byEvidence(l1, "2001WA")[0].differences, ["level 100 vs 300R4"]);
  assert.equal(byEvidence(l1, "4001WA")[0].status, "different");
  const workOrder = byEvidence(l1, "5001WA");
  assert.deepEqual(workOrder.map((entry) => entry.status).sort(), ["comparable", "excluded"]);
});

test("a lot-priced PO is not compared with a per-each request", () => {
  const lot = byEvidence(l1, "PO1-200")[0];
  assert.equal(lot.status, "different");
  assert.ok(lot.differences.includes("unit of measure LOT vs EA"));
});

test("an old quoted price and an internal forward never become quote evidence", () => {
  const estimates = l1.history.timeline.filter((entry) => entry.source === "QPC sent estimate");
  assert.deepEqual(estimates.map((entry) => entry.unitPrice), [7]);
  assert.ok(estimates[0].notes.some((note) => /subject line/.test(note)));
  assert.equal(l1.history.email.evidence.find((email) => email.id === "internal").type, "internal");
  assert.equal(l1.history.timeline.some((entry) => entry.unitPrice === 6 && entry.source !== "Work order (Router History)"), false);
});

test("PO, work order and invoice are cross-checked by the customer's job number", () => {
  const job100 = l1.history.jobs.find((job) => job.job === "W1-100");
  assert.equal(job100.agree, true);
  const job060 = l1.history.jobs.find((job) => job.job === "W1-060");
  assert.equal(job060.agree, false);
  assert.deepEqual(job060.prices.sort(), [6, 7.5]);
});

test("a quantity alternative is priced as its own line", () => {
  assert.equal(l2.recommendation.repeatCandidates.length, 0);
  assert.equal(l2.recommendation.preferred.label, "Price Lab chain (SQ5, SQ6 pending)");
  assert.equal(byEvidence(l2, "e@qpc.example")[0].status, "unverified");
});

test("a line without usable inputs stays uncalculated and says why", () => {
  assert.equal(l3.recommendation.preferred, null);
  assert.match(l3.recommendation.uncalculated, /missing facts/);
  assert.match(l3.calculations.sq2.blocked[0], /Envelope/);
});

test("replaying the export and rebuilding gives the same inputs fingerprint and version", () => {
  assert.equal(importSnapshot(world.exportFile, { storeDir: world.store }).outcome, "replay-noop");
  assert.equal(buildDecision(world.options).inputsFingerprint, decision.inputsFingerprint);
  const outputs = tempDir();
  const stem = "CLAUDE-DECISION-TEST";
  fs.writeFileSync(path.join(outputs, `${stem}-v1.json`), JSON.stringify({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } }));
  assert.deepEqual(nextVersion(outputs, stem, decision.inputsFingerprint), { version: 1, reused: true, supersedes: null });
  assert.deepEqual(nextVersion(outputs, stem, "changed"), { version: 2, reused: false, supersedes: 1 });
});

test("the review page escapes source text and never claims approval", () => {
  decision.lifecycle.recommendationVersion = 1;
  const html = renderHtml(decision);
  assert.ok(html.includes("Acme &lt;Precision&gt; Corp."));
  assert.ok(!html.includes("<Precision>"));
  const markdown = renderMarkdown(decision);
  assert.match(markdown, /RECOMMENDATION ONLY — not approved, not sent/);
  assert.match(markdown, /Recommend \$8\.50\/ea/);
});

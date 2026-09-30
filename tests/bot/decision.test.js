import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildDecision, customerWorkOrder } from "../../bot/lib/decision.js";
import { renderHtml, renderMarkdown, summarizeLine } from "../../bot/lib/render.js";
import { importSnapshot } from "../../bot/lib/router-snapshot.js";
import { nextVersion } from "../../bot/lib/versioning.js";
import { buildWorld, tempDir } from "./helpers.js";

const world = buildWorld();
const decision = buildDecision(world.options);
const [l1, l2, l3] = decision.lines;
const byEvidence = (line, text) => line.history.timeline.filter((entry) => entry.evidence.includes(text));

test("the accepted PO for the same part, revision, scope and quantity band leads, with the chain beside it", () => {
  assert.equal(l1.recommendation.preferred.unitPrice, 8.5);
  assert.match(l1.recommendation.preferred.basis, /PO1-100/);
  assert.equal(l1.recommendation.alternatives.find((option) => option.label.startsWith("Price Lab chain")).unitPrice, l1.calculations.sq5.settled);
  assert.ok(l1.recommendation.alternatives.some((option) => option.basis.startsWith("PREVIOUS-QUOTE")), "an accepted PO outranks a previous quote, which is shown beside it");
  assert.equal(l1.recommendation.lotMinimum, undefined, "with more than one part the lot minimum is checked on the PO, not the line");
  assert.equal(l1.recommendation.preferred.lotCharge, undefined);
  assert.deepEqual(decision.poLotMinimum, { ruling: "lot-minimum-per-po-v1", lineIds: ["L1", "L3"], unpriced: ["L3"], extended: 4250, minimum: 200, passes: true, lotCharge: null });
});

test("another customer's record and a longer part token never enter the history", () => {
  assert.equal(l1.history.database.summary.otherCustomer, 1);
  assert.equal(l1.history.database.summary.partialToken, 1);
  assert.equal(byEvidence(l1, "5002WA").length, 0);
  assert.equal(byEvidence(l1, "5003WA").length, 0);
});

test("a changed revision is the same part; changed process, oxygen scope and returned work are shown but not used", () => {
  assert.notEqual(byEvidence(l1, "3001WA")[0].status, "different", "revision is never compared (ruling revision-irrelevant-v1)");
  assert.deepEqual(byEvidence(l1, "3001WA")[0].differences || [], []);
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

test("the job cross-check reads both job-number forms the export uses", () => {
  assert.equal(customerWorkOrder("P/N: ABC-100 REV. B\nWO NO: W1- 100"), "W1-100");
  assert.equal(customerWorkOrder("P/N: ABC-100 REV. 02\nMANIFOLD\nJOB NO: 2786-1"), "2786-1");
  assert.equal(customerWorkOrder("P/N: ABC-100 REV. B"), null);
});

test("a quantity alternative with no accepted PO matches QPC's previous quote, with the chain beside it", () => {
  assert.equal(l2.recommendation.repeatCandidates.length, 0);
  assert.equal(l2.recommendation.preferred.unitPrice, 7);
  assert.match(l2.recommendation.preferred.basis, /^PREVIOUS-QUOTE: QPC quoted 5000 pcs at \$7\.00 on 2026-02-27/);
  assert.equal(l2.recommendation.alternatives[0].unitPrice, l2.calculations.sq5.settled);
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

test("when labor outweighs volume the page says so and offers the volume price with the lot minimum", () => {
  const inverted = structuredClone(l2);
  inverted.request.quantity = 20;
  inverted.recommendation.preferred = { label: "Price Lab chain (SQ5, SQ6 pending)", unitPrice: 26, extended: 520, basis: "SQ2/SQ3 stabilized per master v2" };
  inverted.recommendation.lotMinimum = { extended: 520, minimum: 200, passes: true };
  inverted.calculations.sq5 = { ...inverted.calculations.sq5, rule: "model inversion (SQ2 < SQ3)", settled: 26 };
  inverted.recommendation.alternatives = [];
  inverted.recommendation.quoteCandidates = [];
  inverted.recommendation.deltaVsChain = null;
  inverted.history.timeline = [];
  const { why, checks, decisionNeeded } = summarizeLine(inverted, decision);
  assert.match(why[0], /No price history/);
  assert.ok(why.some((item) => /takes the labor figure when it is higher/.test(item)));
  assert.match(decisionNeeded, new RegExp(`or quote the volume price \\$${inverted.calculations.sq2.price.toFixed(2)}/ea with the \\$200\\.00 lot minimum`));
  assert.ok(checks.some((item) => /and they set this price/.test(item)));
  assert.ok(summarizeLine(l1, decision).checks.some((item) => /They do not set the recommended price/.test(item)));
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

test("the repeat-price rule is recorded as approved, and the page stops asking about it", () => {
  assert.match(l1.recommendation.policy.status, /^APPROVED 2026-09-27/);
  assert.deepEqual(l1.recommendation.policy.approved, { date: "2026-09-27", by: "Quality Manager (pricing owner)" });
  assert.ok(decision.rulings.some((ruling) => ruling.id === "repeat-accepted-hold-v0-approved"));
  const { decisionNeeded } = summarizeLine(l1, decision);
  assert.match(decisionNeeded, /^Approve \$8\.50\/ea/);
  assert.ok(!/open rule/.test(decisionNeeded));
});

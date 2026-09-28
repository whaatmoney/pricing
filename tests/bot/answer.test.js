import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyAnswer, parseAnswer } from "../../bot/lib/answer.js";
import { buildBoard, businessDaysSince, renderBoard } from "../../bot/lib/board.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { lifecyclePath, readLifecycle } from "../../bot/lib/lifecycle.js";
import { renderHtml, renderMarkdown } from "../../bot/lib/render.js";
import { answerLines, approveAllLine, methodPath, reviewCard } from "../../bot/lib/review-card.js";
import { buildWorld, tempDir } from "./helpers.js";

const base = buildDecision(buildWorld().options);
const [l1, l2] = base.lines;
const v1 = { ...base, inputsFingerprint: "fp-1", lifecycle: { ...base.lifecycle, recommendationVersion: 1 } };
const CASE = base.caseId;

function outputs() {
  const dir = tempDir("qpc-answer-");
  fs.writeFileSync(path.join(dir, `CLAUDE-DECISION-${CASE}-v1.json`), JSON.stringify(v1));
  return dir;
}
const answer = (dir, text, extra = {}) => applyAnswer({ text, outputsDir: dir, decidedBy: "Pat Reviewer", now: new Date("2026-09-28T16:00:00Z"), ...extra });
const entries = (dir) => readLifecycle(lifecyclePath(dir, CASE), CASE).entries;

test("answer lines are read exactly: case, version, lines, action, method verdict and rule", () => {
  assert.deepEqual(parseAnswer(`${CASE} v1 L1 approve $8.50; method ok; rule approve`), { caseId: CASE, version: 1, lines: ["L1"], action: { choice: "approved", prices: [8.5] }, method: { verdict: "ok", field: null, note: null }, rule: "approved" });
  assert.deepEqual(parseAnswer(`${CASE} v2 L1,L3 alt 7.00 — volume price with the lot minimum`).action, { choice: "alternative", prices: [7], note: "volume price with the lot minimum" });
  assert.deepEqual(parseAnswer(`${CASE} v1 L2 correct dimensions: 0.35 x 0.2 x 0.2 in`).action, { choice: "correction", field: "envelope", note: "0.35 x 0.2 x 0.2 in" });
  assert.deepEqual(parseAnswer(`${CASE} v1 L1 method wrong why: lot time is too high`).method, { verdict: "wrong", field: "why", note: "lot time is too high" });
  assert.equal(parseAnswer(`${CASE} v1 all approve 8.50/5.25`).lines, "all");
  assert.throws(() => parseAnswer("approve 8.50"), /starts with the case, version and line/);
  assert.throws(() => parseAnswer(`${CASE} v1 L1 approve eight`), /is not a price/);
  assert.throws(() => parseAnswer(`${CASE} v1 L1 correct envelope: `), /names the field and what is right/);
  assert.throws(() => parseAnswer(`${CASE} v1 L1 method wrong why: `), /needs what is wrong/);
  assert.throws(() => parseAnswer(`${CASE} v1 L1 correct colour: red`), /not a card field/);
  assert.throws(() => parseAnswer(`${CASE} v1 L1 approve 8.50; please hurry`), /Cannot read "please hurry"/);
});

test("a pasted answer records the decision and the method verdict, keeping the words verbatim", () => {
  const dir = outputs();
  const text = `${CASE} v1 L1 approve 8.50; method ok`;
  const { answer: parsed, results } = answer(dir, text);
  assert.equal(parsed.caseId, CASE);
  assert.deepEqual(results.map(({ entry }) => entry.type), ["decision", "method-review"]);
  assert.ok(entries(dir).every((entry) => entry.reply === text));
});

test("an answer that fails on any line records nothing", () => {
  const dir = outputs();
  assert.throws(() => answer(dir, `${CASE} v1 all approve 8.50/${l2.recommendation.preferred.unitPrice.toFixed(2)}/5.00`), /no recommended price to approve/);
  assert.throws(() => answer(dir, `${CASE} v1 L1,L2 approve 8.50/1.00/2.00`), /3 prices for 2 lines/);
  assert.throws(() => answer(dir, `${CASE} v1 L1 approve 8.50`, { decidedBy: "Someone", approvers: ["Pat Reviewer"] }), /not a configured approver/);
  assert.equal(fs.existsSync(lifecyclePath(dir, CASE)), false);
});

test("the review card shows the six fields with their sources and the path the method took", () => {
  const card = reviewCard(l1, v1);
  assert.deepEqual(card.map((row) => row.label), ["P/N", "Envelope Dimensions", "Qty", "Process", "Suggested Unit Price", "Why"]);
  assert.equal(card[1].value, "0.7 × 0.7 × 0.12 in (L × W × H priced)");
  assert.match(card[1].source, /DIM: DRAWING/);
  assert.match(card[4].value, /^\$8\.50\/ea \(\$4,250\.00 for 500\)$/);
  const steps = methodPath(l1);
  assert.deepEqual(steps.map((step) => step.split(/[: ]/)[0]), ["History", "Volume", "Labor", "Settle", "Pick"]);
  assert.match(steps[0], /PO1-100/);
  assert.match(steps[1], /bracket 0–1 in³ base \$5\.00, × cleanliness 1\.2 \(level 300\) × geometry 1\.1 \(Minimal\)/);
  assert.match(steps[4], /holds the accepted PO price/);
  assert.match(methodPath(base.lines[2])[1], /^Volume \(SQ2\): blocked/);
});

test("answer lines on the page parse back into the same decisions", () => {
  const dir = outputs();
  const lines = answerLines(l1, v1).map((item) => item.text);
  assert.equal(lines[0], `${CASE} v1 L1 approve 8.50`);
  assert.equal(answer(dir, lines[1]).results[0].entry.option, l1.recommendation.alternatives[0].label);
  assert.throws(() => answer(dir, lines.find((line) => line.includes("correct"))), /names the field/);
  assert.equal(approveAllLine(v1), null);
  const priced = { ...v1, lines: [l1, l2] };
  assert.equal(approveAllLine(priced), `${CASE} v1 all approve 8.50/${l2.recommendation.preferred.unitPrice.toFixed(2)}`);
  const html = renderHtml(v1);
  assert.match(html, /<dl class="card facts">/);
  assert.match(html, /data-copy="TEST-ABC-100 v1 L1 approve 8\.50"/);
  assert.match(renderMarkdown(v1), /- \*\*Envelope Dimensions:\*\* 0\.7 × 0\.7 × 0\.12 in/);
});

test("the board lists open cases first with business days waiting, feedback, and monitor RFQs with no page", () => {
  const dir = outputs();
  answer(dir, `${CASE} v1 L2 correct qty: 50, not 5000; method wrong why: tiers were not split`);
  const monitor = path.join(dir, "monitor.json");
  fs.writeFileSync(monitor, JSON.stringify({ freshness: { source_cutoff: "2026-09-28T00:00:00Z" }, operational_queue: [
    { customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 1, status: "chased", evidence_ids: ["rfq"] },
    { customer: "Other Co", reference: "99 / XYZ-9", priority_section: 1, status: "new", last_observed_activity_at: "2026-09-24T10:00:00Z" },
    { customer: "Done Co", reference: "12 / Q-1", priority_section: 3, status: "quoted" },
  ] }));
  const board = buildBoard({ outputsDir: dir, monitorStatePath: monitor, now: new Date("2026-09-28T16:00:00Z") });
  assert.equal(board.cases.length, 1);
  assert.equal(board.cases[0].state, "Correction requested");
  assert.equal(board.cases[0].waitingBusinessDays, 2);
  assert.deepEqual(board.cases[0].feedback.map((entry) => entry.type), ["decision", "method-review"]);
  assert.equal(board.monitor.waiting, 2);
  assert.deepEqual(board.monitor.withoutPage.map((item) => item.customer), ["Other Co"]);
  const html = renderBoard(board);
  assert.ok(html.includes("Acme &lt;Precision&gt; Corp."));
  assert.match(html, /tiers were not split/);
  assert.match(html, new RegExp(`href="CLAUDE-DECISION-${CASE}-v1\\.html"`));
});

test("business days skip weekends", () => {
  assert.equal(businessDaysSince("2026-09-24T17:00:00Z", new Date("2026-09-28T20:00:00Z")), 2);
  assert.equal(businessDaysSince("2026-09-26T20:00:00Z", new Date("2026-09-27T20:00:00Z")), 0);
  assert.equal(businessDaysSince(null, new Date()), null);
});

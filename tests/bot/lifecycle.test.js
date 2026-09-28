import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildDecision } from "../../bot/lib/decision.js";
import { lifecyclePath, lifecycleView, readLifecycle, recordDecision } from "../../bot/lib/lifecycle.js";
import { renderHtml, renderMarkdown } from "../../bot/lib/render.js";
import { quoteSummary } from "../../bot/lib/review-card.js";
import { buildWorld, tempDir } from "./helpers.js";

// Synthetic decision (L1 repeat price with the chain beside it, L2 chain only,
// L3 uncalculated) saved as numbered versions in a fresh outputs folder.
const base = buildDecision(buildWorld().options);
const [l1, l2] = base.lines;
const asVersion = (version, fingerprint) => ({ ...base, inputsFingerprint: fingerprint, lifecycle: { ...base.lifecycle, recommendationVersion: version } });

function outputsWith(...versions) {
  const dir = tempDir("qpc-lifecycle-");
  for (const [version, fingerprint] of versions) {
    fs.writeFileSync(path.join(dir, `CLAUDE-DECISION-${base.caseId}-v${version}.json`), JSON.stringify(asVersion(version, fingerprint)));
  }
  return dir;
}

const decide = (dir, fields) => recordDecision({ outputsDir: dir, caseId: base.caseId, version: 1, decidedBy: "Pat Reviewer", decidedAt: "2026-09-28T16:00:00Z", now: new Date("2026-09-28T16:05:00Z"), ...fields });
const saved = (dir) => readLifecycle(lifecyclePath(dir, base.caseId), base.caseId);

test("an approval is its own record; the recommendation file is untouched", () => {
  const dir = outputsWith([1, "fp-1"]);
  const recommendation = path.join(dir, `CLAUDE-DECISION-${base.caseId}-v1.json`);
  const before = fs.readFileSync(recommendation, "utf8");
  const { entry, notices } = decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, note: "Hold the PO price" });
  assert.equal(fs.readFileSync(recommendation, "utf8"), before);
  assert.deepEqual(notices, []);
  assert.equal(entry.id, 1);
  assert.equal(entry.version, 1);
  assert.equal(entry.inputsFingerprint, "fp-1");
  assert.equal(entry.extended, 4250);
  assert.match(entry.option, /PO1-100/);
  assert.equal(entry.previousHash, null);
  assert.equal(entry.policyRuling, null);
  assert.equal(saved(dir).entries.length, 1);
});

test("an approval must be the recommended price; any other price is an alternative", () => {
  const dir = outputsWith([1, "fp-1"]);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "approved", unitPrice: 7.5 }), /recommends \$8\.50, not \$7\.50/);
  assert.throws(() => decide(dir, { lineId: "L3", choice: "approved", unitPrice: 5 }), /no recommended price to approve/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "alternative", unitPrice: 8.5 }), /record it as approved/);
  assert.equal(fs.existsSync(lifecyclePath(dir, base.caseId)), false);
});

test("an alternative names the option it matches; an unlisted price needs its basis", () => {
  const dir = outputsWith([1, "fp-1"]);
  const chain = l1.recommendation.alternatives[0];
  assert.equal(decide(dir, { lineId: "L1", choice: "alternative", unitPrice: chain.unitPrice }).entry.option, chain.label);
  assert.equal(decide(dir, { lineId: "L1", choice: "alternative", unitPrice: l1.calculations.onlineCalculator.price }).entry.option, "Online calculator (reference)");
  assert.throws(() => decide(dir, { lineId: "L1", choice: "alternative", unitPrice: 9.99 }), /not one of the listed options/);
  const offList = decide(dir, { lineId: "L1", choice: "alternative", unitPrice: 9.99, note: "Matches the price agreed by phone" }).entry;
  assert.equal(offList.option, null);
  assert.equal(offList.note, "Matches the price agreed by phone");
});

test("a correction names the wrong fact and carries no price", () => {
  const dir = outputsWith([1, "fp-1"]);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "correction" }), /needs a note/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "correction", unitPrice: 8.5, note: "x" }), /not a price/);
  const { entry } = decide(dir, { lineId: "L1", choice: "correction", note: "The drawing is Rev. C" });
  assert.equal(entry.unitPrice, null);
  assert.equal(entry.extended, null);
});

test("the version, line, choice and decider must be real before anything is written", () => {
  const dir = outputsWith([1, "fp-1"]);
  assert.throws(() => decide(dir, { version: 2, lineId: "L1", choice: "approved", unitPrice: 8.5 }), /No recommendation v2/);
  assert.throws(() => decide(dir, { lineId: "L9", choice: "approved", unitPrice: 8.5 }), /no line L9/);
  assert.throws(() => decide(dir, { choice: "approved", unitPrice: 8.5 }), /has 3 lines/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "maybe", unitPrice: 8.5 }), /Choice must be one of/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, decidedBy: "  " }), /who decided/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, approvers: ["Sam Owner"] }), /not a configured approver/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, decidedAt: "next Tuesday" }), /Cannot read the decision time/);
  assert.throws(() => decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, policyRuling: "maybe" }), /Rule ruling must be one of/);
  assert.equal(fs.existsSync(lifecyclePath(dir, base.caseId)), false);
  assert.equal(decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, decidedBy: "sam owner", approvers: ["Sam Owner"] }).entry.decidedBy, "sam owner");
});

test("a later decision on the same line replaces the earlier one; both stay on record, chained", () => {
  const dir = outputsWith([1, "fp-1"]);
  decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, policyRuling: "approved" });
  const { entry, notices } = decide(dir, { lineId: "L1", choice: "alternative", unitPrice: l1.recommendation.alternatives[0].unitPrice });
  assert.equal(entry.supersedesEntry, 1);
  assert.match(notices[0], /replaces decision #1/);
  assert.match(entry.previousHash, /^[0-9a-f]{64}$/);
  const lifecycle = saved(dir);
  assert.equal(lifecycle.entries.length, 2);
  assert.deepEqual(lifecycle.entries[0].policyRuling, { policy: "repeat-accepted-hold-v0", ruling: "approved" });
  assert.equal(lifecycleView(asVersion(1, "fp-1"), lifecycle).current.get("L1").id, 2);
});

test("an edited or removed entry breaks the chain and nothing more is recorded", () => {
  const dir = outputsWith([1, "fp-1"]);
  decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5 });
  decide(dir, { lineId: "L2", choice: "approved", unitPrice: l2.recommendation.preferred.unitPrice });
  const file = lifecyclePath(dir, base.caseId);
  const original = fs.readFileSync(file, "utf8");
  const edited = JSON.parse(original);
  edited.entries[0].unitPrice = 7;
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.throws(() => decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5 }), /append-only/);
  const removed = JSON.parse(original);
  removed.entries.shift();
  fs.writeFileSync(file, JSON.stringify(removed));
  assert.throws(() => saved(dir), /append-only/);
});

test("on a one-part RFQ a decided price below the lot minimum is flagged on its line", () => {
  const dir = tempDir("qpc-lifecycle-");
  const onePart = { ...asVersion(1, "fp-1"), poLotMinimum: null, lines: [{ ...l1, recommendation: { ...l1.recommendation, lotMinimum: { extended: 4250, minimum: 200, passes: true } } }] };
  fs.writeFileSync(path.join(dir, `CLAUDE-DECISION-${base.caseId}-v1.json`), JSON.stringify(onePart));
  const { entry, notices } = decide(dir, { lineId: "L1", choice: "alternative", unitPrice: 0.1, note: "Sample price" });
  assert.equal(entry.belowLotMinimum, true);
  assert.match(notices[0], /below the \$200\.00 lot minimum/);
  assert.equal(entry.lotCharge, 200);
  assert.match(renderMarkdown(onePart, { lifecycle: saved(dir) }), /Under the lot minimum, so the quote is the \$200\.00 lot charge\./);
});

test("on a multi-part RFQ a line carries no lot charge; the PO total is checked instead", () => {
  const dir = outputsWith([1, "fp-1"]);
  const { entry, notices } = decide(dir, { lineId: "L1", choice: "alternative", unitPrice: 0.1, note: "Sample price" });
  assert.equal(entry.belowLotMinimum, null);
  assert.equal(entry.lotCharge, null);
  assert.deepEqual(notices, []);
  assert.match(renderMarkdown(asVersion(1, "fp-1"), { lifecycle: saved(dir) }), /\*\*Lot minimum \(entire PO\):\*\* PO total for all parts at these prices: \$50\.00 \(L3 not priced\), under the \$200\.00 lot minimum, so the PO is charged \$200\.00\./);
});

test("a decision counts only for the version and inputs it was made on", () => {
  const dir = outputsWith([1, "fp-1"], [2, "fp-2"]);
  const { notices } = decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5 });
  assert.match(notices[0], /superseded by v2/);
  const lifecycle = saved(dir);
  const later = lifecycleView(asVersion(2, "fp-2"), lifecycle);
  assert.equal(later.current.size, 0);
  assert.equal(later.earlier.length, 1);
  assert.equal(lifecycleView(asVersion(1, "fp-changed"), lifecycle).current.size, 0);
  assert.equal(lifecycleView(asVersion(1, "fp-1"), lifecycle).current.size, 1);
});

test("the page shows recorded decisions, escapes the note and stops saying recommendation only", () => {
  const dir = outputsWith([1, "fp-1"]);
  decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5, note: "Hold <PO> price" });
  decide(dir, { lineId: "L2", choice: "approved", unitPrice: l2.recommendation.preferred.unitPrice });
  const partly = renderHtml(asVersion(1, "fp-1"), { lifecycle: saved(dir) });
  assert.match(partly, /class="status warn">PARTLY DECIDED on v1/);
  assert.match(partly, /Still needs review: L3/);
  assert.ok(partly.includes("Hold &lt;PO&gt; price"));
  assert.ok(!partly.includes("<PO>"));
  assert.ok(!partly.includes("RECOMMENDATION ONLY"));

  decide(dir, { lineId: "L3", choice: "alternative", unitPrice: 25, note: "Priced by hand from the part in hand" });
  const done = renderHtml(asVersion(1, "fp-1"), { lifecycle: saved(dir) });
  assert.match(done, /class="status ok">DECIDED on v1/);
  assert.equal(done.match(/class="recorded ok"/g).length, 3);
  assert.equal(done.match(/Change the answer/g).length, 3, "decided lines fold their answer lines away");
  const markdown = renderMarkdown(asVersion(1, "fp-1"), { lifecycle: saved(dir) });
  assert.match(markdown, /\*\*DECIDED on v1: L1 \$8\.50\/ea approved by Pat Reviewer/);
  assert.match(markdown, /### Decision recorded\n\nApproved on v1: \$8\.50\/ea, \$4,250\.00 for 500/);
});

test("a newer version lists the earlier decision but asks for its own review", () => {
  const dir = outputsWith([1, "fp-1"], [2, "fp-2"]);
  decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5 });
  const html = renderHtml(asVersion(2, "fp-2"), { lifecycle: saved(dir) });
  assert.match(html, /class="status warn">RECOMMENDATION ONLY/);
  assert.match(html, /They do not carry over to v2/);
  assert.match(html, /Earlier: Approved on v1/);
  assert.ok(!html.includes('class="recorded ok"'), "an earlier version's approval is never shown as this version's decision");
});

test("a correction marks the version as not approvable", () => {
  const dir = outputsWith([1, "fp-1"]);
  decide(dir, { lineId: "L1", choice: "approved", unitPrice: 8.5 });
  decide(dir, { lineId: "L2", choice: "correction", note: "Quantity is 50, not 5000" });
  const html = renderHtml(asVersion(1, "fp-1"), { lifecycle: saved(dir) });
  assert.match(html, /class="status alert">CORRECTION REQUESTED on v1 \(L2\)/);
  assert.match(html, /class="recorded alert"/);
});

test("the quote block lists P/N, Qty and Unit Price per part and the shared process once, using the decided price once there is one", () => {
  const dir = outputsWith([1, "fp-1"]);
  const before = quoteSummary(asVersion(1, "fp-1"), lifecycleView(asVersion(1, "fp-1"), saved(dir)));
  assert.equal(before.allApproved, false);
  assert.equal(before.entries[0].state, "suggested — not approved yet");
  assert.equal(before.text, "P/N: ABC-100 Rev. B\nQty: 500\nUnit Price: $8.50\n\nP/N: ABC-100 Rev. B\nQty: 5000\nUnit Price: $5.00\n\nP/N: DEF-200 Rev. B\nQty: 10\nUnit Price: not priced\n\nProcess: LEVEL 300R4 NOT FOR OXYGEN SERVICE");
  decide(dir, { lineId: "L1", choice: "alternative", unitPrice: 0.3, note: "Sample price" });
  const after = quoteSummary(asVersion(1, "fp-1"), lifecycleView(asVersion(1, "fp-1"), saved(dir)));
  assert.equal(after.entries[0].state, "alternative by Pat Reviewer");
  assert.match(after.text, /^P\/N: ABC-100 Rev\. B\nQty: 500\nUnit Price: \$0\.30\n/);
  const html = renderHtml(asVersion(1, "fp-1"), { lifecycle: saved(dir), quoteTemplate: "Opening line:\n\n{{parts}}\n\n{{process}}\n" });
  assert.match(html, /<section id="quote" class="hero"/);
  assert.ok(html.indexOf('id="quote"') < html.indexOf('id="why"') && html.indexOf('id="why"') < html.indexOf('id="decision"') && html.indexOf('id="decision"') < html.indexOf('id="evidence"'), "the page reads quote, why, decision, evidence");
  assert.match(html, /data-copy="Opening line:\n\nP\/N: ABC-100 Rev\. B\nQty: 500/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { poTotal, quoteSummary } from "../../bot/lib/review-card.js";

const line = (lineId, partNumber, quantity, unitPrice, process) => ({
  lineId,
  request: { partNumber, revision: "B", quantity, uom: "EA", process: { verbatim: process } },
  recommendation: { preferred: { unitPrice }, lotMinimum: { minimum: 100 } },
});
const view = (entries = []) => ({ current: new Map(entries.map((entry) => [entry.lineId, entry])) });
const TEMPLATE = "Opening line:\n\n{{parts}}\n\n{{process}}\n\nTerms line\n";

test("quantity tiers of one part at one price share an entry, and a shared process is written once", () => {
  const decision = { lines: [line("L1", "ABC-100", 18, 7, "CLEAN TO LEVEL 300"), line("L2", "ABC-100", 54, 7, "CLEAN TO LEVEL 300"), line("L3", "ABC-100", 72, 7, "CLEAN TO LEVEL 300")] };
  const quote = quoteSummary(decision, view(), { template: TEMPLATE });
  assert.equal(quote.text, "Opening line:\n\nP/N: ABC-100 Rev. B\nQty: 18, 54 & 72\nUnit Price: $7.00\n\nProcess: CLEAN TO LEVEL 300\n\nTerms line");
  assert.deepEqual(quote.entries.map((entry) => entry.lineId), ["L1", "L2", "L3"]);
});

test("parts with different processes carry their own process and the shared slot closes up", () => {
  const decision = { lines: [line("L1", "ABC-100", 9, 17, "CLEAN, METHOD 2"), line("L2", "DEF-200", 9, 8, "CLEAN AND PASSIVATE, METHOD 1")] };
  const quote = quoteSummary(decision, view(), { template: TEMPLATE });
  assert.equal(quote.text, "Opening line:\n\nP/N: ABC-100 Rev. B\nQty: 9\nUnit Price: $17.00\nProcess: CLEAN, METHOD 2\n\nP/N: DEF-200 Rev. B\nQty: 9\nUnit Price: $8.00\nProcess: CLEAN AND PASSIVATE, METHOD 1\n\nTerms line");
});

test("a recorded price replaces the suggestion, splits tiers that now differ, and a correction does not", () => {
  const decision = { lines: [line("L1", "ABC-100", 18, 7, "CLEAN"), line("L2", "ABC-100", 54, 7, "CLEAN")] };
  const decided = quoteSummary(decision, view([{ lineId: "L1", choice: "alternative", unitPrice: 8.5, decidedBy: "Pat Reviewer" }]));
  assert.equal(decided.text, "P/N: ABC-100 Rev. B\nQty: 18\nUnit Price: $8.50\n\nP/N: ABC-100 Rev. B\nQty: 54\nUnit Price: $7.00\n\nProcess: CLEAN");
  assert.equal(decided.allApproved, false);
  const corrected = quoteSummary(decision, view([{ lineId: "L1", choice: "correction", decidedBy: "Pat Reviewer" }]));
  assert.match(corrected.text, /Qty: 18 & 54\nUnit Price: \$7\.00/);
  assert.equal(corrected.entries[0].state, "correction requested — not approved");
});

test("the lot minimum is checked once on the PO total when the RFQ covers more than one part", () => {
  const decision = { lines: [line("L1", "ABC-100", 9, 17, "CLEAN"), line("L2", "DEF-200", 9, 8, "PASSIVATE")], poLotMinimum: { lineIds: ["L1", "L2"], minimum: 350 } };
  const suggested = poTotal(decision, view());
  assert.deepEqual([suggested.extended, suggested.charge, suggested.below], [225, 350, true]);
  assert.match(suggested.text, /\$225\.00, under the \$350\.00 lot minimum, so the PO is charged \$350\.00\./);
  const decided = poTotal(decision, view([{ lineId: "L1", choice: "alternative", unitPrice: 30, decidedBy: "Pat Reviewer" }]));
  assert.deepEqual([decided.extended, decided.charge, decided.below], [342, 350, true]);
  assert.equal(poTotal({ lines: decision.lines, poLotMinimum: null }, view()), null);
});

test("a suggested price from history names the date it was given", () => {
  const quoteLed = { ...line("L1", "ABC-100", 9, 18, "CLEAN"), recommendation: { preferred: { unitPrice: 18, basis: "PREVIOUS-QUOTE: QPC quoted 12 pcs at $18.00 on 2026-09-22 (e@qpc.example → buyer@acme.example); rule previous-quote-hold-v1" } } };
  const poLed = { ...line("L2", "DEF-200", 500, 8.5, "CLEAN"), recommendation: { preferred: { unitPrice: 8.5, basis: "REPEAT-ACCEPTED: customer PO PO1-100 dated 2026-03-05, 500 pcs at $8.50, same part, revision and process scope" } } };
  const chain = { ...line("L3", "GHI-300", 5, 11, "CLEAN"), recommendation: { preferred: { unitPrice: 11, basis: "SQ2/SQ3 stabilized per master v2" } } };
  const entries = quoteSummary({ lines: [quoteLed, poLed, chain] }, view()).entries;
  assert.deepEqual(entries.map((entry) => entry.source.text), ["QPC quote of Sep 22, 2026 · 12 pcs", "customer PO of Mar 5, 2026 · 500 pcs", "calculator · no price history"]);
  const overridden = quoteSummary({ lines: [quoteLed] }, view([{ lineId: "L1", choice: "alternative", unitPrice: 20, decidedBy: "Pat Reviewer" }])).entries[0];
  assert.equal(overridden.source, null, "a recorded different price is not labelled with the old source");
});

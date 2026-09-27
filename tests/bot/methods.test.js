import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calculatorPrice, loadCalculator } from "../../bot/lib/methods/online-calculator.js";
import { loadPriceLabRules, parseCsv } from "../../bot/lib/methods/price-lab-rules.js";
import { lotMinimumCheck, roundToStep, sq2NonTube, sq3Throughput, sq4Band, sq5Stabilize } from "../../bot/lib/methods/pricegpt-master-v2.js";
import { CALCULATOR_HTML, tempDir, writeRulesPackage } from "./helpers.js";

// Every expected value below is worked by hand from the synthetic tables in
// helpers.js; none comes from price history.
const rules = loadPriceLabRules(writeRulesPackage(tempDir()));
const sq2Input = (overrides = {}) => ({
  envelope: { length: 0.7, width: 0.7, height: 0.12 },
  cleanliness: "300",
  geometry: "Minimal",
  cavities: {},
  lengthSurcharge: { amount: 0, basis: "test" },
  specFee: { amount: 0, basis: "test" },
  ...overrides,
});

test("CSV parsing handles a BOM, quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsv("﻿a,b\n1,\"x, \"\"y\"\"\"\n"), [["a", "b"], ["1", "x, \"y\""]]);
});

test("rules load from the package and state their constants", () => {
  assert.equal(rules.laborRate, 100);
  assert.equal(rules.baseMinimum, 5);
  assert.equal(rules.volumeBuffer, 1.1);
  assert.equal(rules.lotMinimum, 200);
  assert.equal(rules.volumeTable.at(-1).base, 1000);
  assert.equal(rules.cavityTiers.C, 0.5);
});

test("a changed rate file stops the method instead of pricing with it", () => {
  const dir = writeRulesPackage(tempDir());
  fs.appendFileSync(path.join(dir, "Cleanliness Multipliers - v10.2.25.csv"), "50,2\n");
  assert.throws(() => loadPriceLabRules(dir), /failed verification/);
});

test("SQ2: buffered volume rounds up, base minimum applies, two multipliers, quarter rounding", () => {
  const result = sq2NonTube(sq2Input(), rules);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.components.volume, 1);
  assert.equal(result.components.base, 5);
  assert.equal(result.unit, 6.6);
  assert.equal(result.price, 6.5);
  assert.ok(result.flags.includes("HANDLING TABLE INACTIVE"));
});

test("SQ2: cavity charge takes cleanliness but not geometry", () => {
  const result = sq2NonTube(sq2Input({ cavities: { A: 1 } }), rules);
  assert.equal(result.unit, 9);
  assert.equal(result.price, 9);
});

test("SQ2: an exact rounding tie is decided half-up in integer arithmetic and flagged", () => {
  const result = sq2NonTube(sq2Input({ cleanliness: "VC", geometry: "Moderate" }), rules);
  assert.equal(result.unit, 6.375);
  assert.equal(result.price, 6.5);
  assert.ok(result.flags.includes("ROUNDING TIE"));
  assert.deepEqual(roundToStep(51_130_000, 0.5), { value: 51, tie: false });
  assert.deepEqual(roundToStep(51_250_000, 0.5), { value: 51.5, tie: true });
});

test("SQ2: overlapping or missing volume brackets block instead of guessing", () => {
  const overlap = sq2NonTube(sq2Input({ envelope: { length: 2.5, width: 1, height: 1 } }), rules);
  assert.match(overlap.blocked[0], /falls in 2 brackets/);
  const outside = sq2NonTube(sq2Input({ envelope: { length: 10, width: 10, height: 10 } }), rules);
  assert.match(outside.blocked[0], /outside every bracket/);
  assert.match(sq2NonTube(sq2Input({ envelope: {} }), rules).blocked[0], /Envelope/);
  assert.match(sq2NonTube(sq2Input({ lengthSurcharge: {} }), rules).blocked[0], /Length surcharge/);
});

test("SQ3: per-part labor is never divided by quantity; lot labor spreads over the batch", () => {
  const steps = [
    { step: "setup", class: "LOT", minutes: 60, basis: "estimate" },
    { step: "handle", class: "PER-PART", minutes: 0.5, basis: "estimate" },
    { step: "dwell", class: "PASSIVE", minutes: 30, basis: "estimate" },
  ];
  const base = sq3Throughput({ quantity: 100, batch: { size: 50, basis: "assumed" }, steps }, rules);
  assert.equal(base.components.laborMinutesPerPart, 1.7);
  assert.equal(base.price, 2.83);
  assert.equal(base.confidence, "Low");
  const moreParts = sq3Throughput({ quantity: 1000, batch: { size: 50, basis: "assumed" }, steps }, rules);
  assert.equal(moreParts.price, base.price);
  const tied = sq3Throughput({ quantity: 100, batch: { size: 50, basis: "assumed" }, steps: [...steps.slice(0, 2), { ...steps[2], techTied: true }] }, rules);
  assert.equal(tied.components.laborMinutesPerPart, 2.3);
  assert.match(sq3Throughput({ quantity: 10, batch: { size: 50 }, steps }, rules).blocked[0], /exceeds quantity/);
});

test("SQ5: stabilization bands, missing anchor, inversion and SQ3-not-run", () => {
  assert.equal(sq5Stabilize({ sq2: 10, sq3: 9 }).settled, 9.5);
  assert.equal(sq5Stabilize({ sq2: 10, sq3: 8, anchor: { choice: "SQ2", reason: "t" } }).settled, 9.5);
  assert.equal(sq5Stabilize({ sq2: 10, sq3: 5, anchor: { choice: "SQ2", reason: "t" } }).settled, 10);
  assert.equal(sq5Stabilize({ sq2: 10, sq3: 5, anchor: { choice: "SQ3", reason: "t" } }).settled, 5);
  assert.match(sq5Stabilize({ sq2: 10, sq3: 5 }).blocked[0], /credible anchor/);
  const inverted = sq5Stabilize({ sq2: 5, sq3: 8 });
  assert.equal(inverted.settled, 8);
  assert.ok(inverted.flags.includes("INV"));
  const notRun = sq5Stabilize({ sq2: 7.25, sq3: null });
  assert.equal(notRun.settled, 7.5);
  assert.ok(notRun.flags.includes("S3N"));
});

test("SQ4 band and lot minimum are context checks only", () => {
  const noAnchor = sq4Band({ sq2: 10, sq3: 9, anchor: null, widen: false, rules });
  assert.deepEqual([noAnchor.low, noAnchor.mid, noAnchor.high], [8.5, 9.5, 11]);
  assert.match(noAnchor.flags[0], /no credible anchor/);
  const anchoredHigh = sq4Band({ sq2: 10, sq3: 9, anchor: { choice: "SQ2", reason: "t" }, widen: true, rules });
  assert.deepEqual([anchoredHigh.low, anchoredHigh.mid, anchoredHigh.high], [10, 9.5, 11.5]);
  assert.match(anchoredHigh.flags[0], /LOW exceeds MID/);
  assert.deepEqual(lotMinimumCheck(9.5, 10, rules), { extended: 95, minimum: 200, passes: false });
});

test("the online calculator path runs the page's own tables and notices formula drift", () => {
  const dir = tempDir();
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, CALCULATOR_HTML);
  const calculator = loadCalculator(file);
  assert.deepEqual(calculator.formulaDrift, []);
  const envelope = { length: 1, width: 1, height: 1 };
  assert.equal(calculatorPrice({ envelope, process: "300" }, calculator).price, 4.8);
  assert.equal(calculatorPrice({ envelope, process: "300", packaging: "Double-bag" }, calculator).price, 5.4);
  assert.equal(calculatorPrice({ envelope, process: "300", endUser: "ACME" }, calculator).price, 7.2);
  fs.writeFileSync(file, CALCULATOR_HTML.replace("cmpMult;", "cmpMult * 1.1;"));
  const drifted = loadCalculator(file);
  assert.equal(drifted.formulaDrift.length, 1);
  assert.ok(calculatorPrice({ envelope, process: "300" }, drifted).flags[0].includes("DRIFT"));
});

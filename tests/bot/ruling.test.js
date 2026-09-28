import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildDecision } from "../../bot/lib/decision.js";
import { sq5Stabilize } from "../../bot/lib/methods/pricegpt-master-v2.js";
import { renderMarkdown } from "../../bot/lib/render.js";
import { methodPath, reviewCard } from "../../bot/lib/review-card.js";
import { RULINGS } from "../../bot/lib/rulings.js";
import { buildWorld } from "./helpers.js";

test("with inversion off, labor above volume no longer takes the price; the bands run both ways", () => {
  assert.equal(sq5Stabilize({ sq2: 7, sq3: 25.91, anchor: { choice: "SQ2" } }).settled, 26);
  const ruled = sq5Stabilize({ sq2: 7, sq3: 25.91, anchor: { choice: "SQ2" }, inversion: false });
  assert.equal(ruled.settled, 7);
  assert.match(ruled.rule, /> 30%: credible anchor SQ2/);
  assert.ok(!ruled.flags.includes("INV"));
  assert.equal(sq5Stabilize({ sq2: 7, sq3: 8, anchor: { choice: "SQ2" }, inversion: false }).settled, 7.5);
  assert.match(sq5Stabilize({ sq2: 7, sq3: 7.5, anchor: { choice: "SQ2" }, inversion: false }).rule, /midpoint/);
});

// A small lot: 20 lot-setup minutes over 12 parts would make labor far above
// volume under the old rule. The ruling compares hands-on minutes only and
// charges the lot minimum instead.
function smallLotWorld() {
  const world = buildWorld();
  const kase = JSON.parse(fs.readFileSync(world.casePath, "utf8"));
  const line = kase.lines[1];
  kase.recommendationPolicy = "chain-only-v0";
  kase.lines = [{ ...line, lineId: "L1", quantity: 12, sq3: { ...line.sq3, batch: { size: 12, basis: "assumed", reason: "test" }, steps: [{ step: "setup", router: "-", class: "LOT", minutes: 240, basis: "estimate" }, { step: "handle", router: "-", class: "PER-PART", minutes: 0.5, basis: "estimate" }] } }];
  fs.writeFileSync(world.casePath, JSON.stringify(kase));
  return buildDecision(world.options);
}

test("a small lot is priced on volume with hands-on labor compared, and the lot minimum is charged", () => {
  const decision = smallLotWorld();
  const [line] = decision.lines;
  const calc = line.calculations;
  assert.deepEqual(decision.rulings.map((ruling) => ruling.id), RULINGS.map((ruling) => ruling.id));
  assert.ok(calc.sq3.price > 30, "full labor with setup spread over 12 parts stays visible");
  assert.equal(calc.sq3.handsOnPrice, 0.83);
  assert.equal(calc.sq2.source, "calculator", "ruling calculator-volume-v1: the volume price is the calculator's");
  assert.equal(calc.sq5.settled, Math.round(calc.sq2.price * 2) / 2, "SQ5 settles on the volume price at its $0.50 step");
  const preferred = line.recommendation.preferred;
  assert.equal(preferred.unitPrice, calc.sq5.settled);
  assert.equal(preferred.lotCharge, 200);
  assert.equal(line.recommendation.lotMinimum.passes, false);
  const card = reviewCard(line, decision);
  assert.equal(card[4].value, `$${preferred.unitPrice.toFixed(2)}/ea with the $200.00 lot minimum ($200.00 for 12)`);
  const steps = methodPath(line);
  assert.match(steps[2], /hands-on: 0\.500 min per part.*lot-setup minutes are left out because the lot minimum recovers them/);
  assert.match(steps[3], /Ruling applied: hands-on-labor-no-inversion-v1\.$/);
  assert.ok(steps.some((step) => /^Lot minimum: .* so the lot minimum is charged\.$/.test(step)));
  assert.match(renderMarkdown({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } }), /Approve \$\d+\.\d{2}\/ea with the \$200\.00 lot minimum \(\$200\.00 for 12;/);
});

test("the volume price is the calculator's: cavities count only through Complexity, and the master SQ2 stays as a reference", () => {
  const world = buildWorld();
  const kase = JSON.parse(fs.readFileSync(world.casePath, "utf8"));
  const line = kase.lines[0];
  kase.lines = [{ ...line, sq1: { ...line.sq1, cavities: { ...line.sq1.cavities, counts: { A: 0, B: 12, C: 1, D: 0 } } },
    calculator: { ...line.calculator, cavityDollars: 6.25, complexity: "Multi-port", complexityReason: "blind tapped bore and a cross-hole pattern", alternatives: [{ label: "Standard", complexity: "Standard" }] } }];
  fs.writeFileSync(world.casePath, JSON.stringify(kase));
  const [priced] = buildDecision(world.options).lines;
  const calc = priced.calculations;
  assert.equal(calc.sq2.components.cavity, 0);
  assert.equal(calc.sq2.components.complexityKey, "Multi-port");
  assert.ok(calc.sq2.flags.includes("CAVITY $6.25 IN CASE IGNORED (ruling calculator-volume-v1)"));
  assert.equal(calc.sq2.price, Math.round(calc.onlineCalculator.unit * 4) / 4);
  assert.ok(calc.masterSq2.components.cavities.charge > 0, "the master's per-cavity charge is kept for reference");
  assert.ok(calc.sq2Sensitivity[0].price < calc.sq2.price, "Standard complexity prices lower than Multi-port");
  assert.match(methodPath(priced)[1], /complexity 1\.4 \(Multi-port: blind tapped bore and a cross-hole pattern\)/);
});

test("an unknown calculator multiplier name blocks the price instead of producing a blank", () => {
  const world = buildWorld();
  const kase = JSON.parse(fs.readFileSync(world.casePath, "utf8"));
  kase.lines = [{ ...kase.lines[0], calculator: { ...kase.lines[0].calculator, complexity: "Multiport" } }];
  fs.writeFileSync(world.casePath, JSON.stringify(kase));
  const [priced] = buildDecision(world.options).lines;
  assert.deepEqual(priced.calculations.sq2.blocked, ['No complexity multiplier for "Multiport".']);
  assert.deepEqual(priced.calculations.sq5.blocked, ["SQ2 is blocked"]);
});

test("a QPC quote that names no part counts only when the case links it and the price is in its text", () => {
  const world = buildWorld();
  const messagesFile = `${world.evidence}/messages.json`;
  const saved = JSON.parse(fs.readFileSync(messagesFile, "utf8"));
  saved.messages.push({ id: "bare-quote", mailbox: "sales@qpc.example", subject: "Re: RFQ for fittings", from: "e@qpc.example", to: ["buyer@acme.example"], cc: [], receivedAt: "2026-08-24T12:00:00Z", webLink: "https://mail.example/bare", bodyFormat: "text", attachments: [], body: "The unit price to clean and package these fittings is $35.00 each." });
  fs.writeFileSync(messagesFile, JSON.stringify(saved));
  const kase = JSON.parse(fs.readFileSync(world.casePath, "utf8"));
  const line = { ...kase.lines[2], lineId: "L1", quoteLinks: [{ messageId: "bare-quote", unitPrice: 35, quantity: 12, reason: "the customer's 8/24 RFQ listed this part among the fittings" }] };
  kase.lines = [line];
  fs.writeFileSync(world.casePath, JSON.stringify(kase));
  const [linked] = buildDecision(world.options).lines;
  assert.equal(linked.recommendation.preferred.unitPrice, 35);
  assert.match(linked.recommendation.preferred.basis, /^PREVIOUS-QUOTE: QPC quoted 12 pcs at \$35\.00 on 2026-08-24/);
  assert.ok(linked.history.timeline.some((entry) => entry.notes.some((note) => /names no part number; the case ties it to this part/.test(note))));

  kase.lines = [{ ...line, quoteLinks: [{ ...line.quoteLinks[0], unitPrice: 30 }] }];
  fs.writeFileSync(world.casePath, JSON.stringify(kase));
  const [rejected] = buildDecision(world.options).lines;
  assert.equal(rejected.recommendation.quoteCandidates.length, 0, "a linked price that is not in the message is never used");
});

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
  assert.equal(calc.sq5.settled, calc.sq2.price);
  const preferred = line.recommendation.preferred;
  assert.equal(preferred.unitPrice, calc.sq2.price);
  assert.equal(preferred.lotCharge, 200);
  assert.equal(line.recommendation.lotMinimum.passes, false);
  const card = reviewCard(line, decision);
  assert.equal(card[4].value, `$${calc.sq2.price.toFixed(2)}/ea with the $200.00 lot minimum ($200.00 for 12)`);
  const steps = methodPath(line);
  assert.match(steps[2], /hands-on: 0\.500 min per part.*lot-setup minutes are left out because the lot minimum recovers them/);
  assert.match(steps[3], /Ruling applied: hands-on-labor-no-inversion-v1\.$/);
  assert.ok(steps.some((step) => /^Lot minimum: .* so the lot minimum is charged\.$/.test(step)));
  assert.match(renderMarkdown({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } }), /Approve \$\d+\.\d{2}\/ea with the \$200\.00 lot minimum \(\$200\.00 for 12;/);
});

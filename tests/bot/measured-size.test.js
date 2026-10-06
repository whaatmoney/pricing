import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { lineConfidence } from "../../bot/lib/confidence.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { renderHtml } from "../../bot/lib/render.js";
import { RULINGS } from "../../bot/lib/rulings.js";
import { buildWorld } from "./helpers.js";

// Synthetic data only: ruling measured-size-v1.
function measuredWorld(disagreement = null) {
  const world = buildWorld();
  const kase = JSON.parse(fs.readFileSync(world.casePath, "utf8"));
  const line = kase.lines.find((item) => item.lineId === "L3");
  line.sq1.envelope = { length: 12, width: 1.625, height: 1.25, units: "in", basis: "test", flag: "DIM: MEASURED AT RECEIVING (WO 1234, 2026-05-11)", confidence: "HIGH", ...(disagreement ? { disagreement } : {}) };
  fs.writeFileSync(world.casePath, JSON.stringify(kase));
  return world;
}

test("a size measured at receiving is shown as such and is not 'inferred'", () => {
  const decision = buildDecision(measuredWorld().options);
  const l3 = decision.lines.find((item) => item.lineId === "L3");
  assert.ok(l3.calculations.sq2.flags.includes("DIM: MEASURED AT RECEIVING (WO 1234, 2026-05-11)"));
  assert.ok(!l3.calculations.sq2.flags.some((flag) => String(flag).startsWith("DIM DISAGREES")));
  const html = renderHtml(decision, { lifecycle: decision.lifecycle });
  const start = html.indexOf('<div class="size-fact">', html.indexOf("12 × 1.625 × 1.25") - 400);
  const block = html.slice(start, html.indexOf("</div>", start));
  assert.match(block, /measured at receiving, WO 1234, 2026-05-11/);
  assert.doesNotMatch(block, /inferred, confirm on the print/);
  const grade = lineConfidence(l3);
  assert.ok(grade.factors.some((factor) => factor.label === "Dimensions" && /measured at receiving/.test(factor.text)));
  assert.ok(RULINGS.some((ruling) => ruling.id === "measured-size-v1"));
});

test("a posted size that disagrees is flagged on the page and lowers confidence, without changing the priced size", () => {
  const note = "Front Desk posted 2.5 x 1 x 1 in in QUOTE PREP TRACKER 2026-10-05; priced the size measured at receiving";
  const decision = buildDecision(measuredWorld(note).options);
  const l3 = decision.lines.find((item) => item.lineId === "L3");
  assert.ok(l3.calculations.sq2.flags.includes(`DIM DISAGREES: ${note}`));
  assert.match(renderHtml(decision, { lifecycle: decision.lifecycle }), /12 × 1\.625 × 1\.25/);
  const html = renderHtml(decision, { lifecycle: decision.lifecycle });
  assert.match(html, /disagrees: Front Desk posted 2\.5 x 1 x 1 in/);
  const agreed = lineConfidence(buildDecision(measuredWorld().options).lines.find((item) => item.lineId === "L3"));
  const flagged = lineConfidence(l3);
  assert.ok(flagged.score < agreed.score);
});

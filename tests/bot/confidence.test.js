import assert from "node:assert/strict";
import test from "node:test";
import { caseConfidence, lineConfidence, reasonsText } from "../../bot/lib/confidence.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { renderHtml, renderMarkdown } from "../../bot/lib/render.js";
import { buildWorld } from "./helpers.js";

const decision = buildDecision(buildWorld().options);
const [l1, l2, l3] = decision.lines;
const v1 = { ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } };

// A chain-priced line with its size inputs replaced, for the size rules.
function sized({ buffered, bracket, dimFlag = "DIM: DRAWING", caveat = "test", handsOn = 0.5 }) {
  return {
    ...l2,
    request: { ...l2.request, drawing: { ...l2.request.drawing, caveat } },
    history: { ...l2.history, timeline: [] },
    recommendation: { ...l2.recommendation, preferred: { ...l2.recommendation.preferred, label: "Price Lab chain (SQ5, SQ6 pending)", basis: "SQ2/SQ3 stabilized per master v2" }, quoteCandidates: [] },
    calculations: {
      ...l2.calculations,
      sq2: { ...l2.calculations.sq2, flags: [dimFlag], components: { ...l2.calculations.sq2.components, bufferedVolume: buffered, bracket } },
      sq2Sensitivity: [],
      sq3: { ...l2.calculations.sq3, handsOnPrice: handsOn },
    },
  };
}

test("an accepted repeat price backed by matching work orders is High", () => {
  const grade = lineConfidence(l1);
  assert.equal(grade.level, "High");
  assert.deepEqual(grade.factors.map((factor) => factor.label), ["History", "Work orders"]);
});

test("a line with no price, or with a correction recorded, is Low", () => {
  assert.equal(lineConfidence(l3).level, "Low");
  assert.equal(lineConfidence(l1, { recorded: { choice: "correction" } }).level, "Low");
});

test("a size deep inside its bracket raises confidence; one near an edge lowers it", () => {
  const safe = lineConfidence(sized({ buffered: 0.06, bracket: { min: 0, max: 1 } }));
  assert.ok(safe.factors.some((factor) => factor.label === "Size margin" && factor.weight === 1));
  const edge = lineConfidence(sized({ buffered: 34.4, bracket: { min: 31, max: 40 } }));
  assert.ok(edge.factors.some((factor) => factor.label === "Size margin" && factor.weight === -1));
  assert.match(reasonsText(edge).join(" "), /20% size error would move it out of the 31–40 in³ bracket/);
});

test("inferred dimensions, a method to confirm and labor setting the price each lower the grade", () => {
  const grade = lineConfidence(sized({ buffered: 34.4, bracket: { min: 31, max: 40 }, dimFlag: "DIM: DRAWING (height inferred)", caveat: "Confirm QPC's approved method.", handsOn: 99 }));
  assert.deepEqual(grade.factors.filter((factor) => factor.weight < 0).map((factor) => factor.label), ["History", "Dimensions", "Size margin", "Labor", "Process"]);
  assert.equal(grade.level, "Low");
  assert.match(lineConfidence(sized({ buffered: 0.06, bracket: { min: 0, max: 1 }, caveat: "Read by eye from the preview." })).factors.find((factor) => factor.label === "Dimensions").text, /read by eye/);
});

test("a case takes its weakest line's grade, and the page and Markdown show it with reasons", () => {
  const grade = caseConfidence(decision.lines);
  assert.equal(grade.level, "Low");
  assert.equal(grade.weakest.lineId, "L3");
  const html = renderHtml(v1);
  assert.match(html, /<span class="chip alert">Confidence: Low<\/span>/);
  assert.match(html, /Weakest line: L3\./);
  assert.match(html, /<a class="back" href="CLAUDE-DECISIONS-OPEN\.html"[^>]*>.*All RFQs/, "every price page links back to the board");
  assert.match(renderMarkdown(v1), /\*\*Confidence: Low\*\* — /);
});

test("a price that matches QPC's previous quote is graded on that quote, not on size", () => {
  const graded = lineConfidence(l2);
  assert.ok(graded.factors.some((factor) => factor.label === "History" && factor.weight === 1 && /already quoted this customer \$7\.00/.test(factor.text)));
  assert.ok(!graded.factors.some((factor) => ["Size margin", "Sensitivity", "Dimensions"].includes(factor.label)));
});

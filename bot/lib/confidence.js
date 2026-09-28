// How much to trust a suggested price, as a grade with its reasons rather than
// a percentage: there is no track record yet to calibrate a number against.
// Each factor reads only the saved decision record, so the grade never changes
// a price or a version. Recorded decisions (approved as-is, changed, corrected)
// are the data to calibrate these weights against later.

const usd = (value) => `$${Number(value).toFixed(2)}`;
const isBlocked = (result) => Boolean(result?.blocked?.length);
const priced = (volume) => Math.max(1, Math.ceil(volume - 1e-9));

export const LEVELS = { High: 2, Low: -2 };

function levelOf(score) {
  if (score >= LEVELS.High) return "High";
  if (score <= LEVELS.Low) return "Low";
  return "Medium";
}

// One line's grade. `recorded` is the decision in force for this version, if any.
export function lineConfidence(line, { recorded = null } = {}) {
  const { recommendation: rec, calculations: calc, request } = line;
  const factors = [];
  const add = (weight, label, text) => factors.push({ weight, label, text });

  if (recorded?.choice === "correction") {
    return { level: "Low", score: LEVELS.Low, factors: [{ weight: LEVELS.Low, label: "Correction", text: "A fact on this version is being corrected." }] };
  }
  if (!rec.preferred) {
    return { level: "Low", score: LEVELS.Low, factors: [{ weight: LEVELS.Low, label: "No price", text: rec.uncalculated || "The method could not price this line." }] };
  }

  const repeatLed = rec.preferred.basis.startsWith("REPEAT-ACCEPTED");
  const orders = [...new Set(rec.repeatCandidates.map((po) => po.poNumber))];
  if (repeatLed) {
    add(2, "History", `The customer accepted ${usd(rec.preferred.unitPrice)} on ${orders.length === 1 ? "a PO" : `${orders.length} POs`} for this exact part, revision and scope in the last 12 months.`);
    const jobs = line.history.jobs.filter((job) => rec.repeatCandidates.some((po) => po.poNumber && job.sources.some((source) => source.evidence.startsWith(po.poNumber))));
    if (jobs.length && jobs.every((job) => job.agree)) add(1, "Work orders", "QPC's own work orders for those jobs carry the same price.");
  } else if (line.history.timeline.some((entry) => entry.status === "comparable")) {
    add(0, "History", "Comparable history exists but did not set the price.");
  } else {
    add(-1, "History", "No price history for this part and customer.");
  }

  // Size only matters when the size method sets the price.
  if (!repeatLed) {
    if (isBlocked(calc.sq2)) {
      add(-3, "Size", "The size method could not run.");
    } else {
      const dimFlag = (calc.sq2.flags || []).find((flag) => String(flag).startsWith("DIM:")) || "";
      const caveat = request.drawing?.caveat || "";
      if (/inferred|assum|estimat/i.test(dimFlag) || /inferred|by eye/i.test(caveat)) {
        add(-1, "Dimensions", /by eye/i.test(caveat) ? "Dimensions were read by eye from a drawing preview." : "Part of the size is inferred, not read from a labelled dimension.");
      } else if (/DRAWING/.test(dimFlag)) {
        add(0, "Dimensions", "Dimensions come from the drawing.");
      } else {
        add(-1, "Dimensions", "Dimensions are not from the drawing.");
      }
      const c = calc.sq2.components;
      if (c?.bracket) {
        const buffered = c.bufferedVolume;
        if (priced(buffered * 2) <= c.bracket.max && priced(buffered / 2) >= c.bracket.min) {
          add(1, "Size margin", "The size could be half or double without changing the price bracket.");
        } else if (priced(buffered * 1.2) > c.bracket.max || priced(buffered * 0.8) < c.bracket.min) {
          add(-1, "Size margin", `A 20% size error would move it out of the ${c.bracket.min}–${c.bracket.max} in³ bracket.`);
        }
      }
      const spread = (calc.sq2Sensitivity || []).filter((item) => !item.blocked && item.price != null)
        .map((item) => ({ ...item, change: Math.abs(item.price - calc.sq2.price) / calc.sq2.price }))
        .sort((a, b) => b.change - a.change)[0];
      if (spread && spread.change > 0.15) add(-1, "Sensitivity", `${spread.label} would make it ${usd(spread.price)}.`);
    }
    const handsOn = calc.sq3?.handsOnPrice ?? calc.sq3?.price;
    if (!isBlocked(calc.sq3) && handsOn != null && !isBlocked(calc.sq2) && handsOn >= calc.sq2.price) {
      add(-1, "Labor", "Estimated labor sets the price.");
    }
  }

  const caveat = request.drawing?.caveat || "";
  if (/confirm[^.]*method|method[^.]*confirm/i.test(caveat)) add(-1, "Process", "The cleaning method still needs to be confirmed.");

  const score = factors.reduce((sum, factor) => sum + factor.weight, 0);
  return { level: levelOf(score), score, factors };
}

// A case's grade is its weakest line's.
export function caseConfidence(lines, view = null) {
  const graded = lines.map((line) => ({ lineId: line.lineId, ...lineConfidence(line, { recorded: view?.current.get(line.lineId) || null }) }));
  const weakest = graded.reduce((low, item) => (item.score < low.score ? item : low), graded[0]);
  return { level: weakest.level, lines: graded, weakest };
}

// Reasons in the order a reviewer should read them: what lowers it first.
export function reasonsText(grade) {
  return [...grade.factors].filter((factor) => factor.weight !== 0).sort((a, b) => a.weight - b.weight).map((factor) => factor.text);
}

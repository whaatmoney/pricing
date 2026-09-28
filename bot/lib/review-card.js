// The reviewer's card for one line: the six facts a person checks to validate
// or reject the path to a price (P/N, envelope, quantity, process, suggested
// unit price, why), each with where it came from, plus the answer lines they
// can paste back. Everything is read from the saved record; nothing here
// prices anything.

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const isBlocked = (result) => Boolean(result?.blocked?.length);
const num = (value, digits) => Number(value).toFixed(digits).replace(/\.?0+$/, "");

// The L x W x H the volume method actually priced, from its own trace.
export function pricedEnvelope(calc) {
  const raw = (calc.sq2.trace || []).map((step) => step.match(/^Raw volume ([\d.]+) x ([\d.]+) x ([\d.]+)/)).find(Boolean);
  return raw ? raw.slice(1, 4).map(Number) : null;
}

function settleText(sq5) {
  const rule = sq5.rule || "";
  if (/model inversion/.test(rule)) return "labor came out above volume, so master v2 takes the labor figure (model inversion)";
  if (/midpoint/.test(rule)) return "the two methods are within 15%, so master v2 takes their midpoint";
  if (/70\/30/.test(rule)) return `the methods differ by 15–30%, so master v2 blends 70/30 toward ${sq5.anchor?.choice}`;
  if (/credible anchor/.test(rule)) return `the methods differ by more than 30%, so master v2 takes the anchor, ${sq5.anchor?.choice}${sq5.anchor?.reason ? `: ${sq5.anchor.reason.replace(/\.$/, "")}` : ""}`;
  if (/SQ3 not run/.test(rule)) return "labor was not run, so the volume price stands";
  return rule;
}

// The path to the price, one step per method stage, in the order it ran.
export function methodPath(line) {
  const rec = line.recommendation;
  const calc = line.calculations;
  const history = line.history;
  const steps = [];
  const db = history.database.summary;
  const inv = history.invoices.summary;
  const checked = `${db.sameCustomerExact} work-order and ${inv.sameCustomerExact} invoice records for this customer and part, ${history.email.evidence.length} emails`;
  if (rec.repeatCandidates.length) {
    const po = rec.repeatCandidates[0];
    steps.push(`History: this customer issued ${rec.repeatCandidates.length === 1 ? "a PO" : `${rec.repeatCandidates.length} POs`} for this exact part, revision and scope in the last 12 months; newest ${po.poNumber}${po.revision ? ` Rev. ${po.revision}` : ""}, ${po.quantity} pcs at ${usd(po.unitPrice)} on ${po.date} (checked ${checked}).`);
  } else {
    steps.push(`History: no accepted PO from this customer for this part, revision and scope in the last 12 months (checked ${checked}).`);
  }
  const sq2 = calc.sq2;
  if (isBlocked(sq2)) {
    steps.push(`Volume (SQ2): blocked. ${sq2.blocked.join(" ")}`);
  } else {
    const c = sq2.components;
    const adders = [["length", c.lengthSurcharge?.amount], ["spec", c.specFee?.amount], ["Aclar", c.aclar]].filter(([, value]) => value).map(([name, value]) => ` + ${name} ${usd(value)}`).join("");
    const cavity = c.cavities?.charge ? ` + cavities ${usd(c.cavities.charge)}` : "";
    steps.push(`Volume (SQ2) ${usd(sq2.price)}: ${num(c.rawVolume, 4)} in³ × ${num(c.bufferedVolume / c.rawVolume, 2)} buffer → ${c.volume} in³ → bracket ${c.bracket.min}–${c.bracket.max} in³ base ${usd(c.base)}${adders}, × cleanliness ${c.cleanliness.multiplier} (level ${c.cleanliness.level}) × geometry ${c.geometry.multiplier} (${c.geometry.class})${cavity} = ${usd(sq2.unit)}, rounded to ${usd(sq2.price)}.`);
  }
  const sq3 = calc.sq3;
  if (isBlocked(sq3)) {
    steps.push(`Labor (SQ3): blocked. ${sq3.blocked.join(" ")}`);
  } else {
    const perPart = (sq3.trace || []).map((step) => step.match(/^PER-PART tech-minutes = ([\d.]+)/)).find(Boolean)?.[1];
    const lot = (sq3.trace || []).map((step) => step.match(/^LOT tech-minutes = ([\d.]+)/)).find(Boolean)?.[1];
    const estimated = (sq3.steps || []).filter((step) => step.basis !== "measured").length;
    const times = estimated ? `${estimated} of ${sq3.steps.length} step times are estimates.` : "All step times measured.";
    steps.push(sq3.handsOnPrice != null
      ? `Labor (SQ3) ${usd(sq3.handsOnPrice)} hands-on: ${perPart} min per part at $${sq3.components.rate}/h. The ${lot} lot-setup minutes are left out because the lot minimum recovers them (spread over ${sq3.batch.size} parts they would make ${usd(sq3.price)}). ${times}`
      : `Labor (SQ3) ${usd(sq3.price)}: ${perPart} hands-on min per part + ${lot} lot-minutes spread over ${sq3.batch.size} parts, at $${sq3.components.rate}/h. ${times}`);
  }
  // Only rulings that change how the settle step works belong on it.
  const settleRulings = (line.rulings || []).filter((id) => id.startsWith("hands-on-labor"));
  const rulings = settleRulings.length ? `. Ruling applied: ${settleRulings.join(", ")}` : "";
  if (!isBlocked(calc.sq5)) steps.push(`Settle (SQ5) ${usd(calc.sq5.settled)}: ${settleText(calc.sq5)}${rulings}.`);
  if (rec.preferred?.lotCharge != null) steps.push(`Lot minimum: ${usd(rec.preferred.unitPrice)} × ${line.request.quantity} = ${usd(rec.preferred.extended)}, under the ${usd(rec.preferred.lotCharge)} lot minimum, so the lot minimum is charged.`);
  if (rec.preferred) {
    const chain = calc.sq5?.settled;
    steps.push(rec.preferred.basis.startsWith("REPEAT-ACCEPTED")
      ? `Pick ${usd(rec.preferred.unitPrice)}: rule ${rec.policy.id} (${rec.policy.status}) holds the accepted PO price over the chain's ${usd(chain)}.`
      : `Pick ${usd(rec.preferred.unitPrice)}: no accepted PO applies, so the chain's settled price stands (rule ${rec.policy.id}).`);
  } else {
    steps.push(`Pick: none. ${rec.uncalculated}`);
  }
  return steps;
}

// Assumptions the reviewer should confirm, from the method's own flags.
export function assumptions(line) {
  const calc = line.calculations;
  const flags = [...(calc.sq2.flags || []), ...(calc.sq5?.flags || [])].filter(Boolean);
  return flags.filter((flag) => /ASM|NOT PROVIDED|INACTIVE|not in fee table|\(LOW\)|\(MED\)|MED$|not specified/i.test(flag));
}

export function reviewCard(line, decision) {
  const { request, recommendation: rec, calculations: calc } = line;
  const envelope = pricedEnvelope(calc);
  const tiers = request.quantityAlternatives?.length ? `; quoted alongside ${request.quantityAlternatives.join(" and ")} ${request.uom}` : "";
  const drawn = request.drawing?.dimensions;
  const drawnText = drawn?.summary || (drawn ? `ø${drawn.maxOdAfterCoating} in max OD after coating × ${drawn.F_max} in thick` : null);
  return [
    { field: "pn", label: "P/N", value: `${request.partNumber} Rev. ${request.revision}${request.description ? ` — ${request.description}` : ""}`, source: `${decision.customer.name}${decision.rfq.reference ? `, ${decision.rfq.reference}` : ""}` },
    { field: "envelope", label: "Envelope Dimensions", value: envelope ? `${envelope.join(" × ")} in (L × W × H priced)` : "not priced", source: [drawnText ? `print: ${drawnText}` : null, (calc.sq2.flags || []).find((flag) => String(flag).startsWith("DIM:"))].filter(Boolean).join("; ") },
    { field: "qty", label: "Qty", value: `${request.quantity} ${request.uom}${tiers}`, source: "RFQ" },
    { field: "process", label: "Process", value: request.process.verbatim, source: request.process.source },
    { field: "price", label: "Suggested Unit Price", value: !rec.preferred ? "none" : rec.preferred.lotCharge != null ? `${usd(rec.preferred.unitPrice)}/ea with the ${usd(rec.preferred.lotCharge)} lot minimum (${usd(rec.preferred.lotCharge)} for ${request.quantity})` : `${usd(rec.preferred.unitPrice)}/ea (${usd(rec.preferred.extended)} for ${request.quantity})`, source: rec.preferred ? `${rec.preferred.label}; rule ${rec.policy.id} (${rec.policy.status})` : rec.uncalculated },
    { field: "why", label: "Why", steps: methodPath(line), assumptions: assumptions(line) },
  ];
}

// Lines a reviewer can paste back as their answer; bot/lib/answer.js reads them.
export function answerLines(line, decision, { flatExtended } = {}) {
  const head = `${decision.caseId} v${decision.lifecycle.recommendationVersion} ${line.lineId}`;
  const { recommendation: rec, calculations: calc } = line;
  const lines = [];
  if (rec.preferred) lines.push({ label: "Approve the suggested price", text: `${head} approve ${rec.preferred.unitPrice.toFixed(2)}` });
  for (const option of rec.alternatives || []) lines.push({ label: `Choose: ${option.label}`, text: `${head} alt ${option.unitPrice.toFixed(2)} — ${option.label}` });
  if (flatExtended != null) lines.push({ label: "Choose the volume price with the lot minimum", text: `${head} alt ${calc.sq2.price.toFixed(2)} — volume price with the ${usd(rec.lotMinimum.minimum)} lot minimum` });
  lines.push({ label: "A fact on the card is wrong (field: pn, envelope, qty, process)", text: `${head} correct envelope: ` });
  lines.push({ label: "The path to the price is right", text: `${head} method ok` });
  lines.push({ label: "The path to the price is wrong (say which step)", text: `${head} method wrong why: ` });
  return lines;
}

// One line approving every line at its suggested price, for multi-line cases.
export function approveAllLine(decision) {
  if (decision.lines.length < 2 || decision.lines.some((line) => !line.recommendation.preferred)) return null;
  return `${decision.caseId} v${decision.lifecycle.recommendationVersion} all approve ${decision.lines.map((line) => line.recommendation.preferred.unitPrice.toFixed(2)).join("/")}`;
}

// The block a reviewer pastes into the RFQ response: one entry per line with
// P/N, Qty, Unit Price and Process. It uses the recorded decision's price when
// there is one (a correction leaves the line undecided) and otherwise the
// suggested price, and says which it is outside the copied text.
export function quoteSummary(decision, view) {
  const entries = decision.lines.map((line) => {
    const { request, recommendation: rec } = line;
    const recorded = view?.current.get(line.lineId);
    const decided = recorded && recorded.choice !== "correction" ? recorded : null;
    const unitPrice = decided ? decided.unitPrice : rec.preferred?.unitPrice ?? null;
    const minimum = rec.lotMinimum?.minimum ?? null;
    const extended = unitPrice == null ? null : Math.round(unitPrice * request.quantity * 100) / 100;
    const lotCharge = extended != null && minimum != null && extended < minimum ? minimum : null;
    const price = unitPrice == null ? "not priced" : lotCharge != null
      ? `${usd(unitPrice)}/ea (${usd(extended)} for ${request.quantity}; lot minimum applies: ${usd(lotCharge)} total)`
      : `${usd(unitPrice)}/ea (${usd(extended)} total)`;
    return {
      lineId: line.lineId,
      state: decided ? `${decided.choice} by ${decided.decidedBy}` : recorded?.choice === "correction" ? "correction requested — not approved" : "suggested — not approved yet",
      approved: Boolean(decided),
      text: [`P/N: ${request.partNumber} Rev. ${request.revision}`, `Qty: ${request.quantity} ${request.uom}`, `Unit Price: ${price}`, "", `Process: ${request.process.verbatim}`].join("\n"),
    };
  });
  return { entries, text: entries.map((entry) => entry.text).join("\n\n"), allApproved: entries.every((entry) => entry.approved) };
}

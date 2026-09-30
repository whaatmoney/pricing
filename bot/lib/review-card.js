// The reviewer's card for one line: the six facts a person checks to validate
// or reject the path to a price (P/N, envelope, quantity, process, suggested
// unit price, why), each with where it came from, plus the answer lines they
// can paste back. Everything is read from the saved record; nothing here
// prices anything.

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const isBlocked = (result) => Boolean(result?.blocked?.length);
const num = (value, digits) => Number(value).toFixed(digits).replace(/\.?0+$/, "");

// A revision is shown only when the request states a real one (a short code
// such as "A" or "NC"); it is never used to match anything.
export const revSuffix = (request) => (/^[A-Z0-9][A-Z0-9.\-]{0,5}$/i.test(String(request?.revision ?? "").trim()) ? ` Rev. ${String(request.revision).trim()}` : "");

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
    steps.push(`History: this customer issued ${rec.repeatCandidates.length === 1 ? "a PO" : `${rec.repeatCandidates.length} POs`} for this exact part and scope in the last 12 months; newest ${po.poNumber}${po.revision ? ` Rev. ${po.revision}` : ""}, ${po.quantity} pcs at ${usd(po.unitPrice)} on ${po.date} (checked ${checked}).`);
  } else {
    steps.push(`History: no accepted PO from this customer for this part and scope in the last 12 months (checked ${checked}).`);
  }
  const sq2 = calc.sq2;
  if (isBlocked(sq2)) {
    steps.push(`Volume (SQ2): blocked. ${sq2.blocked.join(" ")}`);
  } else if (sq2.source === "calculator") {
    const c = sq2.components;
    const adders = [["length", c.length], ["spec", c.spec], ["packaging", c.packaging?.charge]].filter(([, value]) => value).map(([name, value]) => ` + ${name} ${usd(value)}`).join("");
    const m = c.multipliers;
    steps.push(`Volume (calculator) ${usd(sq2.price)}: ${num(c.rawVolume, 4)} in³ × 1.1 buffer = ${num(c.volume, 4)} in³ → base ${usd(c.base)}${adders}, × process ${m.process} × size ${m.size} × weight ${m.weight} × complexity ${m.complexity} (${c.complexityKey}${c.complexityReason ? `: ${c.complexityReason}` : ""}) = ${usd(sq2.unit)}, rounded to ${usd(sq2.price)}. No per-hole charges (ruling calculator-volume-v1).`);
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
      : rec.preferred.basis.startsWith("PREVIOUS-QUOTE")
        ? `Pick ${usd(rec.preferred.unitPrice)}: no accepted PO applies; rule previous-quote-hold-v1 matches QPC's previous quote over the chain's ${usd(chain)}.`
        : `Pick ${usd(rec.preferred.unitPrice)}: no accepted PO or previous quote applies, so the chain's settled price stands (rule ${rec.policy.id}).`);
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
    { field: "pn", label: "P/N", value: `${request.partNumber}${revSuffix(request)}${request.description ? ` — ${request.description}` : ""}`, source: `${decision.customer.name}${decision.rfq.reference ? `, ${decision.rfq.reference}` : ""}` },
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

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Where a suggested price came from. A price taken from history always carries
// the date it was given (and the quantity it was given for), so the reviewer
// sees how old it is without opening the reasoning.
export function priceSource(preferred) {
  if (!preferred) return null;
  const basis = preferred.basis || "";
  const date = basis.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || null;
  const when = date ? longDate(date) : "an unrecorded date";
  if (basis.startsWith("REPEAT-ACCEPTED")) {
    const qty = basis.match(/, (\d[\d,]*) pcs at/)?.[1];
    return { kind: "po", date, text: `customer PO of ${when}${qty ? ` · ${qty} pcs` : ""}` };
  }
  if (basis.startsWith("PREVIOUS-QUOTE")) {
    const qty = basis.match(/QPC quoted (\d[\d,]*) pcs/)?.[1];
    return { kind: "quote", date, text: `QPC quote of ${when}${qty ? ` · ${qty} pcs` : ""}` };
  }
  return { kind: "method", date: null, text: "calculator · no price history" };
}

// The PO total against the lot minimum (ruling lot-minimum-per-po-v1) at the
// recorded prices where there are any and the suggested ones otherwise. Null
// for one-part cases, where each line is checked on its own.
export function poTotal(decision, view) {
  const po = decision.poLotMinimum;
  if (!po) return null;
  const counted = decision.lines.filter((line) => po.lineIds.includes(line.lineId));
  const prices = counted.map((line) => {
    const recorded = view?.current.get(line.lineId);
    const decided = recorded && recorded.choice !== "correction" ? recorded : null;
    return { line, unitPrice: decided ? decided.unitPrice : line.recommendation.preferred?.unitPrice ?? null };
  });
  const unpriced = prices.filter((item) => item.unitPrice == null).map((item) => item.line.lineId);
  const extended = prices.reduce((sum, item) => sum + (item.unitPrice == null ? 0 : Math.round(item.unitPrice * item.line.request.quantity * 100)), 0) / 100;
  const charge = extended < po.minimum ? po.minimum : extended;
  const text = `PO total for all parts at these prices: ${usd(extended)}${unpriced.length ? ` (${unpriced.join(", ")} not priced)` : ""}${extended < po.minimum ? `, under the ${usd(po.minimum)} lot minimum, so the PO is charged ${usd(po.minimum)}.` : ", at or above the lot minimum."}`;
  return { extended, minimum: po.minimum, charge, below: extended < po.minimum, unpriced, text };
}

const joinQuantities =(items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} & ${items.at(-1)}`);

// The text a reviewer pastes into the RFQ response. Lines of one part with the
// same process and unit price share an entry ("Qty: 18, 54 & 72"). One process
// shared by every entry is written once, where the template's {{process}}
// sits; different processes go under each entry instead. The template (the
// reviewer's own wording, terms and lot minimum) lives in private config;
// without one the text is the entries and process alone. Prices are the
// recorded decision's when there is one (a correction leaves the line
// undecided) and otherwise the suggested ones; the page says which.
export function quoteSummary(decision, view, { template = null } = {}) {
  const lines = decision.lines.map((line) => {
    const recorded = view?.current.get(line.lineId);
    const decided = recorded && recorded.choice !== "correction" ? recorded : null;
    return {
      line,
      unitPrice: decided ? decided.unitPrice : line.recommendation.preferred?.unitPrice ?? null,
      lineId: line.lineId,
      source: decided && decided.unitPrice !== line.recommendation.preferred?.unitPrice ? null : priceSource(line.recommendation.preferred),
      state: decided ? `${decided.choice} by ${decided.decidedBy}` : recorded?.choice === "correction" ? "correction requested — not approved" : "suggested — not approved yet",
      approved: Boolean(decided),
    };
  });
  const groups = new Map();
  for (const item of lines) {
    const { request } = item.line;
    const key = JSON.stringify([request.partNumber, request.process.verbatim, item.unitPrice]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const processes = new Set(lines.map((item) => item.line.request.process.verbatim));
  const shared = processes.size === 1 ? [...processes][0] : null;
  const blocks = [...groups.values()].map((group) => {
    const { request } = group[0].line;
    const quantities = group.map((item) => `${item.line.request.quantity}${item.line.request.uom && item.line.request.uom !== "EA" ? ` ${item.line.request.uom}` : ""}`);
    const price = group[0].unitPrice == null ? "not priced" : usd(group[0].unitPrice);
    const revision = revSuffix(request);
    return [`P/N: ${request.partNumber}${revision}`, `Qty: ${joinQuantities(quantities)}`, `Unit Price: ${price}`]
      .concat(shared == null ? [`Process: ${request.process.verbatim}`] : []).join("\n");
  });
  const parts = blocks.join("\n\n");
  const process = shared == null ? "" : `Process: ${shared}`;
  const text = template
    ? template.replace("{{parts}}", parts).replace("{{process}}", process).replace(/\n{3,}/g, "\n\n").trim()
    : [parts, process].filter(Boolean).join("\n\n");
  return { entries: lines.map(({ lineId, source, state, approved }) => ({ lineId, source, state, approved })), text, allApproved: lines.every((item) => item.approved) };
}

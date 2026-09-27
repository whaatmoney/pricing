// Deterministic implementation of the PriceGPT Master v2 pricing chain as
// captured on 2026-09-26: SQ2 (non-tube structural), SQ3 (throughput), SQ4
// (negotiation band) and SQ5 (quote-unit stabilization). SQ0/SQ1 inputs,
// SQ3 step times, the SQ5 credible anchor and SQ6 judgment come from people or
// from AI extraction and are passed in with their basis; this code only does
// the arithmetic, in exact integer micro-dollars so rounding ties cannot be
// decided by floating-point noise.

export const METHOD_ID = "PriceGPT-Master-v2";

const MICRO = 1_000_000;
const cents = (dollars) => Math.round(dollars * 100);
const hundredths = (multiplier) => Math.round(multiplier * 100);
const toDollars = (micro) => micro / MICRO;

// Half-up rounding to `step` dollars, exact on integer micro-dollars.
export function roundToStep(micro, step) {
  const stepMicro = Math.round(step * MICRO);
  const lower = Math.floor(micro / stepMicro) * stepMicro;
  const remainder = micro - lower;
  const tie = remainder * 2 === stepMicro;
  const value = remainder * 2 >= stepMicro ? lower + stepMicro : lower;
  return { value: toDollars(value), tie };
}

function geometryMultiplier(rules, geometry) {
  if (rules.geometry[geometry] != null) return { name: geometry, value: rules.geometry[geometry] };
  const key = Object.keys(rules.geometry).find((name) => name.toLowerCase().startsWith(String(geometry).toLowerCase()));
  return key ? { name: key, value: rules.geometry[key] } : null;
}

// SQ2 non-tube: ((Base + Length + Spec + Aclar) x Cleanliness x Geometry) + (Cavity x Cleanliness) + Handling
export function sq2NonTube(input, rules) {
  const flags = [...(input.flags || [])];
  const blocked = [];
  const trace = [];
  const { length: L, width: W, height: H } = input.envelope || {};
  if (!(L > 0 && W > 0 && H > 0)) blocked.push("Envelope L x W x H is required (drawing, customer dimensions or a flagged category default).");

  const cleanliness = rules.cleanliness[String(input.cleanliness)];
  if (cleanliness == null) blocked.push(`No cleanliness multiplier for level "${input.cleanliness}".`);
  const geometry = geometryMultiplier(rules, input.geometry);
  if (!geometry) blocked.push(`No geometry multiplier for class "${input.geometry}".`);
  if (input.lengthSurcharge?.amount == null) blocked.push("Length surcharge amount and basis are required; the captured sources contain no length schedule.");
  if (input.specFee?.amount == null) blocked.push("Spec fee amount and basis are required.");
  if (input.aclar?.required && !(input.aclar.areaSquareFeet > 0)) blocked.push("Aclar is required but the packaged area (ft²) is unknown.");
  if (blocked.length) return { method: `${METHOD_ID}/SQ2-non-tube`, blocked, flags, trace };

  const raw = L * W * H;
  const buffered = raw * rules.volumeBuffer;
  const volume = Math.max(1, Math.ceil(buffered - 1e-9));
  trace.push(`Raw volume ${L} x ${W} x ${H} = ${raw.toFixed(4)} in³`);
  trace.push(`Buffered x ${rules.volumeBuffer} = ${buffered.toFixed(4)} in³, rounded up to ${volume} in³`);
  const brackets = rules.volumeTable.filter((row) => row.min <= volume && volume <= row.max);
  if (brackets.length !== 1) {
    const detail = brackets.length
      ? `${volume} in³ falls in ${brackets.length} brackets (${brackets.map((row) => `${row.min}-${row.max} → $${row.base.toFixed(2)}`).join("; ")})`
      : `${volume} in³ is outside every bracket`;
    return { method: `${METHOD_ID}/SQ2-non-tube`, blocked: [`Volume table cannot resolve: ${detail}.`], flags: [...flags, "VOLUME BRACKET UNRESOLVED"], trace };
  }
  const bracket = brackets[0];
  const baseDollars = Math.max(bracket.base, rules.baseMinimum);
  trace.push(`Bracket ${bracket.min}-${bracket.max} in³ → base $${bracket.base.toFixed(2)}${baseDollars !== bracket.base ? `, raised to minimum $${rules.baseMinimum.toFixed(2)}` : ""}`);

  const cavityCounts = { A: 0, B: 0, C: 0, D: 0, ...(input.cavities || {}) };
  const cavityCents = Object.entries(cavityCounts).reduce((sum, [tier, count]) => sum + count * cents(rules.cavityTiers[tier] || 0), 0);
  const aclarCents = input.aclar?.required ? Math.round(input.aclar.areaSquareFeet * rules.packagingPerSquareFoot.Aclar * 100) : 0;
  const subtotalCents = cents(baseDollars) + cents(input.lengthSurcharge.amount) + cents(input.specFee.amount) + aclarCents;
  const multipliedMicro = subtotalCents * hundredths(cleanliness) * hundredths(geometry.value);
  const cavityMicro = cavityCents * hundredths(cleanliness) * 100;
  const handlingMicro = 0;
  const unitMicro = multipliedMicro + cavityMicro + handlingMicro;
  const rounding = roundToStep(unitMicro, unitMicro <= 50 * MICRO ? 0.25 : 0.5);

  trace.push(`Subtotal = base $${baseDollars.toFixed(2)} + length $${input.lengthSurcharge.amount.toFixed(2)} + spec $${input.specFee.amount.toFixed(2)} + Aclar $${(aclarCents / 100).toFixed(2)} = $${(subtotalCents / 100).toFixed(2)}`);
  trace.push(`x cleanliness ${cleanliness} (level ${input.cleanliness}) x geometry ${geometry.value} (${geometry.name}) = $${toDollars(multipliedMicro).toFixed(4)}`);
  trace.push(`+ cavities ${JSON.stringify(cavityCounts)} = $${(cavityCents / 100).toFixed(2)} x cleanliness ${cleanliness} = $${toDollars(cavityMicro).toFixed(4)} (geometry not applied, invariant 18)`);
  trace.push("+ handling adder $0.00 (governed table inactive)");
  trace.push(`= $${toDollars(unitMicro).toFixed(4)} → rounded to nearest $${unitMicro <= 50 * MICRO ? "0.25" : "0.50"} = $${rounding.value.toFixed(2)}${rounding.tie ? " (exact tie, rounded half-up)" : ""}`);

  flags.push("HANDLING TABLE INACTIVE");
  if (rounding.tie) flags.push("ROUNDING TIE");
  return {
    method: `${METHOD_ID}/SQ2-non-tube`,
    blocked: [],
    unit: toDollars(unitMicro),
    price: rounding.value,
    components: {
      rawVolume: raw,
      bufferedVolume: buffered,
      volume,
      bracket,
      base: baseDollars,
      lengthSurcharge: input.lengthSurcharge,
      specFee: input.specFee,
      aclar: aclarCents / 100,
      cleanliness: { level: String(input.cleanliness), multiplier: cleanliness },
      geometry: { class: geometry.name, multiplier: geometry.value },
      cavities: { counts: cavityCounts, charge: cavityCents / 100 },
      handlingAdder: 0,
    },
    flags,
    trace,
  };
}

const STEP_CLASSES = new Set(["LOT", "PER-PART", "PASSIVE"]);

// SQ3: Labor-min/part = PART_techmin + LOT_techmin / batch; x $rate/hr.
export function sq3Throughput(input, rules) {
  const blocked = [];
  const flags = [];
  const trace = [];
  const quantity = input.quantity;
  const batch = input.batch?.size;
  if (!(quantity > 0)) blocked.push("Quantity is required.");
  if (!(batch > 0)) blocked.push("A normal-day batch size is required.");
  else if (batch > quantity) blocked.push(`Batch ${batch} exceeds quantity ${quantity}.`);
  if (!Array.isArray(input.steps) || !input.steps.length) blocked.push("A step table is required.");
  for (const step of input.steps || []) {
    if (!STEP_CLASSES.has(step.class)) blocked.push(`Step "${step.step}" has class "${step.class}"; use LOT, PER-PART or PASSIVE.`);
    if (!(step.minutes >= 0)) blocked.push(`Step "${step.step}" needs minutes.`);
  }
  if (blocked.length) return { method: `${METHOD_ID}/SQ3-throughput`, blocked, flags, trace };

  let partTechMinutes = 0;
  let lotTechMinutes = 0;
  let passiveMinutes = 0;
  for (const step of input.steps) {
    const techs = step.techs ?? 1;
    const techMinutes = step.minutes * techs;
    if (step.class === "PER-PART") partTechMinutes += techMinutes;
    else if (step.class === "LOT") lotTechMinutes += techMinutes;
    else if (step.techTied) {
      lotTechMinutes += techMinutes;
      flags.push(`PASSIVE TIME CHARGED: ${step.step}`);
    } else passiveMinutes += step.minutes;
  }
  const laborMinutesPerPart = partTechMinutes + lotTechMinutes / batch;
  const laborHoursPerPart = laborMinutesPerPart / 60;
  const unit = laborHoursPerPart * rules.laborRate;
  trace.push(`PER-PART tech-minutes = ${partTechMinutes.toFixed(3)} (not divided by quantity)`);
  trace.push(`LOT tech-minutes = ${lotTechMinutes.toFixed(1)} spread over batch ${batch} = ${(lotTechMinutes / batch).toFixed(4)} min/part`);
  trace.push(`PASSIVE minutes excluded = ${passiveMinutes.toFixed(1)}`);
  trace.push(`Labor = ${laborMinutesPerPart.toFixed(4)} min/part = ${laborHoursPerPart.toFixed(6)} h x $${rules.laborRate.toFixed(2)}/h = $${unit.toFixed(4)}`);

  const estimated = input.steps.filter((step) => step.basis !== "measured");
  if (estimated.length) flags.push(`ASM: ${estimated.length} of ${input.steps.length} step times are estimates, not measured`);
  if (input.batch.basis !== "measured") flags.push("ASM: batch size assumed");
  const confidence = estimated.length === 0 && input.batch.basis === "measured" ? "High" : estimated.length < input.steps.length ? "Medium" : "Low";
  return {
    method: `${METHOD_ID}/SQ3-throughput`,
    blocked: [],
    unit,
    price: Math.round(unit * 100) / 100,
    components: { partTechMinutes, lotTechMinutes, passiveMinutes, batch, quantity, laborMinutesPerPart, laborHoursPerPart, rate: rules.laborRate },
    confidence,
    flags,
    trace,
  };
}

function divergence(sq2, sq3) {
  return Math.abs(sq2 - sq3) / sq2;
}

// SQ5: <=15% midpoint; 15-30% 70/30 credible/other; >30% credible anchor.
// The master says to "select credible anchor by category" but defines no
// category table, so the anchor is an explicit input with a stated reason.
export function sq5Stabilize({ sq2, sq3, anchor }) {
  const flags = ["DIVERGENCE = |SQ2 - SQ3| / SQ2 (denominator not specified in master)"];
  if (sq3 == null) {
    const rounding = roundToStep(Math.round(sq2 * MICRO), sq2 <= 50 ? 0.5 : 1);
    return { method: `${METHOD_ID}/SQ5`, blocked: [], rule: "SQ3 not run", settled: rounding.value, flags: [...flags, "S3N"] };
  }
  const diff = divergence(sq2, sq3);
  const a = cents(sq2);
  const b = cents(sq3);
  let blendedMicro;
  let rule;
  if (diff <= 0.15) {
    blendedMicro = (a + b) * 5000;
    rule = "divergence <= 15%: midpoint";
  } else if (sq2 < sq3) {
    blendedMicro = b * 10000;
    rule = "model inversion (SQ2 < SQ3)";
  } else {
    if (!anchor || !["SQ2", "SQ3"].includes(anchor.choice)) {
      return { method: `${METHOD_ID}/SQ5`, blocked: [`Divergence ${(diff * 100).toFixed(1)}% needs a credible anchor (SQ2 or SQ3) with a reason; the master defines no anchor-by-category table.`], divergence: diff, flags };
    }
    const credible = anchor.choice === "SQ2" ? a : b;
    const other = anchor.choice === "SQ2" ? b : a;
    if (diff <= 0.3) {
      blendedMicro = (7 * credible + 3 * other) * 1000;
      rule = `15-30%: 70/30 toward ${anchor.choice}`;
    } else {
      blendedMicro = credible * 10000;
      rule = `> 30%: credible anchor ${anchor.choice}`;
    }
  }
  let settledMicro = blendedMicro;
  if (sq2 < sq3) {
    settledMicro = b * 10000;
    if (!rule.startsWith("model inversion")) rule += "; model inversion (SQ2 < SQ3) → SQ3";
    flags.push("INV");
  }
  const rounding = roundToStep(settledMicro, settledMicro <= 50 * MICRO ? 0.5 : 1);
  if (rounding.tie) flags.push("ROUNDING TIE");
  return { method: `${METHOD_ID}/SQ5`, blocked: [], divergence: diff, rule, anchor: anchor || null, blended: toDollars(blendedMicro), unrounded: toDollars(settledMicro), settled: rounding.value, flags };
}

// SQ4 is negotiation context only; it never sets the quote unit.
export function sq4Band({ sq2, sq3, anchor, widen, rules }) {
  const stabilized = sq5Stabilize({ sq2, sq3, anchor });
  if (stabilized.blocked?.length) return { blocked: stabilized.blocked };
  const flags = [];
  const blended = stabilized.blended ?? stabilized.settled;
  const factor = widen ? 1.2 : 1.15;
  const round50 = (value) => roundToStep(Math.round(value * MICRO), 0.5).value;
  let low = blended * 0.9;
  if (anchor?.choice) low = Math.max(anchor.choice === "SQ3" ? sq3 : sq2, low);
  else flags.push("SQ4 LOW uses blended x 0.90 only; no credible anchor was chosen");
  const band = { low: round50(low), mid: round50(blended), high: round50(blended * factor), highFactor: factor, lotMinimum: rules.lotMinimum, flags };
  if (band.low > band.mid) flags.push("SQ4 LOW exceeds MID: the master's LOW = max(anchor, blended x 0.90) puts the anchor above the blend");
  return band;
}

export function lotMinimumCheck(unitPrice, quantity, rules) {
  const extended = Math.round(unitPrice * quantity * 100) / 100;
  return { extended, minimum: rules.lotMinimum, passes: extended >= rules.lotMinimum };
}

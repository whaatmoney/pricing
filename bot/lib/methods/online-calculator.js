import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

// Runs the published first-pass calculator's own lookup tables and helper
// functions (whaatmoney/calculator index.html), so this path stays at parity
// with the page instead of a hand-copied formula. If the page's formula lines
// change, the result is marked as drifted rather than silently recomputed.

export const METHOD_ID = "online-calculator";

const FORMULA_LINES = [
  "const volume = L * W * H * VOL_BUFFER;",
  "const loadedBase = basePrice + cavity + lenSur + specFee + pkgCost;",
  "const unitPrice = loadedBase * procMult * sizeMult * wtMult * cmpMult;",
];

export function loadCalculator(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const start = html.indexOf("const VOL_BUFFER");
  const end = html.indexOf("/* ================== COMPUTE");
  if (start < 0 || end < start) throw new Error(`Calculator layout changed; lookup data not found in ${htmlPath}`);
  const code = `${html.slice(start, end)}\n({ VOL_BUFFER, PROCESS, SIZE, WEIGHT, COMPLEXITY, END_USER_FEE, VOLUME_TABLE, lookupBasePrice, autoSize, lengthSurcharge, packagingCost });`;
  const api = vm.runInContext(code, vm.createContext({ document: { getElementById: () => null, querySelector: () => null } }));
  return {
    path: htmlPath,
    sha256: crypto.createHash("sha256").update(html).digest("hex"),
    formulaDrift: FORMULA_LINES.filter((line) => !html.includes(line)),
    ...api,
  };
}

// Mirrors compute(): (Base + Cavity + Length + Spec + Packaging) x Process x Size x Weight x Complexity.
export function calculatorPrice(input, calculator) {
  const { length: L, width: W, height: H } = input.envelope;
  const blocked = [];
  if (!(L > 0 && W > 0 && H > 0)) blocked.push("Envelope L x W x H is required.");
  if (calculator.PROCESS[input.process] == null) blocked.push(`No process multiplier for "${input.process}".`);
  if (blocked.length) return { method: METHOD_ID, blocked };

  const maxDim = Math.max(L, W, H);
  const volume = L * W * H * calculator.VOL_BUFFER;
  const sizeKey = input.size || calculator.autoSize(maxDim);
  const weightKey = input.weight || "< 10 lb";
  const complexityKey = input.complexity || "Standard";
  const endUser = input.endUser || "None";
  const packaging = input.packaging || "None";
  const base = calculator.lookupBasePrice(volume);
  const length = calculator.lengthSurcharge(maxDim);
  const spec = calculator.END_USER_FEE[endUser] ?? 0;
  const pack = calculator.packagingCost(packaging, L, W, H, maxDim);
  const cavity = input.cavityDollars || 0;
  const loaded = base + cavity + length + spec + pack;
  const multipliers = {
    process: calculator.PROCESS[input.process],
    size: calculator.SIZE[sizeKey],
    weight: calculator.WEIGHT[weightKey],
    complexity: calculator.COMPLEXITY[complexityKey],
  };
  const unit = loaded * multipliers.process * multipliers.size * multipliers.weight * multipliers.complexity;
  const flags = [];
  if (calculator.formulaDrift.length) flags.push("CALCULATOR FORMULA DRIFT: parity not verified");
  return {
    method: `${METHOD_ID}@sha256:${calculator.sha256.slice(0, 12)}`,
    blocked: [],
    unit,
    price: Math.round(unit * 100) / 100,
    components: { volume, maxDim, base, cavity, length, spec, endUser, packaging: { type: packaging, charge: pack }, sizeKey, weightKey, complexityKey, loaded, multipliers },
    trace: [
      `Volume ${L} x ${W} x ${H} x ${calculator.VOL_BUFFER} = ${volume.toFixed(4)} in³ (no round-up) → base $${base.toFixed(2)}`,
      `Loaded base = $${base.toFixed(2)} + cavity $${cavity.toFixed(2)} + length $${length.toFixed(2)} + spec $${spec.toFixed(2)} (${endUser}) + packaging $${pack.toFixed(2)} (${packaging}) = $${loaded.toFixed(2)}`,
      `x process ${multipliers.process} (${input.process}) x size ${multipliers.size} (${sizeKey}) x weight ${multipliers.weight} (${weightKey}) x complexity ${multipliers.complexity} (${complexityKey}) = $${unit.toFixed(4)}`,
    ],
    flags,
  };
}

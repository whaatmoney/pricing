import fs from "node:fs";
import path from "node:path";
import { latestDecisions } from "./board.js";
import { buildDecision } from "./decision.js";
import { lifecyclePath, readLifecycle } from "./lifecycle.js";
import { readManifest } from "./router-snapshot.js";
import { nextVersion } from "./versioning.js";

// Freshness check (pricing owner, 2026-10-26: "auto re-price undecided cards
// on new Router History"). When a newer weekly export is in, every open page
// with no recorded decision is priced again in memory. Same price and same
// history: the page stays as it is and the check is stamped. Anything moved:
// the page is rebuilt as the next version, exactly as `decide` would. A case
// with any recorded decision is never rebuilt here.

// The engine inputs for one case from the private config, shared by `decide`
// and `recheck` so both price a case the same way.
export function decisionOptions(config, casePath) {
  return {
    casePath,
    storeDir: config.storeDir,
    routerFolder: config.routerHistoryFolder,
    salesExportPath: config.salesExport,
    priceLabDir: config.priceLabDir,
    calculatorHtml: config.calculatorHtml,
    // A retired monitor's frozen file says nothing about how fresh the mail is.
    monitorStatePath: config.monitorRetiredAt ? null : config.monitorState,
  };
}

// Writes a built decision as its next version (or rewrites the same version
// when nothing in its inputs changed). The caller renders the page.
export function saveDecision(outputsDir, decision) {
  const stem = `CLAUDE-DECISION-${decision.caseId}`;
  const { version, reused, supersedes } = nextVersion(outputsDir, stem, decision.inputsFingerprint);
  decision.lifecycle.recommendationVersion = version;
  decision.lifecycle.supersedes = supersedes;
  const base = path.join(outputsDir, `${stem}-v${version}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(decision, null, 2));
  return { version, reused, supersedes, base };
}

export function readRecheck(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).checks || [];
  } catch {
    return [];
  }
}

// What a page shows for one line: the suggested price and every history row
// behind it. A difference in any of these is a reason to rebuild. The wording
// of why a line has no price is left out: it comes from the case's missing
// facts and the engine, not from Router History, and a newer engine's wording
// alone must not make a new version.
function lineSummary(line) {
  const preferred = line.recommendation.preferred;
  return {
    price: preferred?.unitPrice ?? null,
    lotCharge: preferred?.lotCharge ?? null,
    label: preferred?.label ?? null,
    rows: (line.history?.timeline || []).map((row) => [row.source, row.date, row.evidence, row.unitPrice].join("|")),
  };
}

export function compareDecisions(before, after) {
  const changes = [];
  const count = Math.max(before.lines.length, after.lines.length);
  for (let index = 0; index < count; index++) {
    const a = before.lines[index] ? lineSummary(before.lines[index]) : null;
    const b = after.lines[index] ? lineSummary(after.lines[index]) : null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const added = b ? b.rows.filter((row) => !(a?.rows || []).includes(row)).length : 0;
    changes.push({ lineId: (after.lines[index] || before.lines[index]).lineId, from: a?.price ?? null, to: b?.price ?? null, newRows: added });
  }
  if (JSON.stringify(before.poLotMinimum ?? null) !== JSON.stringify(after.poLotMinimum ?? null)) changes.push({ lineId: "PO", from: before.poLotMinimum?.charge ?? null, to: after.poLotMinimum?.charge ?? null, newRows: 0 });
  return changes;
}

// Case files by case id. A file that does not parse is skipped, not fatal.
function caseFiles(casesDir) {
  const files = new Map();
  if (!casesDir || !fs.existsSync(casesDir)) return files;
  for (const name of fs.readdirSync(casesDir).filter((item) => item.endsWith(".json")).sort()) {
    try {
      const caseId = JSON.parse(fs.readFileSync(path.join(casesDir, name), "utf8")).caseId;
      if (caseId && !files.has(caseId)) files.set(caseId, path.join(casesDir, name));
    } catch {}
  }
  return files;
}

const KEEP = 2000;

// openCaseIds: the cases the board shows as waiting. Only those are checked.
// build(casePath) returns a fresh decision; injected so tests can count builds.
export function recheckCases({ config, openCaseIds, now = new Date(), build = (casePath) => buildDecision(decisionOptions(config, casePath)) }) {
  const manifest = readManifest(config.storeDir);
  const current = manifest.current;
  const snapshotFile = manifest.snapshots?.[current]?.fileName || null;
  const checks = readRecheck(config.recheckFile);
  const done = new Set(checks.map((check) => `${check.caseId}|${check.version}|${check.snapshotId}`));
  const files = caseFiles(config.casesDir);
  const results = [];
  if (!current) return { snapshotId: null, results };
  for (const { caseId, version, decision } of latestDecisions(config.outputsDir)) {
    if (!openCaseIds.has(caseId)) continue;
    const priced = decision.lines[0]?.history?.database?.snapshot;
    if (!priced || priced.id === current) continue;
    if (done.has(`${caseId}|${version}|${current}`)) continue;
    const stamp = { caseId, version, snapshotId: current, snapshotFile, pricedOn: priced.fileName || null, checkedAt: now.toISOString() };
    const lifecycle = readLifecycle(lifecyclePath(config.outputsDir, caseId), caseId);
    if ((lifecycle?.entries || []).some((entry) => entry.type === "decision")) {
      results.push({ ...stamp, result: "decided" });
      continue;
    }
    const casePath = files.get(caseId);
    if (!casePath) {
      results.push({ ...stamp, result: "no-case-file" });
      continue;
    }
    try {
      const fresh = build(casePath);
      const changes = compareDecisions(decision, fresh);
      if (!changes.length) {
        results.push({ ...stamp, result: "unchanged" });
        continue;
      }
      const saved = saveDecision(config.outputsDir, fresh);
      results.push({ ...stamp, result: "rebuilt", newVersion: saved.version, changes });
    } catch (error) {
      results.push({ ...stamp, result: "error", error: String(error.message || error).slice(0, 300) });
    }
  }
  // Errors are not stamped, so the next run tries again.
  const kept = [...checks, ...results.filter((item) => item.result !== "error")].slice(-KEEP);
  if (config.recheckFile && results.length) fs.writeFileSync(config.recheckFile, JSON.stringify({ schema: 1, checks: kept }, null, 2) + "\n");
  return { snapshotId: current, snapshotFile, results };
}

// What the board says about a page: checked with no change on the current
// export, or rebuilt from an earlier version because something moved.
export function recheckIndex(checks, currentSnapshot) {
  const unchanged = new Map();
  const rebuilt = new Map();
  for (const check of checks) {
    if (check.result === "unchanged" && check.snapshotId === currentSnapshot) unchanged.set(`${check.caseId}|${check.version}`, check);
    if (check.result === "rebuilt") rebuilt.set(`${check.caseId}|${check.newVersion}`, check);
  }
  return {
    checked: (caseId, version) => unchanged.get(`${caseId}|${version}`) || null,
    repriced: (caseId, version) => rebuilt.get(`${caseId}|${version}`) || null,
  };
}

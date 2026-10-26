import fs from "node:fs";
import path from "node:path";
import { latestDecisions } from "./board.js";
import { buildDecision } from "./decision.js";
import { lifecyclePath, readLifecycle } from "./lifecycle.js";
import { readManifest } from "./router-snapshot.js";
import { nextVersion, versionsOf } from "./versioning.js";

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
// behind it, whole (a corrected scope or a returned mark on the same work
// order is a change too). A difference in any of these is a reason to rebuild.
// The wording of why a line has no price is left out: it comes from the case's
// missing facts and the engine, not from Router History, and a newer engine's
// wording alone must not make a new version.
// Rows that share a source, date and evidence (quantity tiers in one quote)
// are told apart by their order among themselves.
function keyedRows(timeline) {
  const seen = new Map();
  return timeline.map((row) => {
    const base = [row.source, row.date, row.evidence].join("|");
    const nth = (seen.get(base) || 0) + 1;
    seen.set(base, nth);
    return { key: `${base}#${nth}`, text: JSON.stringify(row) };
  });
}
function lineSummary(line) {
  const preferred = line.recommendation.preferred;
  return {
    price: preferred?.unitPrice ?? null,
    lotCharge: preferred?.lotCharge ?? null,
    label: preferred?.label ?? null,
    rows: keyedRows(line.history?.timeline || []),
  };
}

export function compareDecisions(before, after) {
  const changes = [];
  const count = Math.max(before.lines.length, after.lines.length);
  for (let index = 0; index < count; index++) {
    const a = before.lines[index] ? lineSummary(before.lines[index]) : null;
    const b = after.lines[index] ? lineSummary(after.lines[index]) : null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const oldRows = new Map((a?.rows || []).map((row) => [row.key, row.text]));
    const newRows = new Map((b?.rows || []).map((row) => [row.key, row.text]));
    changes.push({
      lineId: (after.lines[index] || before.lines[index]).lineId,
      from: a?.price ?? null,
      to: b?.price ?? null,
      lotFrom: a?.lotCharge ?? null,
      lotTo: b?.lotCharge ?? null,
      labelFrom: a?.label ?? null,
      labelTo: b?.label ?? null,
      newRows: [...newRows.keys()].filter((key) => !oldRows.has(key)).length,
      changedRows: [...newRows].filter(([key, text]) => oldRows.has(key) && oldRows.get(key) !== text).length,
      removedRows: [...oldRows.keys()].filter((key) => !newRows.has(key)).length,
    });
  }
  if (JSON.stringify(before.poLotMinimum ?? null) !== JSON.stringify(after.poLotMinimum ?? null)) changes.push({ lineId: "PO", from: before.poLotMinimum?.charge ?? null, to: after.poLotMinimum?.charge ?? null, newRows: 0 });
  return changes;
}

// Case files by case id. A file that does not parse is listed, not fatal, so
// a case whose file is broken is retried once it is fixed.
function caseFiles(casesDir) {
  const files = new Map();
  const unreadable = [];
  if (!casesDir || !fs.existsSync(casesDir)) return { files, unreadable };
  for (const name of fs.readdirSync(casesDir).filter((item) => item.endsWith(".json")).sort()) {
    try {
      const caseId = JSON.parse(fs.readFileSync(path.join(casesDir, name), "utf8")).caseId;
      if (caseId && !files.has(caseId)) files.set(caseId, path.join(casesDir, name));
    } catch {
      unreadable.push(name);
    }
  }
  return { files, unreadable };
}

const hasDecision = (outputsDir, caseId) => (readLifecycle(lifecyclePath(outputsDir, caseId), caseId)?.entries || []).some((entry) => entry.type === "decision");

const KEEP = 2000;

// openCaseIds: the cases the board shows as waiting. Only those are checked.
// build(casePath) returns a fresh decision; injected so tests can count builds.
export function recheckCases({ config, openCaseIds, now = new Date(), build = (casePath) => buildDecision(decisionOptions(config, casePath)) }) {
  const manifest = readManifest(config.storeDir);
  const current = manifest.current;
  const snapshotFile = manifest.snapshots?.[current]?.fileName || null;
  const checks = readRecheck(config.recheckFile);
  const done = new Set(checks.map((check) => `${check.caseId}|${check.version}|${check.snapshotId}`));
  const { files, unreadable } = caseFiles(config.casesDir);
  const results = [];
  if (!current) return { snapshotId: null, results };
  // The check log is written after every case, so a run cut short keeps what
  // it did. Errors and missing case files are not stamped: the next run tries
  // again.
  const record = (item) => {
    results.push(item);
    if (!config.recheckFile || item.result === "error" || item.result === "no-case-file") return;
    checks.push(item);
    fs.writeFileSync(config.recheckFile, JSON.stringify({ schema: 1, checks: checks.slice(-KEEP) }, null, 2) + "\n");
  };
  for (const { caseId, version, decision } of latestDecisions(config.outputsDir)) {
    if (!openCaseIds.has(caseId)) continue;
    const priced = decision.lines[0]?.history?.database?.snapshot;
    if (!priced || priced.id === current) continue;
    if (done.has(`${caseId}|${version}|${current}`)) continue;
    const stamp = { caseId, version, snapshotId: current, snapshotFile, pricedOn: priced.fileName || null, checkedAt: now.toISOString() };
    if (hasDecision(config.outputsDir, caseId)) {
      record({ ...stamp, result: "decided" });
      continue;
    }
    const casePath = files.get(caseId);
    if (!casePath) {
      record({ ...stamp, result: "no-case-file", error: unreadable.length ? `case file not found; unreadable case files: ${unreadable.join(", ")}` : "case file not found" });
      continue;
    }
    try {
      const fresh = build(casePath);
      // An export imported while this run was going would price the case on a
      // snapshot this check does not name: leave it for the next run.
      const builtOn = fresh.lines[0]?.history?.database?.snapshot?.id;
      if (builtOn && builtOn !== current) {
        record({ ...stamp, result: "error", error: "a newer Router History export was imported during the check; left for the next run" });
        continue;
      }
      const changes = compareDecisions(decision, fresh);
      if (!changes.length) {
        record({ ...stamp, result: "unchanged" });
        continue;
      }
      // A decision recorded while this case was being built wins: never save
      // a new version over it. Nothing is ever deleted to undo a rebuild: a
      // decision that still lands on the older version (another run, merged
      // later) is shown on the card instead (board.js decidedEarlier).
      if (hasDecision(config.outputsDir, caseId)) {
        record({ ...stamp, result: "decided" });
        continue;
      }
      // Append only: the next number after the version that was checked,
      // created only if no file has it yet. Another writer that got there
      // first leaves this case for the next run.
      const stem = `CLAUDE-DECISION-${caseId}`;
      const newVersion = version + 1;
      if (versionsOf(config.outputsDir, stem)[0] !== version) {
        record({ ...stamp, result: "error", error: `a newer version than v${version} appeared while this case was checked; left for the next run` });
        continue;
      }
      fresh.lifecycle.recommendationVersion = newVersion;
      fresh.lifecycle.supersedes = version;
      // Where this version came from, kept with it so the board can say so
      // whatever happens to the check log.
      fresh.lifecycle.rebuiltByRecheck = { from: version, snapshotId: current, snapshotFile, checkedAt: stamp.checkedAt, changes };
      try {
        fs.writeFileSync(path.join(config.outputsDir, `${stem}-v${newVersion}.json`), JSON.stringify(fresh, null, 2), { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        record({ ...stamp, result: "error", error: `v${newVersion} already exists; left for the next run` });
        continue;
      }
      record({ ...stamp, result: "rebuilt", newVersion, changes });
    } catch (error) {
      record({ ...stamp, result: "error", error: String(error.message || error).slice(0, 300) });
    }
  }
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

import fs from "node:fs";
import path from "node:path";
import { writeBoard } from "./board.js";
import { importSnapshot, listExports, snapshotStatus } from "./router-snapshot.js";

// One pass that keeps the pricing side in step with everything feeding it:
// import any weekly Router History export not yet taken in, then rebuild the
// open-decisions board from the latest recommendations, recorded decisions
// and the mail monitor's newest check. It never rebuilds a recommendation
// (a new snapshot would create new versions; that stays a person's call),
// never writes the monitor's files, and never sends anything. Safe to run
// any number of times; each run appends one line to the sync log.

export function syncLogPath(config) {
  return config.syncLog || path.join(config.storeDir, "..", "sync-log.jsonl");
}

export function readLastSync(config) {
  const file = syncLogPath(config);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : null;
}

// OneDrive's Files On-Demand can leave a new export listed but not downloaded
// (st_blocks 0). A background job cannot make macOS fetch it, so such a file
// is reported as waiting rather than read and failed.
export function isCloudOnly(file, statFile = fs.statSync) {
  const stat = statFile(file);
  return stat.size > 0 && stat.blocks === 0;
}

export function runSync({ config, limits, trigger = "manual", now = new Date(), statFile = fs.statSync }) {
  const record = { at: now.toISOString(), trigger, imports: [], board: null, errors: [] };
  try {
    const status = snapshotStatus(config.storeDir, { folder: config.routerHistoryFolder, limits, now });
    const waiting = new Set(status.unimportedNewerExports);
    for (const item of listExports(config.routerHistoryFolder).filter((entry) => waiting.has(entry.name))) {
      if (isCloudOnly(item.path, statFile)) {
        record.imports.push({ fileName: item.name, outcome: "not-downloaded", failures: [] });
        continue;
      }
      const result = importSnapshot(item.path, { storeDir: config.storeDir, limits, now });
      record.imports.push({ fileName: result.fileName, outcome: result.outcome, failures: (result.failures || []).map((failure) => failure.code) });
    }
  } catch (error) {
    record.errors.push(`import: ${error.message}`);
  }
  try {
    const { file, board } = writeBoard({ outputsDir: config.outputsDir, monitorStatePath: config.monitorState, now, lastSync: record, storeDir: config.storeDir, trackerPath: config.trackerFile || null, mailCachePath: config.rfqMailCache || null });
    record.board = { file, waiting: board.cases.filter((kase) => kase.open).length, withoutPage: board.monitor?.withoutPage.length ?? null, monitorCutoff: board.monitor?.cutoff ?? null };
  } catch (error) {
    record.errors.push(`board: ${error.message}`);
  }
  fs.appendFileSync(syncLogPath(config), `${JSON.stringify(record)}\n`);
  return record;
}

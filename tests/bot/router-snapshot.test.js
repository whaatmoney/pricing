import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { exportDateFromName, importSnapshot, loadSnapshotRecords, readManifest, snapshotStatus } from "../../bot/lib/router-snapshot.js";
import { routerRow, tempDir, writeRouterExport } from "./helpers.js";

const rows = (count, overrides = {}) => Array.from({ length: count }, (_, index) => routerRow({ wo: `${1000 + index}WA`, ...overrides }));

test("export date comes from the MMDDYY file name, not the file time", () => {
  assert.equal(exportDateFromName("092126 - LineItems_with_RouterHistory.xlsx"), "2026-09-21");
  assert.equal(exportDateFromName("093226 - LineItems_with_RouterHistory.xlsx"), null);
  assert.equal(exportDateFromName("092126 - RouterHistoryByWorkOrder.xlsx"), null);
});

test("a valid export is accepted and replaying it adds nothing", () => {
  const folder = tempDir();
  const store = tempDir();
  const file = writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(50));
  const first = importSnapshot(file, { storeDir: store });
  assert.equal(first.outcome, "accepted");
  assert.equal(first.summary.rows, 50);
  const manifestBefore = fs.readFileSync(path.join(store, "manifest.json"), "utf8");
  const replay = importSnapshot(file, { storeDir: store });
  assert.equal(replay.outcome, "replay-noop");
  assert.equal(fs.readFileSync(path.join(store, "manifest.json"), "utf8"), manifestBefore);
  assert.equal(loadSnapshotRecords(store).records.length, 50);
});

test("repeated rows are counted but never removed", () => {
  const folder = tempDir();
  const store = tempDir();
  const same = routerRow({ wo: "2000WA" });
  const file = writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", [same, same, same, routerRow({ wo: "2001WA" })]);
  const result = importSnapshot(file, { storeDir: store });
  assert.equal(result.summary.repeatedSharedOccurrences, 2);
  assert.equal(loadSnapshotRecords(store).records.length, 4);
});

test("a partial export is rejected and the last good snapshot stays current", () => {
  const folder = tempDir();
  const store = tempDir();
  const good = importSnapshot(writeRouterExport(folder, "091426 - LineItems_with_RouterHistory.xlsx", rows(100)), { storeDir: store });
  const partial = importSnapshot(writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(60)), { storeDir: store });
  assert.equal(partial.outcome, "rejected");
  assert.ok(partial.failures.some((failure) => failure.code === "row-shrink"));
  assert.equal(readManifest(store).current, good.sha256);
});

test("header, sheet and file-name problems are rejected", () => {
  const folder = tempDir();
  const store = tempDir();
  const badHeaders = importSnapshot(writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(5), { headers: ["WO", "CUSTOMER", "RECEIVED"] }), { storeDir: store });
  assert.ok(badHeaders.failures.some((failure) => failure.code === "header-mismatch"));
  const wrongSheet = importSnapshot(writeRouterExport(folder, "092226 - LineItems_with_RouterHistory.xlsx", rows(5), { sheetName: "Sheet1" }), { storeDir: store });
  assert.ok(wrongSheet.failures.some((failure) => failure.code === "sheet-missing"));
  const wrongName = importSnapshot(writeRouterExport(folder, "latest.xlsx", rows(5)), { storeDir: store });
  assert.ok(wrongName.failures.some((failure) => failure.code === "file-name"));
  assert.equal(readManifest(store).current, null);
});

test("a file still being written or synced is not imported yet", () => {
  const folder = tempDir();
  const store = tempDir();
  const result = importSnapshot(writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(5), { ageMinutes: 1 }), { storeDir: store });
  assert.equal(result.outcome, "rejected");
  assert.ok(result.failures.some((failure) => failure.code === "file-still-changing"));
});

test("an older export is archived without replacing the current snapshot", () => {
  const folder = tempDir();
  const store = tempDir();
  const newer = importSnapshot(writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(20)), { storeDir: store });
  const older = importSnapshot(writeRouterExport(folder, "091426 - LineItems_with_RouterHistory.xlsx", rows(18)), { storeDir: store });
  assert.equal(older.outcome, "archived-older");
  assert.equal(readManifest(store).current, newer.sha256);
});

test("a newer export whose dates go backwards is rejected", () => {
  const folder = tempDir();
  const store = tempDir();
  importSnapshot(writeRouterExport(folder, "091426 - LineItems_with_RouterHistory.xlsx", rows(20, { received: "09/12/2026" })), { storeDir: store });
  const regressed = importSnapshot(writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(20, { received: "08/01/2026" })), { storeDir: store });
  assert.ok(regressed.failures.some((failure) => failure.code === "coverage-regression"));
});

test("status reports snapshot age and exports waiting to be imported", () => {
  const folder = tempDir();
  const store = tempDir();
  importSnapshot(writeRouterExport(folder, "091426 - LineItems_with_RouterHistory.xlsx", rows(10)), { storeDir: store });
  writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", rows(10));
  const status = snapshotStatus(store, { folder, now: new Date("2026-09-27T12:00:00") });
  assert.equal(status.current.exportDate, "2026-09-14");
  assert.equal(status.current.exportAgeDays, 13);
  assert.equal(status.stale, true);
  assert.deepEqual(status.unimportedNewerExports, ["092126 - LineItems_with_RouterHistory.xlsx"]);
});

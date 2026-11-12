import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import zlib from "node:zlib";
import { buildDataset, calculateStats, findHeaderRow, parseSnapshotText, rowsFromSnapshot } from "../core.js";

const workbookPath = process.argv[2];
if (!workbookPath) throw new Error("Pass the production workbook path as the first argument.");

const sandbox = { console, Buffer, Uint8Array, ArrayBuffer, Date, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL("../vendor/xlsx.full.min.js", import.meta.url), "utf8"), sandbox);
const XLSX = sandbox.XLSX;
assert.equal(XLSX.version, "0.20.3");

const workbook = XLSX.read(fs.readFileSync(workbookPath), { type: "buffer", cellDates: true, dense: true });
const sheetName = workbook.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
const header = findHeaderRow(rows);
assert.deepEqual(header.missing, []);

const result = buildDataset(rows, header.index, sheetName);
const stats = calculateStats(result.records);
const partStats = calculateStats(result.records.filter((record) => !record.isCharge));
console.log(JSON.stringify({ version: XLSX.version, quality: result.quality, stats, partStats }, null, 2));
// Pinned to "110926 - LineItems_with_RouterHistory.xlsx" (11/9/26 export); re-pin when a newer export supersedes it.
assert.equal(result.quality.sourceRows, 49266);
assert.equal(result.quality.duplicateRows, 20);
assert.equal(result.quality.loadedRows, 49246);
assert.ok(result.quality.normalizedLineBreakRows > 40000);
assert.ok(result.quality.partNumberExtractedRows / result.quality.partNumberMarkerRows > 0.98);
assert.equal(stats.median, 105);
assert.equal(stats.priced, 36503);
assert.equal(result.records.filter((record) => record.isCharge).length, 11344);
assert.equal(partStats.median, 35);
assert.equal(partStats.priced, 25605);
assert.ok(result.records.every((record) => typeof record.router === "string"));
assert.ok(result.records.some((record) => record.router.includes(":")));

// Optional second argument: the hosted copy of the same export (the pricing bot's .jsonl.gz snapshot).
// The signed-in site loads that copy, so it must give exactly the records the spreadsheet gives.
const copyPath = process.argv[3];
if (copyPath) {
  const copy = buildDataset(rowsFromSnapshot(parseSnapshotText(zlib.gunzipSync(fs.readFileSync(copyPath)).toString("utf8"))));
  assert.equal(copy.records.length, result.records.length);
  const fields = ["sourceRow", "date", "customer", "wo", "part", "price", "description", "process", "endUser", "special", "router", "isCharge", "pnSearch"];
  const differing = result.records.filter((record, index) => fields.some((field) => record[field] !== copy.records[index][field]));
  assert.equal(differing.length, 0, `${differing.length} records differ, first at source row ${differing[0]?.sourceRow}`);
  assert.deepEqual(calculateStats(copy.records), stats);
  console.log(`Hosted copy matches the spreadsheet: ${copy.records.length} records.`);
}

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildDataset, calculateStats, findHeaderRow } from "../core.js";

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
console.log(JSON.stringify({ version: XLSX.version, quality: result.quality, stats }, null, 2));
assert.equal(result.quality.sourceRows, 43103);
assert.equal(result.quality.duplicateRows, 20);
assert.equal(result.quality.loadedRows, 43083);
assert.ok(result.quality.normalizedLineBreakRows > 40000);
assert.ok(result.quality.partNumberExtractedRows / result.quality.partNumberMarkerRows > 0.98);
assert.equal(stats.median, 95);
assert.equal(stats.priced, 31606);

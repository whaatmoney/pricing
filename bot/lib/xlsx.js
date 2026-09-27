import fs from "node:fs";
import vm from "node:vm";

// Loads the same vendored SheetJS build the browser app ships, so Node imports
// parse workbooks exactly the way Part Memory does. Date is passed in so
// `instanceof Date` checks in core.js work across the sandbox boundary.
let cached = null;

export function loadXlsx() {
  if (cached) return cached;
  const sandbox = { console, Buffer, Uint8Array, ArrayBuffer, Date, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL("../../vendor/xlsx.full.min.js", import.meta.url), "utf8"), sandbox);
  cached = sandbox.XLSX;
  return cached;
}

export function readWorkbook(buffer) {
  return loadXlsx().read(buffer, { type: "buffer", cellDates: true, dense: true });
}

export function sheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  return loadXlsx().utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
}

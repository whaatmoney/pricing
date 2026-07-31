import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDataset,
  calculateStats,
  csvCell,
  extractPartNumbers,
  findHeaderRow,
  normalizeDate,
  normalizeText,
  parsePrice,
  parseRouterSteps,
  percentile,
} from "../core.js";

const headers = ["WO", "CUSTOMER", "RECEIVED", "PART ID", "LINE DESCRIPTION", "UNIT PRICE", "PROCESS", "END USER", "SPECIAL INSTRUCTIONS"];

test("normalizes Access line-break escape sequences", () => {
  assert.equal(normalizeText("P/N: ABC_x000D_\nPROCESS"), "P/N: ABC\nPROCESS");
});

test("finds a valid header row beneath a preamble", () => {
  const result = findHeaderRow([["Exported report"], [], headers]);
  assert.equal(result.index, 2);
  assert.deepEqual(result.missing, []);
});

test("validates dates instead of accepting impossible calendar values", () => {
  assert.equal(normalizeDate("02/29/2024"), "2024-02-29");
  assert.equal(normalizeDate("02/29/2025"), "");
  assert.equal(normalizeDate("2025-99-99"), "");
});

test("requires the complete price value to be numeric", () => {
  assert.deepEqual(parsePrice("$1,234.56"), { value: 1234.56, valid: true, blank: false });
  assert.equal(parsePrice("123abc").valid, false);
  assert.equal(parsePrice("(42.50)").value, -42.5);
});

test("extracts part numbers after normalizing encoded line breaks", () => {
  assert.deepEqual(extractPartNumbers('P/N: PTFE-7/16"-TUBE-TCC REV. D_x000D_\nGOX CLEAN'), ['PTFE-7/16"-TUBE-TCC']);
});

test("duplicate detection is case insensitive and import reports quality", () => {
  const rows = [
    headers,
    ["1", "ACME", "07/13/2026", "P1", "P/N: ABC_x000D_\nCLEAN", 100.25, "AMS2700", "END", "@SCR note"],
    ["2", "ACME", "07/13/2026", "P2", "****DUPLICATE WO****", 200, "AMS2700", "END", ""],
    ["3", "ACME", "02/31/2026", "P3", "P/N: DEF", 0, "AMS2700", "END", ""],
  ];
  const result = buildDataset(rows);
  assert.equal(result.records.length, 2);
  assert.equal(result.quality.duplicateRows, 1);
  assert.equal(result.quality.invalidDates, 1);
  assert.equal(result.quality.zeroPrices, 1);
  assert.equal(result.quality.normalizedLineBreakRows, 1);
});

test("router forms load into the record and search text when present", () => {
  const rows = [
    [...headers, "ROUTER FORMS"],
    ["1", "ACME", "07/13/2026", "P1", "P/N: ABC", 100, "AMS2700", "END", "", "10: PCL001 > 20: CLR001 > 30: PCK001"],
  ];
  const result = buildDataset(rows);
  assert.equal(result.records[0].router, "10: PCL001 > 20: CLR001 > 30: PCK001");
  assert.ok(result.records[0].search.includes("clr001"));
});

test("router steps parse into sequenced segments", () => {
  assert.deepEqual(parseRouterSteps("10: PCL001 > 20: CLR001"), [
    { woId: "", steps: [{ seq: "10", form: "PCL001" }, { seq: "20", form: "CLR001" }] },
  ]);
  assert.deepEqual(parseRouterSteps("[WoID 174] 10: PCL001  ||  [WoID 175] 10: PCL005 > 20: LAB000"), [
    { woId: "174", steps: [{ seq: "10", form: "PCL001" }] },
    { woId: "175", steps: [{ seq: "10", form: "PCL005" }, { seq: "20", form: "LAB000" }] },
  ]);
  assert.deepEqual(parseRouterSteps("FREEFORM NOTE"), [{ woId: "", steps: [{ seq: "", form: "FREEFORM NOTE" }] }]);
  assert.deepEqual(parseRouterSteps(""), []);
});

test("workbooks without a router column still load", () => {
  const rows = [
    headers,
    ["1", "ACME", "07/13/2026", "P1", "P/N: ABC", 100, "AMS2700", "END", ""],
  ];
  const result = buildDataset(rows);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].router, "");
});

test("median and percentiles interpolate correctly", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5);
  const stats = calculateStats([{ price: 10, date: "2026-01-01" }, { price: 20, date: "2026-02-01" }, { price: 30, date: "2026-03-01" }, { price: 40, date: "2026-04-01" }]);
  assert.equal(stats.median, 25);
  assert.equal(stats.average, 25);
  assert.equal(stats.latest, 40);
});

test("CSV export preserves formula-sensitive text as text", () => {
  assert.equal(csvCell("@SCR: reference"), "'@SCR: reference");
  assert.equal(csvCell("-HANDLE WITH CARE"), "'-HANDLE WITH CARE");
  assert.equal(csvCell(-42.5, true), "-42.5");
});

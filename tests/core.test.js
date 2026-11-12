import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDataset,
  calculateStats,
  csvCell,
  extractPartNumbers,
  findHeaderRow,
  isChargeLine,
  normalizeDate,
  normalizeText,
  parsePrice,
  parseRouterSteps,
  percentile,
  priceRuns,
  singlePartLabel,
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

test("fee, charge, and note lines are flagged; part lines that mention a fee word are not", () => {
  [
    "LOT MIN", "LOT MINIMUM", "LOT CHRGE FOR LINE 2", "PASSIVATION ONLY LOT MIN", "VACUUM BAKE LOT CHARGE",
    "EXPEDITE", "EXEPDITE", "EXPEDTIE", "WEEKEND EXPEDITE", "EXPEDITE FEE FOR SOURCE 12/14 ECD 12/15",
    "SOURCE FEE", "AR SOURCE INSPECTION", "PART EVAL FEE", "PARTS EVALUATION FEE", "CLEANROOM RENTAL",
    "ENVIRONMENTAL SURCHARGE", "SET-UP FEE", "BANK FEE", "SHIPPING CHARGES", "FREIGHT", "TAX",
    "NO CHARGE PER JAY", "DUPLICATE WO_x000D_\nCLOSING OUT", "** USE TRAVELER IN FOLDER***",
  ].forEach((text) => assert.equal(isChargeLine(text), true, text));
  [
    "P/N: TES15011-01 REV. -_x000D_\nGAS HANDLING SUBASSEMBLY",
    "DPM13619-1/UC26TE FOAM PLUG, POLYURETHANE, CRES EXTRACTION WIRE, LEVEL 100A CLEAN",
    "ACLAR BAG 8\" X 96\" JOB NO: STOCK LOT NO: 1697799",
    "PLEASE DO NOT MIX LINE ITEMS SG TO ASSEMBLE IN CLEAN ROOM.",
    "VACUUM BAKE", "ASSEMBLY", "TURCO SAMPLE", "VERIFICATION TEST", "RECLEAN FEE", "",
  ].forEach((text) => assert.equal(isChargeLine(text), false, text));
});

test("a blank description is a fee only under a fee Part ID", () => {
  ["7330", "3", "8410", " 7330 "].forEach((part) => assert.equal(isChargeLine("", part), true, part));
  ["7559", "4", "1499", ""].forEach((part) => assert.equal(isChargeLine("", part), false, part));
  assert.equal(isChargeLine("VACUUM BAKE", "7330"), false);
  assert.equal(isChargeLine("ASSEMBLY", "8410"), false);
  const rows = [headers, ["1", "ACME", "07/13/2026", 7330, "", 350, "CLEAN", "END", ""], ["1", "ACME", "07/13/2026", 1499, "", 20, "CLEAN", "END", ""]];
  assert.deepEqual(buildDataset(rows).records.map((record) => record.isCharge), [true, false]);
});

test("the P/N filter text falls back to the description when no part number is labeled", () => {
  const rows = [
    headers,
    ["1", "ACME", "07/13/2026", "P1", "P/N: 19003-102 REV. A_x000D_\nLO2 FILL AND DRAIN ASSEMBLY", 4400, "CLEAN", "END", ""],
    ["2", "ACME", "07/13/2026", "P2", "DPM13619-1/UC26TE FOAM PLUG", 12, "CLEAN", "END", ""],
  ];
  const [labeled, unlabeled] = buildDataset(rows).records;
  assert.equal(labeled.pnSearch, "19003-102");
  assert.ok(unlabeled.pnSearch.includes("dpm13619-1"));
});

test("price runs show the current price and how long it has held", () => {
  const line = (date, price, partNumber = "19003-102") => ({ date, price, partNumbers: partNumber ? [partNumber] : [] });
  const records = [line("2024-07-16", 2800), line("2023-11-28", 2800), line("2025-01-27", 3200), line("2025-07-25", 4400), line("2026-10-22", 4400), line("2026-01-07", 0), line("", 9999)];
  assert.deepEqual(priceRuns(records), [
    { price: 4400, count: 2, from: "2025-07-25", to: "2026-10-22" },
    { price: 3200, count: 1, from: "2025-01-27", to: "2025-01-27" },
    { price: 2800, count: 2, from: "2023-11-28", to: "2024-07-16" },
  ]);
  assert.deepEqual(priceRuns([]), []);
  assert.equal(singlePartLabel(records), "19003-102");
  assert.equal(singlePartLabel([...records, line("2026-01-01", 5, "OTHER-1")]), "");
  assert.equal(singlePartLabel([...records, line("2026-01-01", 5, "")]), "");
  const unlabeled = (description, price = 26) => ({ date: "2023-12-11", price, partNumbers: [], description });
  assert.equal(singlePartLabel([unlabeled("DPM13619-1/UC26TE  FOAM PLUG\nLEVEL 100A"), unlabeled("dpm13619-1/uc26te foam plug\nlevel 100a")]), "dpm13619-1/uc26te foam plug");
  assert.equal(singlePartLabel([unlabeled("FOAM PLUG A"), unlabeled("FOAM PLUG B")]), "");
  assert.equal(singlePartLabel([unlabeled("")]), "");
  assert.equal(singlePartLabel([...records, line("2026-01-01", 0, "OTHER-1")]), "19003-102");
  assert.equal(singlePartLabel([]), "");
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

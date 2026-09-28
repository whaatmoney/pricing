import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importSnapshot, ROUTER_EXPORT } from "../../bot/lib/router-snapshot.js";
import { loadXlsx } from "../../bot/lib/xlsx.js";

// Synthetic fixtures only. Nothing here is QPC pricing data, a customer
// record or an email; the values are chosen to exercise the rules.

export function tempDir(prefix = "qpc-bot-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function workbookBuffer(sheets) {
  const XLSX = loadXlsx();
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

export function routerRow({ wo = "1000WA", customer = "ACME PRECISION CORP", received = "05/27/2026", description = "P/N: ABC-100 REV. B", price = 8.5, process = "CLEAN PER IEST-STD-CC1246 REV. E, LEVEL 300R4", special = "NOT FOR OXYGEN SERVICE.", forms = "10: PCL003 > 20: CLR001" } = {}) {
  return [wo, customer, received, 17000, description, price, process, "N/A", special, "1", 2, forms];
}

export function writeRouterExport(dir, fileName, rows, { sheetName = ROUTER_EXPORT.sheetName, headers = ROUTER_EXPORT.headers, ageMinutes = 60 } = {}) {
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, workbookBuffer({ [sheetName]: [headers, ...rows] }));
  const when = new Date(Date.now() - ageMinutes * 60000);
  fs.utimesSync(file, when, when);
  return file;
}

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

export function writeRulesPackage(dir, overrides = {}) {
  const files = {
    "PriceGPT-Master-v2.md": "SQ3 uses a fixed internal labor rate of $100.00/hr.\n4. Base price minimum = $5.00.\n2. Buffered Volume = Raw x 1.10, round up to whole in³\n5. Lot minimum commercial check only: PO minimum = $200; do not change unit price.\n",
    "QPC Pricing Model - v10.2.25.csv": "﻿Min Volume in³,Max Volume in³,Base Price\n0,1,$4.00\n2,3,$7.00\n3,4,$9.00\n5,10,$12.00\n11,60,\"$1,000.00\"\n",
    "Cleanliness Multipliers - v10.2.25.csv": "Cleanliness Level,Multiplier\nVC,1.02\n300,1.2\n100,1.5\n",
    "Cleanliness Levels Reference - v10.2.25.csv": "Category,Level,CleanlinessRank,Notes\nParticulate,300,4,\n",
    "Internal Geometry Multipliers - v10.2.25.csv": "Internal Geometry,Multiplier\nNone,1\nMinimal,1.1\nModerate,1.25\nCritical/Complex,1.6\n",
    "Cavity Tiers - v10.2.25.csv": "Tier,Charge_each_USD,Definition\nA,2,\"deep, blind\"\nB,1,short\nC,0.5,\"shallow, \"\"open\"\"\"\nD,0.2,vent\n",
    "Spec-Based Fixed Charges - v10.2.25.csv": "Specification,Fixed Charge ($)\nACME SPEC,$2.00\n",
    "Packaging Charges - v10.2.25.csv": "Packaging Type,Surcharge per Ft² ($)\nAclar,$10.00\n",
    ...overrides,
  };
  const sources = [];
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
    sources.push({ snapshot_path: path.join(dir, name), sha256: sha(Buffer.from(content)) });
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ captured_at: "2026-01-01T00:00:00Z", sources }));
  return dir;
}

export const CALCULATOR_HTML = `<html><body><script>
/* ================== LOOKUP DATA ================== */
const VOL_BUFFER = 1.10;
const PROCESS = { "300": 1.2 };
const SIZE = { "Small (≤ 6 in)": 1.00, "Medium (> 6–12 in)": 1.5 };
const WEIGHT = { "< 10 lb": 1.00 };
const COMPLEXITY = { "Standard": 1.00 };
const END_USER_FEE = { "None": 0, "ACME": 2 };
const VOLUME_TABLE = [[0,1,4],[2,3,7],[3,4,9]];
function lookupBasePrice(volume){ let chosen = VOLUME_TABLE[0][2]; for (const row of VOLUME_TABLE) { if (row[0] <= volume) chosen = row[2]; else break; } return chosen; }
function autoSize(maxDim){ return maxDim <= 6 ? "Small (≤ 6 in)" : "Medium (> 6–12 in)"; }
function lengthSurcharge(maxDim){ return maxDim <= 6 ? 0 : (maxDim - 6) * 0.5; }
function packagingCost(type){ return type === "Double-bag" ? 0.5 : 0; }
/* ================== COMPUTE ================== */
function compute(){
  const volume = L * W * H * VOL_BUFFER;
  const loadedBase = basePrice + cavity + lenSur + specFee + pkgCost;
  const unitPrice = loadedBase * procMult * sizeMult * wtMult * cmpMult;
}
</script></body></html>`;

// A purchase order in the same extracted-text layout the Microsoft 365
// connector returns for a customer PDF: out of reading order, spaced P/N.
export function purchaseOrderText({ po = "PO1-100", revision = null, date = "5/27/2026", needBy = "06/10/2026", unit = "8.50", extended = "4,080.00", uom = "Ea", quantity = 480, part = "ABC - 100 Rev. B", scope = "CLEAN PER IEST - STD - CC1246 LEVEL 300 R 4 NOT FOR OXYGEN SERVICE", job = "W1- 100", expedite = null, total = null } = {}) {
  return `${po}${revision ? ` Rev. ${revision}` : ""}  Acme Precision Corp  Purchase Order  PURCHASE ORDER#:  DATE  ${date}  Vendor ID   P.O. Ref#   Shipping Method   Payment Terms   Need by Date  V1   ${job}   Will Call   Net 30   ${needBy}  Vendor Item No.   Description | Item Code   Quantity   UoM   Unit Price   Extended  Price  Item  No .  $   ${unit}   $   ${extended} VP0001   ${uom} PRECISION CLEANING | VP0001  1   ${quantity}  ${expedite ? `$ ${expedite} Expedite Fee listed under " Freight / Other".  ` : ""}Part Description : Seal   Part Number : ${part}  WO Number :${job}  ${scope}  CLEANING CERTIFICATE REQUIRED .  P.O . Approved By  Pat Buyer ,  Purchasing Manager  Subtotal  Tax  Freight / Other   $   ${expedite ? `${expedite}.00` : "-"}  TOTAL AMOUNT  $   ${total || extended}  $   ${extended}`;
}

// One synthetic RFQ world that contains every trap the handoff lists:
// another customer on the same P/N, a longer token, changed revision, changed
// process, returned work, a lot-priced PO, an old quoted estimate, an internal
// forward, a quantity alternative and a line with no usable inputs.
export function buildWorld() {
  const root = tempDir("qpc-world-");
  const folder = path.join(root, "router");
  const store = path.join(root, "store");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(folder);
  fs.mkdirSync(evidence);
  const router = [
    routerRow({ wo: "5001WA", description: "P/N: ABC-100 REV. B\nWO NO: W1-100" }),
    routerRow({ wo: "5002WA", customer: "OTHER AEROSPACE INC", price: 5 }),
    routerRow({ wo: "5003WA", description: "P/N: ABC100X REV. B", price: 6 }),
    routerRow({ wo: "4001WA", received: "01/10/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-090", price: 7.5, special: "FOR OXYGEN SERVICE" }),
    routerRow({ wo: "5001WA", description: "P/N: ABC-100 REV. B\nWO NO: W1-100\n**RETURN TO CUSTOMER**", price: 4.25 }),
    routerRow({ wo: "3001WA", received: "03/01/2026", description: "P/N: ABC-100 REV. C\nWO NO: W1-080", price: 9 }),
    routerRow({ wo: "2001WA", received: "02/01/2026", description: "P/N: ABC-100 REV. B\nWO NO: W1-070", price: 8, process: "CLEAN PER CC1246 LEVEL 100" }),
    routerRow({ wo: "1001WA", received: "12/01/2025", description: "P/N: ABC-100 REV. B\nWO NO: W1-060", price: 6 }),
  ];
  const exportFile = writeRouterExport(folder, "092126 - LineItems_with_RouterHistory.xlsx", router);
  assert.equal(importSnapshot(exportFile, { storeDir: store }).outcome, "accepted");

  const sales = path.join(root, "sales.xlsx");
  fs.writeFileSync(sales, workbookBuffer({ Sheet1: [
    ["SERVICE", "DATE", "INVOICE", "CUSTOMER", "DESCRIPTION", "QTY", "UNIT PRICE"],
    ["Cleaning", "12/05/2025", "INV-1", "Acme <Precision> Corp.", "P/N: ABC-100 REV. B\nWO NO: W1-060\nLEVEL 300R4 NOT FOR OXYGEN SERVICE", 400, 7.5],
  ] }));

  const rulesDir = writeRulesPackage(fs.mkdtempSync(path.join(root, "rules-")));
  const calculatorHtml = path.join(root, "calculator.html");
  fs.writeFileSync(calculatorHtml, CALCULATOR_HTML);

  const customerMail = { from: "buyer@acme.example", to: ["sales@qpc.example"], cc: [], bodyFormat: "text", attachments: [], mailbox: "sales@qpc.example" };
  fs.writeFileSync(path.join(evidence, "messages.json"), JSON.stringify({
    searchQueries: ["ABC-100"],
    messages: [
      { ...customerMail, id: "rfq", subject: "RFQ ABC-100", receivedAt: "2026-09-24T12:00:00Z", webLink: "https://mail.example/rfq", body: "Can you please provide pricing for:\nABC-100 Rev. B\nQty: 500\nCLEAN PER CC1246 LEVEL 300R4 NOT FOR OXYGEN SERVICE" },
      { ...customerMail, id: "po", subject: "PO1-100", receivedAt: "2026-05-27T12:00:00Z", webLink: "https://mail.example/po", body: "Please see attached PO", attachments: [{ name: "PO1-100.pdf", text: purchaseOrderText() }] },
      { ...customerMail, id: "lot-po", subject: "PO1-200", receivedAt: "2026-06-15T12:00:00Z", webLink: "https://mail.example/lot", body: "Please see attached PO", attachments: [{ name: "PO1-200.pdf", text: purchaseOrderText({ po: "PO1-200", uom: "Lot", unit: "350.00", extended: "350.00", quantity: 1, job: "W1- 110" }) }] },
      { id: "estimate", mailbox: "sales@qpc.example", subject: "Re: Pricing for Oxygen Service", from: "e@qpc.example", to: ["buyer@acme.example"], cc: [], receivedAt: "2026-02-27T12:00:00Z", webLink: "https://mail.example/est", bodyFormat: "text", attachments: [], body: "Without oxygen service, see the estimated pricing below:\nABC-100 | 5000 | $7.00\n\n* * *\n\n**From:** Estimator\n**Sent:** Monday\n\nFor oxygen service:\nABC-100 | 5000 | $9.00" },
      { id: "internal", mailbox: "sales@qpc.example", subject: "fwd ABC-100", from: "e@qpc.example", to: ["jay@qpc.example"], cc: [], receivedAt: "2026-02-20T12:00:00Z", webLink: "https://mail.example/int", bodyFormat: "text", attachments: [], body: "ABC-100 | 500 | $6.00" },
    ],
  }));
  fs.writeFileSync(path.join(evidence, "search-log.json"), JSON.stringify({ searchedAt: "2026-09-27T00:00:00Z", searches: [{ mailbox: "sales@qpc.example", query: "ABC-100", results: 5, complete: true }], gaps: ["Synthetic gap"] }));

  const sq1 = {
    category: { value: 4 },
    envelope: { length: 0.7, width: 0.7, height: 0.12, flag: "DIM: DRAWING" },
    geometry: { class: "Minimal", confidence: "MED" },
    cavities: { counts: { A: 0, B: 0, C: 0, D: 0 }, confidence: "MED" },
    cleanliness: { level: "300", flag: "CLN" },
    specGroup: { flag: "FEE: $0" },
    aclar: { required: false, flag: "ACLAR: N" },
    weight: { flag: "WT: NOT PROVIDED" },
    lengthSurcharge: { amount: 0, basis: "test" },
    specFee: { amount: 0, basis: "test" },
  };
  const sq3 = { batch: { size: 100, basis: "assumed", reason: "test" }, steps: [{ step: "setup", router: "-", class: "LOT", minutes: 60, basis: "estimate" }, { step: "handle", router: "-", class: "PER-PART", minutes: 0.5, basis: "estimate" }], measuredTimeSearch: "none" };
  const shared = { revision: "B", uom: "EA", currency: "USD", scope: { oxygen: "not-for", level: "300R4" }, process: { verbatim: "LEVEL 300R4 NOT FOR OXYGEN SERVICE", source: "rfq" }, material: { value: "A286", source: "test" }, drawing: { number: "1", revision: "B", title: "SEAL", caveat: "test", dimensions: { maxOdAfterCoating: 0.7, F_max: 0.12, source: "test" } }, packaging: { requirement: "bag", sources: ["test"], status: "extracted" }, sq1, sq3, sq5Anchor: { choice: "SQ2", reason: "test" }, calculator: { process: "300" } };
  const casePath = path.join(root, "case.json");
  fs.writeFileSync(casePath, JSON.stringify({
    caseId: "TEST-ABC-100",
    mode: "FIRST-PASS",
    customer: { name: "Acme <Precision> Corp.", aliases: ["ACME PRECISION CORP"], emailDomains: ["acme.example"] },
    internalDomains: ["qpc.example"],
    rfq: { initiatedAt: "2026-09-24T12:00:00Z", initiatedBy: "buyer@acme.example", latestAskAt: "2026-09-24T12:00:00Z", latestAskSummary: "RFQ", lastQpcResponse: "none", urgency: null, sourceMessageIds: ["rfq"] },
    evidence: { messages: "evidence/messages.json", searchLog: "evidence/search-log.json" },
    lines: [
      { lineId: "L1", partNumber: "ABC-100", aliases: [], description: "Seal", quantity: 500, ...shared },
      { lineId: "L2", partNumber: "ABC-100", aliases: [], description: "Seal", quantity: 5000, ...shared },
      { lineId: "L3", partNumber: "DEF-200", aliases: [], description: "Unknown part", quantity: 10, ...shared, sq1: { ...sq1, envelope: { length: 0, width: 0, height: 0 } }, sq3: { ...sq3, steps: [] } },
    ],
    recommendationPolicy: "repeat-accepted-hold-v0",
  }));
  const options = { casePath, storeDir: store, routerFolder: folder, salesExportPath: sales, priceLabDir: rulesDir, calculatorHtml, now: new Date("2026-09-27T12:00:00Z") };
  return { root, exportFile, store, evidence, casePath, options };
}

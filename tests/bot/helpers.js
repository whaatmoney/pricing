import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROUTER_EXPORT } from "../../bot/lib/router-snapshot.js";
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

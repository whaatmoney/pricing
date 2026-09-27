import fs from "node:fs";
import path from "node:path";
import { extractPartNumbers, normalizeDate, normalizeText, parsePrice } from "../../core.js";
import { sha256Buffer } from "./router-snapshot.js";
import { readWorkbook, sheetRows } from "./xlsx.js";

// Reader for the QuickBooks Online "Sales by Product/Service Detail" export.
// These are billed invoice lines: they establish what was invoiced, not labor
// cost, margin, payment or current coverage. The report's filters are unverified.

export const SALES_EXPORT = {
  source: "QBO Sales by Product/Service Detail export",
  headers: ["SERVICE", "DATE", "INVOICE", "CUSTOMER", "DESCRIPTION", "QTY", "UNIT PRICE"],
};

export function readSalesExport(filePath) {
  const buffer = fs.readFileSync(filePath);
  const workbook = readWorkbook(buffer);
  const sheetName = workbook.SheetNames.find((name) => {
    const rows = sheetRows(workbook, name);
    return rows && rows.slice(0, 5).some((row) => SALES_EXPORT.headers.every((header) => (row || []).map((value) => normalizeText(value).toUpperCase()).includes(header)));
  });
  if (!sheetName) throw new Error(`No sheet with headers ${SALES_EXPORT.headers.join(", ")} in ${path.basename(filePath)}`);
  const rows = sheetRows(workbook, sheetName);
  const headerIndex = rows.findIndex((row) => SALES_EXPORT.headers.every((header) => (row || []).map((value) => normalizeText(value).toUpperCase()).includes(header)));
  const header = rows[headerIndex].map((value) => normalizeText(value).toUpperCase());
  const column = Object.fromEntries(SALES_EXPORT.headers.map((name) => [name, header.indexOf(name)]));

  const records = [];
  let dateMin = "";
  let dateMax = "";
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (!row.some((value) => value != null && value !== "")) continue;
    const description = normalizeText(row[column.DESCRIPTION]);
    const price = parsePrice(row[column["UNIT PRICE"]]);
    const qty = parsePrice(row[column.QTY]);
    const date = normalizeDate(row[column.DATE]);
    if (date && (!dateMin || date < dateMin)) dateMin = date;
    if (date && (!dateMax || date > dateMax)) dateMax = date;
    records.push({
      row: index + 1,
      service: normalizeText(row[column.SERVICE]),
      date,
      invoice: normalizeText(row[column.INVOICE]),
      customer: normalizeText(row[column.CUSTOMER]),
      description,
      quantity: qty.valid && !qty.blank ? qty.value : null,
      unitPrice: price.valid && !price.blank ? price.value : null,
      unitPriceRaw: row[column["UNIT PRICE"]] == null ? "" : String(row[column["UNIT PRICE"]]),
      priceStatus: price.blank ? "blank" : !price.valid ? "invalid" : price.value < 0 ? "negative" : price.value === 0 ? "zero" : "positive",
      partNumbers: extractPartNumbers(description),
      duplicateMarked: false,
    });
  }
  return {
    meta: {
      source: SALES_EXPORT.source,
      fileName: path.basename(filePath),
      filePath,
      sha256: sha256Buffer(buffer),
      sheet: sheetName,
      rows: records.length,
      dateMin,
      dateMax,
    },
    records,
  };
}

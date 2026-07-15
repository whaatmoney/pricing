export const EXPECTED_COLUMNS = {
  wo: ["wo", "work order", "wo #", "wo#"],
  customer: ["customer"],
  date: ["received", "received date", "date"],
  part: ["part id", "part", "part #", "part#", "part number"],
  description: ["line description", "description", "line desc"],
  price: ["unit price", "price"],
  process: ["process"],
  endUser: ["end user", "enduser", "end-user"],
  special: ["special instructions", "notes", "special inst"],
};

const REQUIRED_COLUMNS = ["wo", "customer", "part", "description", "price", "process"];
const PN_LABEL = "(?:CUSTOMER\\s*P/?N|CUST\\.?\\s*P/?N|PART\\s*(?:NUMBER|NO\\.?|#)|DRAWING\\s*(?:NUMBER|NO\\.?|#)|DWG\\.?\\s*(?:NUMBER|NO\\.?|#)|ITEM\\s*(?:NUMBER|NO\\.?|#)|C/P/N|CPN|P/N|REFERENCE|REF)";
const PN_MARKER_RE = new RegExp("\\b" + PN_LABEL + "[\\s:#\\-]*", "i");
const PN_EXTRACT_RE = new RegExp(
  "\\b" + PN_LABEL +
  "[\\s:#\\-]*" +
  "([A-Z0-9][A-Z0-9\\-\\./#_\"']*(?:[ ]+[A-Z0-9][A-Z0-9\\-\\./#_\"']*)*?)" +
  "(?=\\s*(?:$|[\\n\\r,;]|\\(|REV\\b|QTY\\b|DESCRIPTION\\b|MATL\\b|MATERIAL\\b|PER\\s|SPEC\\b|ASSY\\b|MFR\\b))",
  "gi",
);

export function normalizeText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/_x000D_\r?\n/gi, "\n")
    .replace(/_x000A_\r?\n/gi, "\n")
    .replace(/_x000D_/gi, "\n")
    .replace(/_x000A_/gi, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function resolveColumns(headerRow) {
  const normalized = (headerRow || []).map((value) => normalizeText(value).toLowerCase());
  const columns = {};
  for (const [field, aliases] of Object.entries(EXPECTED_COLUMNS)) {
    columns[field] = aliases.reduce((found, alias) => found >= 0 ? found : normalized.indexOf(alias), -1);
  }
  const missing = REQUIRED_COLUMNS.filter((field) => columns[field] < 0);
  return { columns, missing };
}

export function findHeaderRow(rows, scanLimit = 12) {
  const limit = Math.min(rows.length, scanLimit);
  let best = null;
  for (let index = 0; index < limit; index += 1) {
    const resolved = resolveColumns(rows[index]);
    const score = Object.values(resolved.columns).filter((column) => column >= 0).length;
    if (!best || score > best.score) best = { index, score, ...resolved };
    if (!resolved.missing.length) return { index, ...resolved };
  }
  return best || { index: 0, columns: {}, missing: REQUIRED_COLUMNS.slice() };
}

export function normalizeDate(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return localIsoDate(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const converted = new Date(epoch.getTime() + value * 86400000);
    return Number.isNaN(converted.getTime()) ? "" : converted.toISOString().slice(0, 10);
  }
  const text = normalizeText(value);
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/);
  if (match) return validDateParts(+match[1], +match[2], +match[3]);
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    let year = +match[3];
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return validDateParts(year, +match[1], +match[2]);
  }
  return "";
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parsePrice(value) {
  if (value == null || value === "") return { value: null, valid: true, blank: true };
  if (typeof value === "number") return { value: Number.isFinite(value) ? value : null, valid: Number.isFinite(value), blank: false };
  const source = normalizeText(value);
  const negative = /^\(.*\)$/.test(source);
  const normalized = source.replace(/^\(|\)$/g, "").replace(/[$,\s]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return { value: null, valid: false, blank: false };
  const parsed = Number(normalized);
  return { value: negative ? -parsed : parsed, valid: Number.isFinite(parsed), blank: false };
}

export function extractPartNumbers(description) {
  const text = normalizeText(description).toUpperCase();
  const found = [];
  const seen = new Set();
  PN_EXTRACT_RE.lastIndex = 0;
  let match;
  let guard = 0;
  while ((match = PN_EXTRACT_RE.exec(text)) && guard++ < 200) {
    const value = match[1].replace(/\s+/g, " ").replace(/[\-\./,;: ]+$/, "").trim();
    if (value.length < 2 || ["NA", "N/A", "NONE", "TBD"].includes(value) || seen.has(value)) continue;
    seen.add(value);
    found.push(value);
  }
  return found;
}

export function buildDataset(rows, headerIndex = 0, sheetName = "Sheet1") {
  if (!Array.isArray(rows) || rows.length <= headerIndex + 1) throw new Error("The selected sheet has no data rows.");
  const { columns, missing } = resolveColumns(rows[headerIndex]);
  if (missing.length) throw new Error(`Missing required columns: ${missing.map((field) => EXPECTED_COLUMNS[field][0]).join(", ")}`);

  const records = [];
  const quality = {
    sheetName,
    headerRow: headerIndex + 1,
    sourceRows: Math.max(0, rows.length - headerIndex - 1),
    loadedRows: 0,
    blankRows: 0,
    duplicateRows: 0,
    zeroPrices: 0,
    blankPrices: 0,
    invalidPrices: 0,
    invalidDates: 0,
    normalizedLineBreakRows: 0,
    partNumberMarkerRows: 0,
    partNumberExtractedRows: 0,
    invalidSamples: [],
  };

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const rawDescription = read(row, columns.description);
    const description = normalizeText(rawDescription);
    if (row.some((value) => /_x000[DA]_|[\r\n]/i.test(String(value || "")))) {
      quality.normalizedLineBreakRows += 1;
    }
    if (/\*+\s*duplicate\b/i.test(description)) {
      quality.duplicateRows += 1;
      continue;
    }

    const wo = normalizeText(read(row, columns.wo));
    const customer = normalizeText(read(row, columns.customer));
    const part = normalizeText(read(row, columns.part));
    const process = normalizeText(read(row, columns.process));
    const endUser = normalizeText(read(row, columns.endUser));
    const special = normalizeText(read(row, columns.special));
    const rawDate = read(row, columns.date);
    const date = normalizeDate(rawDate);
    const priceResult = parsePrice(read(row, columns.price));

    if (![wo, customer, description, process].some(Boolean) && priceResult.blank) {
      quality.blankRows += 1;
      continue;
    }
    if (rawDate != null && rawDate !== "" && !date) {
      quality.invalidDates += 1;
      addInvalidSample(quality, rowIndex + 1, "date", rawDate);
    }
    if (!priceResult.valid) {
      quality.invalidPrices += 1;
      addInvalidSample(quality, rowIndex + 1, "price", read(row, columns.price));
    } else if (priceResult.blank) quality.blankPrices += 1;
    else if (priceResult.value === 0) quality.zeroPrices += 1;

    const partNumbers = extractPartNumbers(description);
    if (PN_MARKER_RE.test(description)) {
      quality.partNumberMarkerRows += 1;
      if (partNumbers.length) quality.partNumberExtractedRows += 1;
    }

    const record = {
      sourceRow: rowIndex + 1,
      date,
      customer,
      wo,
      part,
      price: priceResult.valid ? priceResult.value : null,
      description,
      process,
      endUser,
      special,
      partNumbers,
    };
    record.search = [date, customer, wo, part, description, process, endUser, special, ...partNumbers].join(" ").toLowerCase();
    records.push(record);
  }
  quality.loadedRows = records.length;
  return { records, quality };
}

function read(row, index) {
  return index >= 0 && index < row.length ? row[index] : null;
}

function addInvalidSample(quality, row, field, value) {
  if (quality.invalidSamples.length < 20) quality.invalidSamples.push({ row, field, value: String(value).slice(0, 120) });
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function calculateStats(records) {
  const priced = records.filter((record) => Number.isFinite(record.price) && record.price > 0);
  const prices = priced.map((record) => record.price);
  const dated = priced.filter((record) => record.date).slice().sort((a, b) => b.date.localeCompare(a.date));
  if (!prices.length) return { matches: records.length, priced: 0, median: null, average: null, p25: null, p75: null, min: null, max: null, latest: null, latestDate: "", trimmedAverage: null };
  const sorted = prices.slice().sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.1);
  const trimmed = sorted.length >= 10 ? sorted.slice(trim, sorted.length - trim) : sorted;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    matches: records.length,
    priced: prices.length,
    median: percentile(sorted, 0.5),
    average: mean(sorted),
    trimmedAverage: mean(trimmed),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    latest: dated[0]?.price ?? null,
    latestDate: dated[0]?.date ?? "",
  };
}

export function csvCell(value, allowNumeric = false) {
  let text = value == null ? "" : String(value);
  if (!allowNumeric && /^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

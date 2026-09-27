import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { extractPartNumbers, normalizeDate, normalizeText, parsePrice } from "../../core.js";
import { readWorkbook, sheetRows } from "./xlsx.js";

// Weekly Router History importer. Each completed export is validated and kept
// as a versioned snapshot keyed by the file's SHA-256. Queries read only the
// current snapshot, so replaying a file can never add jobs, and a rejected or
// partial file never replaces the last good snapshot.

export const IMPORTER_VERSION = "router-snapshot/1";
export const STORE_SCHEMA = "qpc-router-history-store/1";

export const ROUTER_EXPORT = {
  source: "LineItems_with_RouterHistory",
  fileName: /^(\d{2})(\d{2})(\d{2}) - LineItems_with_RouterHistory\.xlsx$/i,
  sheetName: "Line Items + Router History",
  headers: [
    "WO", "CUSTOMER", "RECEIVED", "PART ID", "LINE DESCRIPTION", "UNIT PRICE",
    "PROCESS", "END USER", "SPECIAL INSTRUCTIONS", "WoID(s)", "RouterSteps", "ROUTER FORMS",
  ],
  // The nine columns shared with the standard LINE ITEMS export; used to count
  // repeated occurrences without claiming they are duplicate business records.
  sharedColumns: 9,
};

export const DEFAULT_LIMITS = {
  minFileAgeMinutes: 10,
  maxRowShrink: 0.02,
  maxBlankDateShare: 0.02,
  maxInvalidDateShare: 0.005,
  maxInvalidPriceShare: 0.005,
  maxMissingWoShare: 0.005,
  staleAfterDays: 8,
};

export function exportDateFromName(fileName) {
  const match = String(fileName || "").match(ROUTER_EXPORT.fileName);
  if (!match) return null;
  const [, month, day, year] = match;
  const iso = `20${year}-${month}-${day}`;
  return normalizeDate(iso) === iso ? iso : null;
}

export function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function localDateTime(value) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function rawText(value) {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : localDateTime(value);
  return String(value);
}

function priceStatus(result) {
  if (result.blank) return "blank";
  if (!result.valid) return "invalid";
  if (result.value < 0) return "negative";
  if (result.value === 0) return "zero";
  return "positive";
}

export function normalizeRow(row, rowNumber) {
  const cell = (index) => (index < row.length ? row[index] : null);
  const descriptionRaw = rawText(cell(4));
  const description = normalizeText(descriptionRaw);
  const specialRaw = rawText(cell(8));
  const price = parsePrice(cell(5));
  const receivedRaw = rawText(cell(2));
  const record = {
    row: rowNumber,
    wo: normalizeText(cell(0)),
    customer: normalizeText(cell(1)),
    receivedRaw,
    received: normalizeDate(cell(2)),
    partId: normalizeText(cell(3)),
    descriptionRaw,
    description,
    unitPriceRaw: rawText(cell(5)),
    unitPrice: price.valid && !price.blank ? price.value : null,
    priceStatus: priceStatus(price),
    process: normalizeText(cell(6)),
    endUser: normalizeText(cell(7)),
    specialRaw,
    special: normalizeText(specialRaw),
    woIds: normalizeText(cell(9)),
    routerSteps: cell(10) == null || cell(10) === "" ? null : Number(cell(10)),
    routerForms: normalizeText(cell(11)),
    partNumbers: extractPartNumbers(description),
    duplicateMarked: /\*+\s*duplicate\b/i.test(description),
  };
  record.blankRow = ![record.wo, record.customer, record.description, record.process].some(Boolean) && price.blank;
  return record;
}

export function summarize(records, sharedRowKeys = []) {
  const summary = {
    rows: records.length,
    blankRows: 0,
    blankDates: 0,
    invalidDates: 0,
    receivedMin: "",
    receivedMax: "",
    prices: { positive: 0, zero: 0, blank: 0, invalid: 0, negative: 0 },
    missingWo: 0,
    duplicateMarked: 0,
    repeatedSharedOccurrences: 0,
    partNumberRows: 0,
  };
  const seen = new Set();
  records.forEach((record, index) => {
    if (record.blankRow) summary.blankRows += 1;
    if (!record.receivedRaw) summary.blankDates += 1;
    else if (!record.received) summary.invalidDates += 1;
    if (record.received) {
      if (!summary.receivedMin || record.received < summary.receivedMin) summary.receivedMin = record.received;
      if (!summary.receivedMax || record.received > summary.receivedMax) summary.receivedMax = record.received;
    }
    summary.prices[record.priceStatus] += 1;
    if (!record.blankRow && !record.wo) summary.missingWo += 1;
    if (record.duplicateMarked) summary.duplicateMarked += 1;
    if (record.partNumbers.length) summary.partNumberRows += 1;
    const key = sharedRowKeys[index];
    if (key !== undefined) {
      if (seen.has(key)) summary.repeatedSharedOccurrences += 1;
      else seen.add(key);
    }
  });
  return summary;
}

export function parseRouterExport(buffer) {
  const workbook = readWorkbook(buffer);
  const rows = sheetRows(workbook, ROUTER_EXPORT.sheetName);
  if (!rows) return { sheetFound: false, sheetNames: workbook.SheetNames, headers: [], records: [], summary: summarize([]) };
  const headers = (rows[0] || []).map((value) => normalizeText(value));
  const records = [];
  const sharedRowKeys = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (!row.some((value) => value != null && value !== "")) continue;
    records.push(normalizeRow(row, index + 1));
    sharedRowKeys.push(JSON.stringify(row.slice(0, ROUTER_EXPORT.sharedColumns).map(rawText)));
  }
  return { sheetFound: true, sheetNames: workbook.SheetNames, headers, records, summary: summarize(records, sharedRowKeys) };
}

export function checkHeaders(headers) {
  const expected = ROUTER_EXPORT.headers;
  const actual = headers.slice();
  while (actual.length && !actual[actual.length - 1]) actual.pop();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  const misordered = !missing.length && !unexpected.length && expected.some((name, index) => actual[index] !== name);
  return { ok: !missing.length && !unexpected.length && !misordered, missing, unexpected, misordered };
}

export function validateSnapshot({ fileName, fileAgeMinutes, parsed, previous, now = new Date(), limits = DEFAULT_LIMITS }) {
  const failures = [];
  const warnings = [];
  const exportDate = exportDateFromName(fileName);
  if (!exportDate) failures.push({ code: "file-name", detail: `"${fileName}" is not an MMDDYY - LineItems_with_RouterHistory.xlsx export` });
  else if (exportDate > now.toISOString().slice(0, 10)) failures.push({ code: "future-export-date", detail: exportDate });
  if (fileAgeMinutes != null && fileAgeMinutes < limits.minFileAgeMinutes) {
    failures.push({ code: "file-still-changing", detail: `modified ${fileAgeMinutes.toFixed(1)} min ago; retry after ${limits.minFileAgeMinutes} min` });
  }
  if (!parsed.sheetFound) {
    failures.push({ code: "sheet-missing", detail: `expected sheet "${ROUTER_EXPORT.sheetName}", found ${JSON.stringify(parsed.sheetNames)}` });
    return { ok: false, exportDate, failures, warnings };
  }
  const headerCheck = checkHeaders(parsed.headers);
  if (!headerCheck.ok) failures.push({ code: "header-mismatch", detail: headerCheck });

  const summary = parsed.summary;
  const dataRows = summary.rows - summary.blankRows;
  if (dataRows <= 0) failures.push({ code: "no-rows", detail: "no data rows" });
  const share = (count) => (dataRows > 0 ? count / dataRows : 0);
  if (share(summary.blankDates) > limits.maxBlankDateShare) failures.push({ code: "blank-dates", detail: `${summary.blankDates} of ${dataRows}` });
  if (share(summary.invalidDates) > limits.maxInvalidDateShare) failures.push({ code: "invalid-dates", detail: `${summary.invalidDates} of ${dataRows}` });
  if (share(summary.prices.invalid) > limits.maxInvalidPriceShare) failures.push({ code: "invalid-prices", detail: `${summary.prices.invalid} of ${dataRows}` });
  if (share(summary.missingWo) > limits.maxMissingWoShare) failures.push({ code: "missing-wo", detail: `${summary.missingWo} of ${dataRows}` });

  const isOlder = Boolean(previous && exportDate && exportDate < previous.exportDate);
  if (previous && !isOlder) {
    if (summary.rows < previous.rows * (1 - limits.maxRowShrink)) {
      failures.push({ code: "row-shrink", detail: `${summary.rows} rows vs ${previous.rows} in ${previous.fileName}` });
    } else if (summary.rows < previous.rows) {
      warnings.push({ code: "row-shrink-within-tolerance", detail: `${summary.rows} rows vs ${previous.rows}` });
    }
    if (summary.receivedMax && previous.receivedMax && summary.receivedMax < previous.receivedMax) {
      failures.push({ code: "coverage-regression", detail: `newest received ${summary.receivedMax} is older than ${previous.receivedMax}` });
    }
  }
  if (exportDate && summary.receivedMax) {
    const lagDays = (Date.parse(exportDate) - Date.parse(summary.receivedMax)) / 86400000;
    if (lagDays > 7) warnings.push({ code: "coverage-lag", detail: `newest received date ${summary.receivedMax} is ${lagDays} days before export date ${exportDate}` });
  }
  return { ok: !failures.length, exportDate, isOlder, failures, warnings };
}

// ---------- private store ----------

function storePaths(storeDir) {
  return {
    manifest: path.join(storeDir, "manifest.json"),
    attempts: path.join(storeDir, "attempts.jsonl"),
    lock: path.join(storeDir, ".import.lock"),
    snapshots: path.join(storeDir, "snapshots"),
  };
}

function writeFileAtomic(filePath, data) {
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, filePath);
}

export function readManifest(storeDir) {
  const { manifest } = storePaths(storeDir);
  if (!fs.existsSync(manifest)) return { schema: STORE_SCHEMA, current: null, snapshots: {} };
  return JSON.parse(fs.readFileSync(manifest, "utf8"));
}

function appendAttempt(storeDir, attempt) {
  fs.appendFileSync(storePaths(storeDir).attempts, `${JSON.stringify(attempt)}\n`);
}

function acquireLock(storeDir, now) {
  const { lock } = storePaths(storeDir);
  try {
    const fd = fs.openSync(lock, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
    fs.closeSync(fd);
    return () => fs.rmSync(lock, { force: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const ageMinutes = (now.getTime() - fs.statSync(lock).mtimeMs) / 60000;
    if (ageMinutes > 30) {
      fs.rmSync(lock, { force: true });
      return acquireLock(storeDir, now);
    }
    throw new Error(`Another import holds ${lock}; retry later.`);
  }
}

export function importSnapshot(filePath, { storeDir, limits = DEFAULT_LIMITS, now = new Date(), remote = null } = {}) {
  if (!storeDir) throw new Error("storeDir is required");
  fs.mkdirSync(storePaths(storeDir).snapshots, { recursive: true });
  const release = acquireLock(storeDir, now);
  try {
    const fileName = path.basename(filePath);
    const stat = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    const sha256 = sha256Buffer(buffer);
    const manifest = readManifest(storeDir);
    const base = { at: now.toISOString(), importer: IMPORTER_VERSION, fileName, filePath, bytes: stat.size, fileModified: stat.mtime.toISOString(), sha256 };

    if (manifest.snapshots[sha256]) {
      const attempt = { ...base, outcome: "replay-noop", detail: `already stored as ${manifest.snapshots[sha256].status} snapshot` };
      appendAttempt(storeDir, attempt);
      return attempt;
    }

    const parsed = parseRouterExport(buffer);
    const previous = manifest.current ? manifest.snapshots[manifest.current] : null;
    const fileAgeMinutes = (now.getTime() - stat.mtimeMs) / 60000;
    const validation = validateSnapshot({ fileName, fileAgeMinutes, parsed, previous, now, limits });
    if (!validation.ok) {
      const attempt = { ...base, outcome: "rejected", failures: validation.failures, warnings: validation.warnings, summary: parsed.summary };
      appendAttempt(storeDir, attempt);
      return attempt;
    }

    const status = validation.isOlder ? "archived" : "current";
    const meta = {
      snapshotId: sha256,
      source: ROUTER_EXPORT.source,
      fileName,
      filePath,
      bytes: stat.size,
      fileModified: stat.mtime.toISOString(),
      exportDate: validation.exportDate,
      sheet: ROUTER_EXPORT.sheetName,
      headers: parsed.headers,
      importedAt: now.toISOString(),
      importer: IMPORTER_VERSION,
      remote,
      ...parsed.summary,
      warnings: validation.warnings,
    };
    const { snapshots } = storePaths(storeDir);
    const lines = parsed.records.map((record) => JSON.stringify(record)).join("\n");
    writeFileAtomic(path.join(snapshots, `${sha256}.jsonl.gz`), zlib.gzipSync(lines));
    writeFileAtomic(path.join(snapshots, `${sha256}.meta.json`), JSON.stringify(meta, null, 2));

    const entry = { ...meta, status };
    delete entry.headers;
    delete entry.warnings;
    manifest.snapshots[sha256] = entry;
    if (status === "current") {
      if (previous) manifest.snapshots[manifest.current].status = "archived";
      manifest.current = sha256;
    }
    manifest.schema = STORE_SCHEMA;
    manifest.updatedAt = now.toISOString();
    writeFileAtomic(storePaths(storeDir).manifest, JSON.stringify(manifest, null, 2));

    const attempt = { ...base, outcome: status === "current" ? "accepted" : "archived-older", exportDate: validation.exportDate, warnings: validation.warnings, summary: parsed.summary };
    appendAttempt(storeDir, attempt);
    return attempt;
  } finally {
    release();
  }
}

export function loadSnapshotRecords(storeDir, snapshotId) {
  const manifest = readManifest(storeDir);
  const id = snapshotId || manifest.current;
  if (!id) throw new Error("No accepted Router History snapshot in the store. Run the importer first.");
  const file = path.join(storePaths(storeDir).snapshots, `${id}.jsonl.gz`);
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  return { meta: manifest.snapshots[id], records: text ? text.split("\n").map((line) => JSON.parse(line)) : [] };
}

export function listExports(folder) {
  return fs.readdirSync(folder)
    .filter((name) => ROUTER_EXPORT.fileName.test(name))
    .map((name) => ({ name, exportDate: exportDateFromName(name), path: path.join(folder, name) }))
    .filter((item) => item.exportDate)
    .sort((a, b) => a.exportDate.localeCompare(b.exportDate));
}

export function snapshotStatus(storeDir, { now = new Date(), folder = null, limits = DEFAULT_LIMITS } = {}) {
  const manifest = readManifest(storeDir);
  const current = manifest.current ? manifest.snapshots[manifest.current] : null;
  const attemptsFile = storePaths(storeDir).attempts;
  const attempts = fs.existsSync(attemptsFile)
    ? fs.readFileSync(attemptsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const lastAttempt = attempts[attempts.length - 1] || null;
  const status = {
    current: current ? {
      snapshotId: manifest.current,
      fileName: current.fileName,
      exportDate: current.exportDate,
      receivedMin: current.receivedMin,
      receivedMax: current.receivedMax,
      rows: current.rows,
      importedAt: current.importedAt,
      exportAgeDays: Math.floor((now.getTime() - Date.parse(`${current.exportDate}T00:00:00`)) / 86400000),
    } : null,
    stale: !current,
    lastAttempt: lastAttempt ? { at: lastAttempt.at, fileName: lastAttempt.fileName, outcome: lastAttempt.outcome } : null,
    unimportedNewerExports: [],
  };
  if (status.current) status.stale = status.current.exportAgeDays > limits.staleAfterDays;
  if (folder && fs.existsSync(folder)) {
    const known = new Set(Object.values(manifest.snapshots).map((snapshot) => snapshot.fileName));
    status.unimportedNewerExports = listExports(folder)
      .filter((item) => !known.has(item.name) && (!current || item.exportDate > current.exportDate))
      .map((item) => item.name);
  }
  return status;
}

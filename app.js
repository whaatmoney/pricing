import { buildDataset, calculateStats, csvCell, findHeaderRow } from "./core.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PAGE_SIZE = 500;
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-US");

const state = {
  records: [],
  filtered: [],
  quality: null,
  file: null,
  sheetName: "",
  sort: { field: "date", direction: -1 },
};

const columns = [
  ["date", "Received"], ["customer", "Customer"], ["wo", "WO"], ["part", "Part ID"],
  ["partNumbers", "Customer P/N"], ["price", "Unit price"], ["process", "Process / spec"],
  ["endUser", "End user"], ["description", "Description"],
];

document.addEventListener("DOMContentLoaded", () => {
  initializeTheme();
  buildTableHead();
  bindEvents();
  updateActionStates();
});

function bindEvents() {
  $("welcomeLoadBtn").addEventListener("click", chooseFile);
  $("reloadBtn").addEventListener("click", chooseFile);
  $("fileInput").addEventListener("change", (event) => loadFile(event.target.files?.[0]));
  $("welcomeCard").addEventListener("dragover", dragOver);
  $("welcomeCard").addEventListener("dragleave", dragLeave);
  $("welcomeCard").addEventListener("drop", dropFile);
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    if (document.body.classList.contains("no-data")) return;
    loadFile(event.dataTransfer?.files?.[0]);
  });

  ["q", "pn", "process", "dateFrom", "dateTo"].forEach((id) => $(id).addEventListener("input", debounce(applyFilters, 120)));
  $("customer").addEventListener("change", applyFilters);
  $("showZero").addEventListener("change", applyFilters);
  $("clearBtn").addEventListener("click", clearFilters);
  $("copyBtn").addEventListener("click", copySummary);
  $("exportBtn").addEventListener("click", exportCsv);
  $("qualityToggle").addEventListener("click", toggleQuality);
  $("advancedFiltersToggle").addEventListener("click", toggleAdvancedFilters);
  $("themeMode").addEventListener("change", (event) => setTheme(event.target.value, true));
  $("reviewEvidenceBtn").addEventListener("click", () => $("results").scrollIntoView({ behavior: "smooth", block: "start" }));
  window.addEventListener("resize", debounce(renderChart, 100));
}

function initializeTheme() {
  let saved = "system";
  try { saved = localStorage.getItem("qpc-price-theme") || "system"; } catch { /* Preference storage is optional. */ }
  $("themeMode").value = ["system", "light", "dark"].includes(saved) ? saved : "system";
  setTheme($("themeMode").value, false);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ($("themeMode").value === "system") setTheme("system", false);
  });
}

function setTheme(mode, persist) {
  const resolved = mode === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  document.documentElement.dataset.theme = resolved;
  if (persist) {
    try { localStorage.setItem("qpc-price-theme", mode); } catch { /* Keep the selected theme for this visit. */ }
  }
  if (state.records.length) requestAnimationFrame(renderChart);
}

function chooseFile() {
  $("fileInput").value = "";
  $("fileInput").click();
}

function dragOver(event) {
  event.preventDefault();
  $("welcomeCard").classList.add("drag-active");
}

function dragLeave() {
  $("welcomeCard").classList.remove("drag-active");
}

function dropFile(event) {
  event.preventDefault();
  dragLeave();
  loadFile(event.dataTransfer?.files?.[0]);
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return showToast("That file is larger than 25 MB. Export a smaller history file and try again.", "error");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["xlsx", "xls", "xlsm", "csv"].includes(extension)) return showToast("Choose an Excel or CSV file.", "error");

  setLoading(true, `Checking ${file.name}…`);
  await nextPaint();
  try {
    const parsed = extension === "csv" ? await readCsv(file) : await readWorkbook(file);
    const dataset = buildDataset(parsed.rows, parsed.header.index, parsed.sheetName);
    dataset.quality.workbookSheets = parsed.sheetCount;
    dataset.quality.selectedSheet = parsed.sheetName;
    state.records = dataset.records;
    state.quality = dataset.quality;
    state.file = file;
    state.sheetName = parsed.sheetName;
    populateCustomers();
    renderQuality();
    document.body.classList.remove("no-data");
    setSourceSummary(`${file.name} · ${whole.format(state.records.length)} accepted lines · ${parsed.sheetName}`, "success");
    applyFilters();
    showToast(`Loaded ${whole.format(state.records.length)} usable line items.`, "success");
  } catch (error) {
    console.error(error);
    showToast(error?.message || "The spreadsheet could not be read.", "error");
  } finally {
    setLoading(false);
  }
}

async function readCsv(file) {
  const text = await file.text();
  if (!window.XLSX) throw new Error("The spreadsheet reader did not initialize. Refresh and try again.");
  const workbook = window.XLSX.read(text, { type: "string", cellDates: true });
  return chooseDataSheet(workbook);
}

async function readWorkbook(file) {
  if (!window.XLSX) throw new Error("The spreadsheet reader did not initialize. Check your connection, refresh, and try again.");
  const data = new Uint8Array(await file.arrayBuffer());
  const workbook = window.XLSX.read(data, { type: "array", cellDates: true, dense: true });
  return chooseDataSheet(workbook);
}

function chooseDataSheet(workbook) {
  let best = null;
  for (const sheetName of workbook.SheetNames) {
    const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true });
    const header = findHeaderRow(rows);
    const score = Object.values(header.columns || {}).filter((index) => index >= 0).length;
    if (!best || score > best.score) best = { rows, header, score, sheetName };
    if (!header.missing?.length) return { rows, header, sheetName, sheetCount: workbook.SheetNames.length };
  }
  if (!best) throw new Error("The workbook has no readable sheets.");
  throw new Error(`No sheet contains the required columns. Missing: ${best.header.missing.join(", ")}.`);
}

function populateCustomers() {
  const counts = new Map();
  state.records.forEach((record) => record.customer && counts.set(record.customer, (counts.get(record.customer) || 0) + 1));
  const options = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  $("customer").replaceChildren(new Option("All customers", ""), ...options.map(([name, count]) => new Option(`${name} (${whole.format(count)})`, name)));
}

function applyFilters() {
  if (!state.records.length) return;
  const tokens = $("q").value.trim().toLowerCase().match(/"[^"]+"|\S+/g)?.map((token) => token.replace(/^"|"$/g, "")) || [];
  const customer = $("customer").value;
  const pn = $("pn").value.trim().toLowerCase();
  const process = $("process").value.trim().toLowerCase();
  const from = $("dateFrom").value;
  const to = $("dateTo").value;
  const showZero = $("showZero").checked;

  state.filtered = state.records.filter((record) => {
    if (!showZero && !(record.price > 0)) return false;
    if (customer && record.customer !== customer) return false;
    if (pn && !record.partNumbers.some((value) => value.toLowerCase().includes(pn))) return false;
    if (process && !record.process.toLowerCase().includes(process)) return false;
    if (from && (!record.date || record.date < from)) return false;
    if (to && (!record.date || record.date > to)) return false;
    return tokens.every((token) => record.search.includes(token));
  });
  sortFiltered();
  renderAnalysis();
  renderTable();
  updateActionStates();
}

function updateActionStates() {
  const filterCount = activeFilterLabels().length;
  const hasResults = state.filtered.length > 0;
  $("clearBtn").disabled = filterCount === 0;
  $("copyBtn").disabled = !hasResults;
  $("exportBtn").disabled = !hasResults;
  $("activeFilterCount").hidden = filterCount === 0;
  $("activeFilterCount").textContent = `${filterCount} active`;
}

function sortFiltered() {
  const { field, direction } = state.sort;
  state.filtered.sort((a, b) => {
    let left = field === "partNumbers" ? a.partNumbers[0] || "" : a[field] ?? "";
    let right = field === "partNumbers" ? b.partNumbers[0] || "" : b[field] ?? "";
    if (field === "price") {
      left = Number.isFinite(left) ? left : -Infinity;
      right = Number.isFinite(right) ? right : -Infinity;
    }
    return left < right ? -direction : left > right ? direction : 0;
  });
}

function renderAnalysis() {
  const stats = calculateStats(state.filtered);
  $("sMatches").textContent = whole.format(stats.matches);
  $("sPriced").textContent = whole.format(stats.priced);
  $("sMedian").textContent = formatMoney(stats.median);
  $("sLatest").textContent = formatMoney(stats.latest);
  $("sRecency").textContent = formatDate(stats.latestDate);
  $("sRange").textContent = stats.p25 == null ? "—" : `${formatMoney(stats.p25)}–${formatMoney(stats.p75)}`;
  renderRecommendation(stats);
  renderChart();
}

function renderRecommendation(stats) {
  const active = activeFilterLabels();
  const hasComparableScope = Boolean($("customer").value || $("pn").value.trim() || $("process").value.trim());
  const ageDays = stats.latestDate ? Math.floor((Date.now() - new Date(`${stats.latestDate}T12:00:00`).getTime()) / 86400000) : Infinity;
  let confidence = "Limited match";
  let confidenceLevel = "low";
  if (!hasComparableScope && stats.priced) {
    confidence = "Broad baseline";
    confidenceLevel = "baseline";
  } else if (stats.priced >= 20 && ageDays <= 730) {
    confidence = "Strong match";
    confidenceLevel = "high";
  } else if (stats.priced >= 5 && ageDays <= 1460) {
    confidence = "Useful match";
    confidenceLevel = "medium";
  }
  $("confidenceBadge").textContent = stats.priced ? confidence : "No sample";
  $("confidenceBadge").dataset.level = stats.priced ? confidenceLevel : "low";
  $("recommendationRange").textContent = stats.p25 == null ? "—" : `${formatMoney(stats.p25)} – ${formatMoney(stats.p75)}`;
  if (!stats.priced) {
    $("recommendationCopy").textContent = "No positive-priced lines match the current filters.";
  } else if (!hasComparableScope) {
    $("recommendationCopy").textContent = `Portfolio-wide baseline from ${whole.format(stats.priced)} priced lines. Define a customer, P/N, or process above before using the range to support a quote.`;
  } else {
    $("recommendationCopy").textContent = `Observed range from ${whole.format(stats.priced)} priced line${stats.priced === 1 ? "" : "s"}${active.length ? ` matching ${active.join(", ")}` : ""}. Use the median as the center and review the source work before quoting.`;
  }
  const facts = [
    ["Median", formatMoney(stats.median)],
    ["Trimmed average", formatMoney(stats.trimmedAverage)],
    ["Latest price", formatMoney(stats.latest)],
    ["Latest record", stats.latestDate || "—"],
    ["Sample", `${whole.format(stats.priced)} priced / ${whole.format(stats.matches)} matching`],
  ];
  $("recommendationFacts").replaceChildren(...facts.flatMap(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
}

function renderQuality() {
  const q = state.quality;
  const extractionRate = q.partNumberMarkerRows ? q.partNumberExtractedRows / q.partNumberMarkerRows : 1;
  const cards = [
    [whole.format(q.sourceRows), "Source rows", "neutral"],
    [whole.format(q.loadedRows), "Accepted lines", "good"],
    [whole.format(q.duplicateRows), "Duplicates excluded", q.duplicateRows ? "good" : "neutral"],
    [whole.format(q.normalizedLineBreakRows), "Rows cleaned", q.normalizedLineBreakRows ? "good" : "neutral"],
    [whole.format(q.zeroPrices + q.blankPrices), "$0 or blank prices", q.zeroPrices + q.blankPrices ? "warn" : "good"],
    [`${(extractionRate * 100).toFixed(1)}%`, "P/N marker extraction", extractionRate >= 0.98 ? "good" : "warn"],
  ];
  $("qualityGrid").replaceChildren(...cards.map(([value, label, tone]) => {
    const card = document.createElement("div"); card.className = `quality-card ${tone}`;
    const strong = document.createElement("strong"); strong.textContent = value;
    const span = document.createElement("span"); span.textContent = label;
    card.append(strong, span); return card;
  }));

  const warnings = [];
  if (q.workbookSheets > 1) warnings.push(`Selected “${q.selectedSheet}” from ${q.workbookSheets} sheets because it matched the required headers.`);
  if (q.headerRow > 1) warnings.push(`Headers were found on row ${q.headerRow}; preceding rows were ignored.`);
  if (q.invalidPrices) warnings.push(`${whole.format(q.invalidPrices)} price value${q.invalidPrices === 1 ? " was" : "s were"} rejected because the complete value was not numeric.`);
  if (q.invalidDates) warnings.push(`${whole.format(q.invalidDates)} date value${q.invalidDates === 1 ? " was" : "s were"} invalid and excluded from date filtering.`);
  if (!warnings.length) warnings.push("Required columns, prices, and dates passed validation.");
  $("warningList").replaceChildren(...warnings.map((message) => { const li = document.createElement("li"); li.textContent = message; return li; }));
  const exclusions = q.duplicateRows + q.invalidPrices + q.invalidDates;
  $("importReceiptSummary").textContent = `${whole.format(q.loadedRows)} accepted · ${whole.format(q.duplicateRows)} duplicates removed · ${whole.format(q.invalidPrices + q.invalidDates)} invalid values`;
  $("qualityTitle").textContent = exclusions ? "Import verified with notes" : "Import verified";
}

function renderChart() {
  const canvas = $("priceChart");
  if (!canvas || !state.filtered.length) return clearCanvas(canvas);
  const points = state.filtered.filter((record) => record.price > 0 && record.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) return clearCanvas(canvas);
  const sampled = sampleEvenly(points, 800);
  const prices = sampled.map((record) => record.price).sort((a, b) => a - b);
  const cap = prices[Math.floor((prices.length - 1) * 0.95)] || prices.at(-1);
  const start = new Date(`${sampled[0].date}T12:00:00`).getTime();
  const end = new Date(`${sampled.at(-1).date}T12:00:00`).getTime();
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 760;
  const height = 290;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const pad = { left: 58, right: 18, top: 16, bottom: 34 };
  const x = (date) => pad.left + ((new Date(`${date}T12:00:00`).getTime() - start) / Math.max(1, end - start)) * (width - pad.left - pad.right);
  const y = (price) => pad.top + (1 - Math.min(price, cap) / Math.max(1, cap)) * (height - pad.top - pad.bottom);
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const lineColor = styles.getPropertyValue("--line").trim();
  const mutedColor = styles.getPropertyValue("--muted").trim();
  const infoColor = styles.getPropertyValue("--info").trim();
  const goldColor = styles.getPropertyValue("--gold").trim();
  ctx.strokeStyle = lineColor; ctx.fillStyle = mutedColor; ctx.font = "12px system-ui";
  for (let i = 0; i <= 4; i += 1) {
    const py = pad.top + i * (height - pad.top - pad.bottom) / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(width - pad.right, py); ctx.stroke();
    ctx.fillText(formatCompactMoney(cap * (1 - i / 4)), 4, py + 4);
  }
  ctx.fillStyle = infoColor;
  ctx.globalAlpha = .48;
  sampled.forEach((record) => { ctx.beginPath(); ctx.arc(x(record.date), y(record.price), 2.4, 0, Math.PI * 2); ctx.fill(); });
  ctx.globalAlpha = 1;
  const stats = calculateStats(state.filtered);
  if (stats.median != null) {
    ctx.strokeStyle = goldColor; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(pad.left, y(stats.median)); ctx.lineTo(width - pad.right, y(stats.median)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = mutedColor; ctx.fillText(sampled[0].date, pad.left, height - 10);
  const endLabel = sampled.at(-1).date; const endWidth = ctx.measureText(endLabel).width;
  ctx.fillText(endLabel, width - pad.right - endWidth, height - 10);
  $("chartNote").textContent = prices.at(-1) > cap ? `Scale capped at 95th percentile (${formatMoney(cap)})` : "Median shown in gold";
  $("chartDescription").textContent = `${whole.format(points.length)} priced records from ${sampled[0].date} through ${sampled.at(-1).date}; median ${formatMoney(stats.median)}.`;
}

function clearCanvas(canvas) {
  if (!canvas) return;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  $("chartDescription").textContent = "No dated price records match the current filters.";
  $("chartNote").textContent = "No dated prices";
}

function buildTableHead() {
  $("tableHead").replaceChildren(...columns.map(([field, label]) => {
    const th = document.createElement("th"); th.scope = "col";
    const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset.field = field;
    button.addEventListener("click", () => {
      state.sort.direction = state.sort.field === field ? -state.sort.direction : (field === "date" || field === "price" ? -1 : 1);
      state.sort.field = field; sortFiltered(); renderTable(); updateSortHeaders();
    });
    th.append(button); return th;
  }));
  updateSortHeaders();
}

function updateSortHeaders() {
  $("tableHead").querySelectorAll("button").forEach((button) => {
    const active = button.dataset.field === state.sort.field;
    button.parentElement.setAttribute("aria-sort", active ? (state.sort.direction === 1 ? "ascending" : "descending") : "none");
  });
}

function renderTable() {
  const showing = state.filtered.slice(0, PAGE_SIZE);
  $("resultCount").textContent = state.filtered.length > PAGE_SIZE
    ? `Showing ${whole.format(PAGE_SIZE)} of ${whole.format(state.filtered.length)} lines`
    : `${whole.format(state.filtered.length)} line${state.filtered.length === 1 ? "" : "s"}`;
  if (!showing.length) {
    const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = columns.length; td.className = "empty-cell"; td.textContent = "No line items match these filters."; tr.append(td); $("tableBody").replaceChildren(tr); return;
  }
  $("tableBody").replaceChildren(...showing.map((record) => {
    const tr = document.createElement("tr");
    columns.forEach(([field]) => {
      const td = document.createElement("td");
      let value = field === "partNumbers" ? record.partNumbers.join(" · ") : record[field];
      if (field === "price") { td.className = "number"; value = formatMoney(value); }
      if (field === "description") td.className = "description";
      td.textContent = value || "—"; tr.append(td);
    });
    return tr;
  }));
}

function clearFilters() {
  ["q", "pn", "process", "dateFrom", "dateTo"].forEach((id) => { $(id).value = ""; });
  $("customer").value = ""; $("showZero").checked = false; applyFilters();
}

async function copySummary() {
  const stats = calculateStats(state.filtered);
  const text = [
    "QPC Price History — historical reference",
    `Source: ${state.file?.name || "—"}`,
    `Filters: ${activeFilterLabels().join(", ") || "none"}`,
    `Matching lines: ${stats.matches}`,
    `Priced lines: ${stats.priced}`,
    `Median: ${formatMoney(stats.median)}`,
    `Trimmed average: ${formatMoney(stats.trimmedAverage)}`,
    `P25–P75: ${formatMoney(stats.p25)}–${formatMoney(stats.p75)}`,
    `Latest: ${formatMoney(stats.latest)} (${stats.latestDate || "no date"})`,
  ].join("\n");
  try { await navigator.clipboard.writeText(text); showToast("Summary copied.", "success"); }
  catch { showToast("Clipboard access was unavailable.", "error"); }
}

function exportCsv() {
  if (!state.filtered.length) return showToast("There are no filtered rows to export.", "error");
  const header = ["Date", "Customer", "WO", "Part ID", "Customer P/N", "Unit Price", "Description", "Process", "End User", "Special Instructions", "Source Row"];
  const rows = state.filtered.map((record) => [record.date, record.customer, record.wo, record.part, record.partNumbers.join(" | "), record.price ?? "", record.description, record.process, record.endUser, record.special, record.sourceRow]);
  const csv = [header, ...rows].map((row) => row.map((cell, index) => csvCell(cell, index === 5 || index === 10)).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `qpc_price_history_${new Date().toISOString().slice(0, 10)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function toggleQuality() {
  const hidden = $("qualityDetails").hidden;
  $("qualityDetails").hidden = !hidden;
  $("qualityToggle").setAttribute("aria-expanded", String(hidden));
  $("qualityToggle").textContent = hidden ? "Hide details" : "View details";
}

function toggleAdvancedFilters() {
  const hidden = $("advancedFilters").hidden;
  $("advancedFilters").hidden = !hidden;
  $("advancedFiltersToggle").setAttribute("aria-expanded", String(hidden));
  $("advancedFiltersToggle").textContent = hidden ? "Fewer filters" : "More filters";
  if (hidden) $("q").focus();
}

function activeFilterLabels() {
  const labels = [];
  if ($("customer").value) labels.push(`customer ${$("customer").value}`);
  if ($("pn").value.trim()) labels.push(`P/N containing ${$("pn").value.trim()}`);
  if ($("process").value.trim()) labels.push(`process containing ${$("process").value.trim()}`);
  if ($("q").value.trim()) labels.push(`search “${$("q").value.trim()}”`);
  if ($("dateFrom").value || $("dateTo").value) labels.push(`dates ${$("dateFrom").value || "…"} to ${$("dateTo").value || "…"}`);
  if ($("showZero").checked) labels.push("including $0 and blank prices");
  return labels;
}

function setSourceSummary(message, tone = "") {
  const summary = $("sourceSummary");
  summary.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "status-dot";
  if (tone) dot.dataset.tone = tone;
  dot.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = message;
  summary.append(dot, text);
}

function formatMoney(value) { return value == null || !Number.isFinite(value) ? "—" : money.format(value); }
function formatDate(value) { return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "—"; }
function formatCompactMoney(value) { return value >= 1000 ? `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : `$${Math.round(value)}`; }
function sampleEvenly(values, max) { if (values.length <= max) return values; const step = values.length / max; return Array.from({ length: max }, (_, index) => values[Math.floor(index * step)]); }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function nextPaint() { return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))); }
function setLoading(active, text = "Reading spreadsheet…") { $("loading").hidden = !active; $("loadingText").textContent = text; }
function showToast(message, type = "") { const toast = $("toast"); toast.textContent = message; toast.className = `toast show ${type}`; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.className = "toast"; }, 4500); }

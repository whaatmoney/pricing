import { buildDataset, calculateStats, csvCell, findHeaderRow, parseRouterSteps } from "./core.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Mirrors the Operations Center Find tool (whaatmoney.github.io/qpct) — same
// URL scheme and localStorage keys, so lookups and group choice are shared.
const VIVA_GROUPS = [
  { key: "all", label: "All groups", short: "All", groupId: null },
  { key: "inspection", label: "Inspection", short: "Inspection", groupId: "14999188" },
  { key: "ncr", label: "NCR", short: "NCR", groupId: "14824878" },
  { key: "packaging", label: "Packaging Inspection", short: "Packaging", groupId: "15414084" },
];
const VIVA_SEARCH_BASE = "https://engage.cloud.microsoft/main/search";
const VIVA_RECENT_KEY = "pnwiki:recent";
const VIVA_DEPT_KEY = "pnwiki:lastDept";
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
  selectedRow: null,
  vivaExact: true,
  vivaDept: null,
};

const columns = [
  ["date", "Received"], ["wo", "WO"], ["customer", "Customer"],
  ["part", "Part ID"], ["description", "Line description"], ["price", "Unit price"],
  ["process", "Process"], ["router", "Router forms"],
  ["special", "Special instructions"], ["endUser", "End user"],
];

document.addEventListener("DOMContentLoaded", () => {
  initializeTheme();
  buildTableHead();
  bindEvents();
  initSelectionLookup();
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

  ["q", "pn", "process", "dateFrom", "dateTo"].forEach((id) => $(id).addEventListener("input", debounce(applyFilters, 80)));
  $("customer").addEventListener("change", applyFilters);
  $("customerBtn").addEventListener("click", () => toggleCustomerPop());
  $("customerSearch").addEventListener("input", debounce(() => renderCustomerList($("customerSearch").value), 60));
  $("customerList").addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (option) selectCustomer(option.dataset.value);
  });
  $("customerCombo").addEventListener("keydown", customerKeydown);
  document.addEventListener("click", (event) => {
    if (!$("customerPop").hidden && !$("customerCombo").contains(event.target)) toggleCustomerPop(false);
  });
  $("showZero").addEventListener("change", applyFilters);
  $("showZeroChip").addEventListener("click", () => {
    $("showZero").checked = !$("showZero").checked;
    $("showZero").dispatchEvent(new Event("change"));
  });
  $("filterChips").addEventListener("click", removeFilterChip);
  $("quickSpecs").addEventListener("click", applyQuickSpec);
  $("clearBtn").addEventListener("click", clearFilters);
  $("copyBtn").addEventListener("click", copySummary);
  $("exportBtn").addEventListener("click", exportCsv);
  $("qualityToggle").addEventListener("click", toggleQuality);
  $("advancedFiltersToggle").addEventListener("click", toggleAdvancedFilters);
  $("pricingJumpBtn").addEventListener("click", () => {
    $("pricingAnalysis").open = true;
    $("pricingAnalysis").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("pricingAnalysis").addEventListener("toggle", () => {
    if ($("pricingAnalysis").open) requestAnimationFrame(renderChart);
  });
  $("reviewEvidenceBtn").addEventListener("click", () => $("results").scrollIntoView({ behavior: "smooth", block: "start" }));
  document.querySelectorAll("[data-copy-stat]").forEach((button) => button.addEventListener("click", copyStat));
  window.addEventListener("resize", debounce(renderChart, 100));
}

function initializeTheme() {
  let saved = "system";
  try { saved = localStorage.getItem("qpc-price-theme") || "system"; } catch { /* Preference storage is optional. */ }
  if (!["system", "light", "dark"].includes(saved)) saved = "system";
  const control = $("themeControl");
  [["system", "System"], ["light", "Light"], ["dark", "Dark"]].forEach(([mode, label]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "theme-chip";
    chip.dataset.mode = mode;
    chip.setAttribute("role", "radio");
    chip.title = `${label} theme`;
    const text = document.createElement("span");
    text.textContent = label;
    chip.append(text);
    chip.addEventListener("click", () => setTheme(mode, true));
    control.append(chip);
  });
  setTheme(saved, false);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ($("themeControl").dataset.mode === "system") setTheme("system", false);
  });
}

function setTheme(mode, persist) {
  const resolved = mode === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  document.documentElement.dataset.theme = resolved;
  const control = $("themeControl");
  control.dataset.mode = mode;
  control.querySelectorAll(".theme-chip").forEach((chip) => {
    const active = chip.dataset.mode === mode;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-checked", String(active));
  });
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
  state.customers = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  renderCustomerList("");
}

function renderCustomerList(query) {
  const q = query.trim().toLowerCase();
  const current = $("customer").value;
  const entries = [["", state.records.length]]
    .concat((state.customers || []).filter(([name]) => !q || name.toLowerCase().includes(q)));
  $("customerList").replaceChildren(...entries.map(([name, count]) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = name;
    li.setAttribute("aria-selected", String(name === current));
    const label = document.createElement("span");
    label.className = "combo-option-label";
    label.textContent = name || "All customers";
    const badge = document.createElement("span");
    badge.className = "combo-count";
    badge.textContent = whole.format(count);
    li.append(label, badge);
    return li;
  }));
}

function syncCustomerTrigger() {
  const value = $("customer").value;
  const label = $("customerLabel");
  label.replaceChildren();
  const name = document.createElement("span");
  name.className = "combo-value-text";
  name.textContent = value || "All customers";
  label.append(name);
  const count = value
    ? (state.customers || []).find(([customer]) => customer === value)?.[1]
    : state.records.length;
  if (count != null) {
    const badge = document.createElement("span");
    badge.className = "combo-count";
    badge.textContent = whole.format(count);
    label.append(badge);
  }
}

function toggleCustomerPop(open = $("customerPop").hidden) {
  $("customerPop").hidden = !open;
  $("customerBtn").setAttribute("aria-expanded", String(open));
  if (open) {
    $("customerSearch").value = "";
    renderCustomerList("");
    $("customerSearch").focus();
  }
}

function selectCustomer(value) {
  $("customer").value = value;
  toggleCustomerPop(false);
  $("customerBtn").focus();
  $("customer").dispatchEvent(new Event("change"));
}

function customerKeydown(event) {
  if (event.key === "Escape" && !$("customerPop").hidden) {
    event.preventDefault();
    toggleCustomerPop(false);
    $("customerBtn").focus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key) || $("customerPop").hidden) return;
  const options = [...$("customerList").querySelectorAll("[data-value]")];
  if (!options.length) return;
  let index = options.findIndex((option) => option.classList.contains("focused"));
  if (event.key === "Enter") {
    event.preventDefault();
    if (index >= 0) selectCustomer(options[index].dataset.value);
    return;
  }
  event.preventDefault();
  index = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
  options.forEach((option, i) => option.classList.toggle("focused", i === index));
  options[index].scrollIntoView({ block: "nearest" });
}

function applyFilters() {
  if (!state.records.length) return;
  syncCustomerTrigger();
  $("showZeroChip").classList.toggle("active", $("showZero").checked);
  $("showZeroChip").setAttribute("aria-checked", String($("showZero").checked));
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
  const stats = renderAnalysis();
  renderFilterFeedback(stats);
  renderTable();
  updateActionStates();
  flashLiveUpdate();
}

function updateActionStates() {
  const filterCount = activeFilterLabels().length;
  const hasResults = state.filtered.length > 0;
  $("clearBtn").disabled = filterCount === 0;
  $("copyBtn").disabled = !hasResults;
  $("exportBtn").disabled = !hasResults;
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
  $("pRange").textContent = stats.p25 == null ? "—" : `${formatMoney(stats.p25)}–${formatMoney(stats.p75)}`;
  $("pLatest").textContent = formatMoney(stats.latest);
  const hasComparableScope = Boolean($("customer").value || $("pn").value.trim() || $("process").value.trim());
  $("pLatestWrap").classList.toggle("stat-muted", !hasComparableScope);
  $("pLatestLabel").textContent = hasComparableScope ? "Latest" : "Latest line";
  $("pLatestWrap").title = hasComparableScope
    ? "Most recent priced line in the current scope."
    : "Most recent single priced line across the whole file — define a customer, P/N, or process to make this comparable.";
  $("pRecency").textContent = formatDate(stats.latestDate);
  $("pPriced").textContent = whole.format(stats.priced);
  $("pricingSummary").textContent = stats.priced
    ? `Median ${formatMoney(stats.median)} · ${whole.format(stats.priced)} priced lines`
    : "No priced lines in this scope";
  renderRecommendation(stats);
  renderChart();
  return stats;
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
  $("confidenceBadge").title = hasComparableScope
    ? "Confidence reflects sample size and how recently matching work was received."
    : "Unfiltered — all customers and parts.";
  $("recommendationRange").textContent = stats.p25 == null ? "—" : `${formatMoney(stats.p25)} – ${formatMoney(stats.p75)}`;
  if (!stats.priced) {
    $("recommendationCopy").textContent = "No positive-priced lines match the current filters.";
  } else if (!hasComparableScope) {
    $("recommendationCopy").textContent = `Portfolio-wide baseline from ${whole.format(stats.priced)} priced lines. Define a customer, P/N, or process above before using the range to support a quote.`;
  } else {
    $("recommendationCopy").textContent = `Observed range from ${whole.format(stats.priced)} priced line${stats.priced === 1 ? "" : "s"}${active.length ? ` matching ${active.join(", ")}` : ""}. Use the median as the center and review the source work before quoting.`;
  }
}

function renderFilterFeedback(stats) {
  const filters = activeFilters();
  $("filterMatchCount").textContent = `${whole.format(stats.matches)} line${stats.matches === 1 ? "" : "s"} match`;
  $("filterChips").replaceChildren(...filters.map((filter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.dataset.filterKey = filter.key;
    button.setAttribute("aria-label", `Remove ${filter.label} filter`);
    const text = document.createElement("span");
    text.textContent = `${filter.label}: ${filter.value}`;
    const remove = document.createElement("span");
    remove.className = "chip-remove";
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    button.append(text, remove);
    return button;
  }));

  const customer = $("customer").value || "All customers";
  const pn = $("pn").value.trim() ? `P/N ${$("pn").value.trim()}` : "No P/N";
  const spec = $("process").value.trim() ? `Spec ${$("process").value.trim()}` : "No spec";
  const search = $("q").value.trim();
  $("scopeSummary").textContent = [search ? `Search “${search}”` : "", customer, pn, spec].filter(Boolean).join(" · ");
  $("scopeCount").textContent = `${whole.format(stats.matches)} matching · ${whole.format(stats.priced)} priced`;

  const contextParts = [];
  if (search) contextParts.push(`“${search}”`);
  if ($("customer").value) contextParts.push($("customer").value);
  if ($("pn").value.trim()) contextParts.push($("pn").value.trim());
  if ($("process").value.trim()) contextParts.push($("process").value.trim());
  $("contextScope").textContent = contextParts.join(" · ") || "All line items";
  $("contextMedian").textContent = formatMoney(stats.median);
  $("contextCount").textContent = `${whole.format(stats.matches)} line${stats.matches === 1 ? "" : "s"}`;
  $("quickSpecs").querySelectorAll("[data-quick-spec]").forEach((button) => {
    button.classList.toggle("active", button.dataset.quickSpec.toLowerCase() === $("process").value.trim().toLowerCase());
  });
}

function activeFilters() {
  const filters = [];
  if ($("q").value.trim()) filters.push({ key: "q", label: "Search", value: $("q").value.trim() });
  if ($("customer").value) filters.push({ key: "customer", label: "Customer", value: $("customer").value });
  if ($("pn").value.trim()) filters.push({ key: "pn", label: "P/N", value: $("pn").value.trim() });
  if ($("process").value.trim()) filters.push({ key: "process", label: "Spec", value: $("process").value.trim() });
  if ($("dateFrom").value) filters.push({ key: "dateFrom", label: "From", value: $("dateFrom").value });
  if ($("dateTo").value) filters.push({ key: "dateTo", label: "To", value: $("dateTo").value });
  if (!$("showZero").checked) filters.push({ key: "showZero", label: "Prices", value: "Priced lines only" });
  return filters;
}

function removeFilterChip(event) {
  const chip = event.target.closest("[data-filter-key]");
  if (!chip) return;
  const key = chip.dataset.filterKey;
  if (key === "showZero") $("showZero").checked = true;
  else if ($(key)) $(key).value = "";
  applyFilters();
}

function applyQuickSpec(event) {
  const button = event.target.closest("[data-quick-spec]");
  if (!button) return;
  const active = $("process").value.trim().toLowerCase() === button.dataset.quickSpec.toLowerCase();
  $("process").value = active ? "" : button.dataset.quickSpec;
  applyFilters();
}

function flashLiveUpdate() {
  [$("decisionPanel"), $("filterMatchCount"), $("contextBar")].forEach((element) => {
    element.classList.remove("just-updated");
    void element.offsetWidth;
    element.classList.add("just-updated");
  });
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
  const height = 160;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
  const pad = { left: 54, right: 14, top: 10, bottom: 28 };
  const x = (date) => pad.left + ((new Date(`${date}T12:00:00`).getTime() - start) / Math.max(1, end - start)) * (width - pad.left - pad.right);
  const y = (price) => pad.top + (1 - Math.min(price, cap) / Math.max(1, cap)) * (height - pad.top - pad.bottom);
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const lineColor = styles.getPropertyValue("--line").trim();
  const mutedColor = styles.getPropertyValue("--muted").trim();
  const infoColor = styles.getPropertyValue("--info").trim();
  const goldColor = styles.getPropertyValue("--gold").trim();
  ctx.strokeStyle = lineColor; ctx.fillStyle = mutedColor; ctx.font = "12px system-ui";
  for (let i = 0; i <= 3; i += 1) {
    const py = pad.top + i * (height - pad.top - pad.bottom) / 3;
    ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(width - pad.right, py); ctx.stroke();
    ctx.fillText(formatCompactMoney(cap * (1 - i / 3)), 4, py + 4);
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
  ctx.fillStyle = mutedColor; ctx.fillText(formatDate(sampled[0].date), pad.left, height - 10);
  const endLabel = formatDate(sampled.at(-1).date); const endWidth = ctx.measureText(endLabel).width;
  ctx.fillText(endLabel, width - pad.right - endWidth, height - 10);
  $("chartNote").textContent = prices.at(-1) > cap ? `Scale capped at 95th percentile (${formatMoney(cap)})` : "Median shown in gold";
  $("chartDescription").textContent = `${whole.format(points.length)} priced records from ${formatDate(sampled[0].date)} through ${formatDate(sampled.at(-1).date)}; median ${formatMoney(stats.median)}.`;
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
  const mostRecentSort = state.sort.field === "date" && state.sort.direction === -1;
  $("resultCount").textContent = state.filtered.length > PAGE_SIZE
    ? `Showing ${whole.format(PAGE_SIZE)} ${mostRecentSort ? "most recent " : ""}source lines of ${whole.format(state.filtered.length)} — filter to narrow`
    : `${whole.format(state.filtered.length)} complete source line${state.filtered.length === 1 ? "" : "s"}`;
  if (!showing.length) {
    const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = columns.length; td.className = "empty-cell"; td.textContent = "No line items match these filters."; tr.append(td); $("tableBody").replaceChildren(tr); renderRecordPane(null); return;
  }
  const selected = showing.find((record) => record.sourceRow === state.selectedRow) || showing[0];
  state.selectedRow = selected.sourceRow;
  $("tableBody").replaceChildren(...showing.map((record) => {
    const tr = document.createElement("tr");
    tr.className = "reference-row";
    tr.tabIndex = 0;
    tr.dataset.sourceRow = String(record.sourceRow);
    tr.setAttribute("aria-selected", String(record.sourceRow === state.selectedRow));
    if (record.sourceRow === state.selectedRow) tr.classList.add("selected");
    columns.forEach(([field]) => {
      const td = document.createElement("td");
      let value = record[field];
      if (field === "price") { td.className = "number"; value = formatMoney(value); }
      if (field === "date") value = formatDate(value);
      if (field === "router") {
        td.className = "source-text";
        const chips = renderRouterChips(value, true);
        if (chips) { chips.title = value; td.append(chips); }
        else td.textContent = "—";
      } else if (["description", "process", "special"].includes(field)) {
        td.className = "source-text";
        const preview = document.createElement("span");
        preview.className = "cell-preview";
        preview.textContent = value || "—";
        td.append(preview);
      } else {
        td.textContent = value || "—";
      }
      tr.append(td);
    });
    const select = () => selectRecord(record, tr);
    tr.addEventListener("click", select);
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
    return tr;
  }));
  renderRecordPane(selected);
}

function selectRecord(record, row) {
  state.selectedRow = record.sourceRow;
  $("tableBody").querySelectorAll(".reference-row").forEach((candidate) => {
    const selected = candidate === row;
    candidate.classList.toggle("selected", selected);
    candidate.setAttribute("aria-selected", String(selected));
  });
  renderRecordPane(record);
}

function renderRecordPane(record) {
  if (!record) {
    $("recordPaneTitle").textContent = "No matching line item";
    $("recordPaneMeta").textContent = "";
    $("recordPaneFields").replaceChildren();
    return;
  }
  $("recordPaneTitle").textContent = `${record.customer || "Unknown customer"} · WO ${record.wo || "—"}`;
  $("recordPaneMeta").textContent = `Source row ${whole.format(record.sourceRow)}`;
  const fields = [
    ["Received", formatDate(record.date)],
    ["WO", record.wo],
    ["Customer", record.customer],
    ["Part ID", record.part],
    ["Line Description", record.description],
    ["Unit Price", formatMoney(record.price)],
    ["Process", record.process],
    ["Router Forms", record.router],
    ["Special Instructions", record.special],
    ["End User", record.endUser],
  ];
  const lookup = renderRecordLookup(record);
  const sections = fields.map(([label, value]) => {
    const section = document.createElement("section");
    section.className = "record-field";
    const heading = document.createElement("strong"); heading.textContent = label;
    section.append(heading);
    const chips = label === "Router Forms" ? renderRouterChips(value, false) : null;
    if (chips) {
      chips.title = value;
      section.append(chips);
    } else {
      const content = document.createElement("p"); content.textContent = value || "—";
      section.append(content);
    }
    return section;
  });
  $("recordPaneFields").replaceChildren(...(lookup ? [lookup, ...sections] : sections));
}

function vivaGroup(key) {
  return VIVA_GROUPS.find((group) => group.key === key) || VIVA_GROUPS[0];
}

function vivaLastDept() {
  let saved = null;
  try { saved = localStorage.getItem(VIVA_DEPT_KEY); } catch { /* Shared preference is optional. */ }
  return vivaGroup(saved || "all").key;
}

function vivaUrl(deptKey, pn, wo, exact) {
  const terms = [pn, wo].map((term) => (term || "").trim()).filter(Boolean).map((term) => exact ? `"${term}"` : term);
  if (!terms.length) return null;
  let url = `${VIVA_SEARCH_BASE}?search=${encodeURIComponent(terms.join(" "))}&type=threads`;
  const group = vivaGroup(deptKey);
  if (group.groupId) url += `&groupScope=${encodeURIComponent(btoa(JSON.stringify({ _type: "Group", id: group.groupId })))}`;
  return url;
}

function vivaLookup(pn, wo) {
  const deptKey = state.vivaDept ?? vivaLastDept();
  const exact = state.vivaExact !== false;
  const url = vivaUrl(deptKey, pn, wo, exact);
  if (!url) return;
  try {
    localStorage.setItem(VIVA_DEPT_KEY, deptKey);
    const stored = JSON.parse(localStorage.getItem(VIVA_RECENT_KEY) || "[]");
    const recent = (Array.isArray(stored) ? stored : [])
      .filter((entry) => !(entry.pn === (pn || "") && entry.wo === (wo || "") && entry.dept === deptKey));
    recent.unshift({ pn: pn || "", wo: wo || "", dept: deptKey, exact });
    localStorage.setItem(VIVA_RECENT_KEY, JSON.stringify(recent.slice(0, 10)));
  } catch { /* Shared recents are optional. */ }
  window.open(url, "_blank", "noopener");
}

function renderRecordLookup(record) {
  const targets = record.partNumbers.map((pn) => ({ label: pn, pn, wo: "" }));
  const woTerm = record.wo ? (record.wo.match(/\d+/)?.[0] || record.wo) : "";
  if (woTerm) targets.push({ label: `WO ${woTerm}`, pn: "", wo: woTerm });
  if (!targets.length) return null;
  const section = document.createElement("section");
  section.className = "record-field record-lookup";
  const head = document.createElement("div");
  head.className = "record-lookup-head";
  const heading = document.createElement("strong");
  heading.textContent = "Look up in Viva Engage";
  const exactChip = document.createElement("button");
  exactChip.type = "button";
  exactChip.className = "toggle-chip";
  exactChip.title = "On: exact phrase. Off: looser match for spacing or format variants.";
  exactChip.setAttribute("role", "switch");
  const exactText = document.createElement("span");
  exactText.textContent = "Exact";
  exactChip.append(exactText);
  const syncExact = () => {
    exactChip.classList.toggle("active", state.vivaExact);
    exactChip.setAttribute("aria-checked", String(state.vivaExact));
  };
  exactChip.addEventListener("click", () => { state.vivaExact = !state.vivaExact; syncExact(); });
  syncExact();
  head.append(heading, exactChip);
  const groups = document.createElement("div");
  groups.className = "lookup-groups";
  groups.setAttribute("role", "radiogroup");
  groups.setAttribute("aria-label", "Viva Engage group scope");
  const currentDept = state.vivaDept ?? vivaLastDept();
  state.vivaDept = currentDept;
  VIVA_GROUPS.forEach((group) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "group-chip";
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", String(group.key === currentDept));
    chip.classList.toggle("active", group.key === currentDept);
    chip.title = group.label;
    chip.textContent = group.short;
    chip.addEventListener("click", () => {
      state.vivaDept = group.key;
      try { localStorage.setItem(VIVA_DEPT_KEY, group.key); } catch { /* Shared preference is optional. */ }
      groups.querySelectorAll(".group-chip").forEach((candidate) => {
        const selected = candidate === chip;
        candidate.classList.toggle("active", selected);
        candidate.setAttribute("aria-checked", String(selected));
      });
    });
    groups.append(chip);
  });
  const chips = document.createElement("div");
  chips.className = "lookup-chips";
  targets.forEach((target) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lookup-chip";
    chip.title = `Searches Viva Engage for: ${target.pn || target.wo}`;
    chip.setAttribute("aria-label", `Search Viva Engage for ${target.pn || target.wo}`);
    const text = document.createElement("span");
    text.textContent = target.label;
    const badge = document.createElement("span");
    badge.className = "chip-go";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = "↗";
    chip.append(text, badge);
    chip.addEventListener("click", () => vivaLookup(target.pn, target.wo));
    chips.append(chip);
  });
  section.append(head, groups, chips);
  return section;
}

function initSelectionLookup() {
  const popup = document.createElement("button");
  popup.type = "button";
  popup.className = "lookup-chip selection-lookup";
  popup.title = "Search Viva Engage for the selected text";
  popup.hidden = true;
  const text = document.createElement("span");
  const badge = document.createElement("span");
  badge.className = "chip-go";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = "↗";
  popup.append(text, badge);
  document.body.append(popup);
  const hide = () => { popup.hidden = true; };
  popup.addEventListener("mousedown", (event) => event.preventDefault());
  popup.addEventListener("click", () => {
    if (popup.dataset.term) vivaLookup(popup.dataset.term, "");
    window.getSelection()?.removeAllRanges();
    hide();
  });
  document.addEventListener("selectionchange", debounce(() => {
    const selection = window.getSelection();
    const term = selection?.toString().replace(/\s+/g, " ").trim() || "";
    const inPane = selection?.rangeCount && $("recordPaneFields").contains(selection.anchorNode);
    if (!term || !inPane || term.length > 80) return hide();
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    popup.dataset.term = term;
    text.textContent = term.length > 30 ? `${term.slice(0, 30)}…` : term;
    popup.hidden = false;
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, rect.left + rect.width / 2 - popup.offsetWidth / 2))}px`;
    popup.style.top = `${Math.max(8, rect.top - popup.offsetHeight - 8)}px`;
  }, 120));
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}

function renderRouterChips(value, compact) {
  const segments = parseRouterSteps(value);
  if (!segments.length) return null;
  const wrap = document.createElement("div");
  wrap.className = compact ? "router-steps compact" : "router-steps";
  segments.forEach((segment) => {
    if (segment.woId && !compact) {
      const label = document.createElement("span");
      label.className = "router-woid";
      label.textContent = `WoID ${segment.woId}`;
      wrap.append(label);
    }
    segment.steps.forEach((step, index) => {
      if (index > 0) {
        const arrow = document.createElement("span");
        arrow.className = "router-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "›";
        wrap.append(arrow);
      }
      const chip = document.createElement("span");
      chip.className = "router-chip";
      if (step.seq) {
        const seq = document.createElement("small");
        seq.textContent = step.seq;
        chip.append(seq);
      }
      chip.append(document.createTextNode(step.form));
      wrap.append(chip);
    });
  });
  return wrap;
}

function clearFilters() {
  ["q", "pn", "process", "dateFrom", "dateTo"].forEach((id) => { $(id).value = ""; });
  $("customer").value = ""; $("showZero").checked = true; applyFilters();
}

async function copyStat(event) {
  const target = $(event.currentTarget.dataset.copyStat);
  const label = event.currentTarget.getAttribute("aria-label").replace(/^Copy /, "");
  try {
    await navigator.clipboard.writeText(target.textContent);
    showToast(`${label[0].toUpperCase()}${label.slice(1)} copied.`, "success");
  } catch {
    showToast("Clipboard access was unavailable.", "error");
  }
}

async function copySummary() {
  const stats = calculateStats(state.filtered);
  const text = [
    "QPC Part Memory — pricing reference",
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
  const header = ["RECEIVED", "WO", "CUSTOMER", "PART ID", "LINE DESCRIPTION", "UNIT PRICE", "PROCESS", "ROUTER FORMS", "SPECIAL INSTRUCTIONS", "END USER"];
  const rows = state.filtered.map((record) => [record.date, record.wo, record.customer, record.part, record.description, record.price ?? "", record.process, record.router, record.special, record.endUser]);
  const csv = [header, ...rows].map((row) => row.map((cell, index) => csvCell(cell, index === 5)).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `qpc_part_memory_${new Date().toISOString().slice(0, 10)}.csv`; link.click();
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
  return activeFilters().map((filter) => `${filter.label.toLowerCase()} ${filter.value}`);
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

import { normalizeText } from "../../core.js";
import { partNumberMatch, revisionNear, scopeFlags } from "./part-history.js";

// Normalizes Outlook messages already retrieved by an authorized connector.
// Nothing here searches or sends mail. The rules below separate the newest
// authored text from quoted history, because a subject line or a quoted older
// estimate can carry the wrong scope (a real revised estimate kept an
// "oxygen service" subject while its authored text removed oxygen service).

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'" };

export function htmlToText(html) {
  return normalizeText(String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr[^>]*>/gi, "\n________________________________\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/g, (entity) => ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t ]+/g, " "));
}

const QUOTE_MARKERS = [
  /^\s*-{2,}\s*Original Message\s*-{2,}/i,
  /^\s*_{8,}\s*$/,
  /^\s*\*\s*\*\s*\*\s*$/,
  /^\s*On .{5,200} wrote:\s*$/i,
];

export function splitLatestAuthored(text) {
  const lines = normalizeText(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fromHeader = /^\s*\**From:\**\s*\S/i.test(line)
      && lines.slice(index + 1, index + 6).some((next) => /^\s*\**(?:Sent|Date):\**\s*\S/i.test(next));
    if (fromHeader || QUOTE_MARKERS.some((pattern) => pattern.test(line))) {
      return { latest: lines.slice(0, index).join("\n").trim(), quoted: lines.slice(index).join("\n").trim() };
    }
  }
  return { latest: lines.join("\n").trim(), quoted: "" };
}

const money = (value) => Number(String(value).replace(/,/g, ""));
const MONEY = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;

// Price rows that name the part in the newest authored text. Table rows
// ("ABC-100 | 500 | $7.50") yield a quantity; sentences do not, because a
// number in prose (a spec or AMS number) is not safely a quantity.
export function extractPriceRows(text, partNumber, aliases = []) {
  const rows = [];
  for (const rawLine of normalizeText(text).split("\n")) {
    const line = normalizeText(rawLine);
    const found = partNumberMatch(line, partNumber, aliases);
    if (!found || found.kind === "partial-token") continue;
    const prices = [...line.matchAll(MONEY)].map((match) => money(match[1]));
    if (!prices.length) continue;
    const tableRow = line.includes("|") || /^\W*\S+\s+[\d,]+\s+\$/.test(line.trim());
    let quantity = null;
    if (tableRow) {
      const after = line.slice(found.index + found.matched.length).replace(MONEY, " ");
      const qty = after.match(/(?:^|[\s|])(\d[\d,]*)(?=\s*(?:\||$|\s))/);
      if (qty) quantity = money(qty[1]);
    }
    rows.push({ unitPrice: prices[0], quantity, style: tableRow ? "table-row" : "sentence", matchKind: found.kind, line: line.trim() });
  }
  return rows;
}

export function extractTerms(text) {
  const source = normalizeText(text);
  const terms = {};
  let match = source.match(/Lot Minimum Charge:?\**\s*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (match) terms.lotMinimum = money(match[1]);
  match = source.match(/valid for\s+(\d+)\s+days/i);
  if (match) terms.validityDays = Number(match[1]);
  match = source.match(/Standard Lead Time:?\**\s*([^\n]+)/i);
  if (match) terms.standardLeadTime = match[1].trim();
  const expedite = [...source.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)\s*[–—-]\s*(\d+\s*-\s*\d+|\d+)\s*business days/gi)]
    .map((item) => ({ fee: money(item[1]), businessDays: item[2].replace(/\s+/g, "") }));
  if (expedite.length) terms.expediteOptions = expedite;
  match = source.match(/\$\s*([\d.]+)\s*each\s+plus\s+\$\s*([\d.]+)\s*per\s+inch\s+after\s+the\s+first\s+inch/i);
  if (match) terms.sizeRule = { base: money(match[1]), perInch: money(match[2]), includedInches: 1, text: match[0] };
  if (/\bstill valid\b/i.test(source)) terms.affirmsValidity = true;
  return terms;
}

// Customer purchase-order PDF text as returned by the Microsoft 365 connector. The
// extracted text is out of reading order, so every figure is cross-checked:
// quantity must equal extended / unit and appear in the text, and the total
// must equal extended plus any expedite fee.
export function parsePurchaseOrder(text, partNumber, aliases = []) {
  const source = normalizeText(text).replace(/\s+/g, " ").replace(/(\d)\s+\.\s+(\d{2})\b/g, "$1.$2");
  const po = { poNumber: null, revision: null, date: null, needBy: null, unitPrice: null, extended: null, uom: null, quantity: null, expediteFee: null, total: null, pricingReference: null, approvedBy: null, customerWorkOrder: null, checks: {} };
  let match = source.match(/^\s*(PO\d-\s?\d+)(?:\s+Rev\.\s*(\d+))?/i);
  if (match) {
    po.poNumber = match[1].replace(/\s+/g, "");
    po.revision = match[2] ? Number(match[2]) : 0;
  }
  match = source.match(/\bDATE\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (match) po.date = usDateToIso(match[1]);
  match = source.match(/Net\s*\d+\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (match) po.needBy = usDateToIso(match[1]);
  match = source.match(/\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})/);
  if (match) {
    po.unitPrice = money(match[1]);
    po.extended = money(match[2]);
    const uom = source.slice(match.index + match[0].length, match.index + match[0].length + 40).match(/^\s+(?:[A-Z]{1,4}\d+\s+)?(EA|EACH|LOT|HR|FT|IN|SET|PC|PCS)\b/i);
    po.uom = uom ? uom[1].toUpperCase().replace(/^EACH$|^PCS?$/, "EA") : null;
  }
  if (po.unitPrice && po.extended) {
    const quantity = Math.round(po.extended / po.unitPrice);
    const exact = Math.abs(quantity * po.unitPrice - po.extended) < 0.005;
    const present = new RegExp(`(?<![\\d,.])${quantity}(?![\\d,.])`).test(source);
    po.quantity = exact && present ? quantity : null;
    po.checks.quantityTimesUnitEqualsExtended = exact;
    po.checks.quantityPresentInText = present;
  }
  match = source.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*Expedite Fee/i);
  if (match) po.expediteFee = money(match[1]);
  const amounts = [...source.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map((item) => money(item[1]));
  if (amounts.length) po.total = Math.max(...amounts);
  if (po.extended != null && po.total != null) {
    po.checks.totalEqualsExtendedPlusExpedite = Math.abs(po.total - (po.extended + (po.expediteFee || 0))) < 0.005;
  }
  const references = [...source.matchAll(/Pricing dtd\s+(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{4})(?:\s+provided by\s+([A-Z][a-z]+))?/gi)];
  if (references.length) {
    const best = references.find((item) => item[2]) || references[0];
    po.pricingReference = { date: usDateToIso(best[1].replace(/\s+/g, "")), providedBy: best[2] || null };
  }
  match = source.match(/Approved By\s+([A-Z][A-Za-z.' -]+?)\s*,/);
  if (match) po.approvedBy = match[1].trim();
  match = source.match(/WO Number\s*:\s*(W\d)\s*-\s*(\d+)/i);
  if (match) po.customerWorkOrder = `${match[1].toUpperCase()}-${match[2]}`;
  const partMatch = partNumberMatch(source, partNumber, aliases);
  po.partMatch = partMatch ? partMatch.kind : null;
  po.revisionOfPart = partMatch ? revisionNear(source, partNumber, aliases) : null;
  po.scope = scopeFlags(source);
  return po;
}

function usDateToIso(text) {
  const [month, day, year] = text.split("/").map(Number);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function domainOf(address) {
  return String(address || "").toLowerCase().split("@")[1] || "";
}

// Evidence types, kept distinct because each proves something different:
// customer-rfq / customer-followup / customer-po / customer-confirmation (inbound),
// qpc-sent-estimate / qpc-validity-confirmation / qpc-acknowledgment (outbound),
// internal, other. A QPC sender is only customer-facing when a customer
// address is among the recipients.
export function classifyMessage(message, context) {
  const { partNumber, aliases = [], customerDomains, internalDomains } = context;
  const text = message.bodyFormat === "html" ? htmlToText(message.body) : normalizeText(message.body);
  const { latest, quoted } = splitLatestAuthored(text);
  const senderDomain = domainOf(message.from);
  const recipients = [...(message.to || []), ...(message.cc || [])];
  const customerRecipients = recipients.filter((address) => customerDomains.includes(domainOf(address)));
  const fromCustomer = customerDomains.includes(senderDomain);
  const fromQpc = internalDomains.includes(senderDomain);

  const prices = extractPriceRows(latest, partNumber, aliases);
  const terms = extractTerms(latest);
  const scopeLatest = scopeFlags(latest);
  const scopeSubject = scopeFlags(message.subject || "");
  const subjectScopeConflict = Boolean(scopeLatest.oxygen && scopeSubject.oxygen && scopeLatest.oxygen !== scopeSubject.oxygen);
  const purchaseOrders = (message.attachments || [])
    .filter((attachment) => attachment.text && /purchase order|^PO\d/i.test(`${attachment.name} ${attachment.text.slice(0, 80)}`))
    .map((attachment) => ({ attachment: attachment.name, ...parsePurchaseOrder(attachment.text, partNumber, aliases) }));

  const mentions = {
    subject: partNumberMatch(message.subject || "", partNumber, aliases)?.kind || null,
    latest: partNumberMatch(latest, partNumber, aliases)?.kind || null,
    quoted: partNumberMatch(quoted, partNumber, aliases)?.kind || null,
    attachments: (message.attachments || []).map((attachment) => partNumberMatch(`${attachment.name}\n${attachment.text || ""}`, partNumber, aliases)?.kind || null).find(Boolean) || null,
  };

  const drawingAttached = (message.attachments || []).some((attachment) => attachment.text && /\bDWG\.?\s*NO\b|THIRD ANGLE PROJECTION|\(TABULATED\)/i.test(attachment.text));

  let type = "other";
  let reason = "";
  if (fromCustomer && purchaseOrders.some((po) => po.partMatch && po.partMatch !== "partial-token")) {
    type = "customer-po";
    reason = "customer sender; attached purchase order names the part";
  } else if (fromCustomer && drawingAttached) {
    type = "customer-drawing";
    reason = "customer sender; attachment is a drawing";
  } else if (fromCustomer && /\bfollow(?:ing)?[\s-]*up\b/i.test(latest)) {
    type = "customer-followup";
    reason = "customer sender follows up in the newest authored text";
  } else if (fromCustomer && /\b(?:provide|advise|send|confirm)\b[^.\n]{0,40}\b(?:pricing|quote|price)\b|\bquote for\b|\bRFQ\b/i.test(latest)) {
    type = "customer-rfq";
    reason = "customer sender asks for pricing or price confirmation in the newest authored text";
  } else if (fromCustomer && /\b(?:need|needs|require[sd]?|must)\b[^.\n]{0,40}\b(?:aclar|packag\w*|oxygen|spec\w*|level|clean\w*)\b/i.test(latest)) {
    type = "customer-requirement";
    reason = "customer sender states a scope or packaging requirement";
  } else if (fromCustomer && /\b(?:on hold|under review|cancel(?:led|ed)?)\b/i.test(latest)) {
    type = "customer-order-status";
    reason = "customer sender reports an order hold, review or cancellation";
  } else if (fromCustomer && (message.attachments || []).some((attachment) => !attachment.text && !attachment.inline && /\bPO\b|purchase order/i.test(`${attachment.name} ${latest}`))) {
    type = "customer-po-unread";
    reason = "customer sender attached a PO revision that was not opened";
  } else if (fromCustomer && /\b(?:confirm(?:ing)?|clarif(?:y|ying)|thank you for)\b/i.test(latest)) {
    type = "customer-confirmation";
    reason = "customer sender confirms or thanks; not a new request";
  } else if (fromQpc && customerRecipients.length && (prices.length || (terms.sizeRule && mentions.latest && mentions.latest !== "partial-token"))) {
    type = "qpc-sent-estimate";
    reason = `QPC sender, customer recipients (${customerRecipients.join(", ")}), price for the part in the newest authored text`;
  } else if (fromQpc && customerRecipients.length && terms.affirmsValidity) {
    type = "qpc-validity-confirmation";
    reason = "QPC sender tells the customer earlier pricing is still valid; the price itself is not restated";
  } else if (fromQpc && customerRecipients.length && /\b(?:received your request|assigned it|confirmation will be provided|were received|adding team)\b/i.test(latest)) {
    type = "qpc-acknowledgment";
    reason = "QPC acknowledgment; not a substantive answer";
  } else if (fromQpc && customerRecipients.length) {
    type = "qpc-reply";
    reason = "QPC reply to the customer without a price for this part";
  } else if (fromQpc && !customerRecipients.length) {
    type = "internal";
    reason = "no customer recipient";
  }

  return {
    id: message.id,
    mailbox: message.mailbox,
    subject: message.subject,
    from: message.from,
    receivedAt: message.receivedAt,
    webLink: message.webLink,
    customerRecipients,
    type,
    typeReason: reason,
    mentions,
    latest,
    quotedPresent: Boolean(quoted),
    prices,
    terms,
    scopeLatest,
    scopeSubject,
    subjectScopeConflict,
    revisionLatest: revisionNear(latest, partNumber, aliases),
    purchaseOrders,
    attachmentsNotRead: (message.attachments || []).filter((attachment) => !attachment.text && !attachment.inline).map((attachment) => attachment.name),
  };
}

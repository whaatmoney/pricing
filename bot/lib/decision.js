import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyMessage } from "./email-evidence.js";
import { compareScope, matchLineHistory, partNumberMatch, summarizeMatches } from "./part-history.js";
import { recommend } from "./recommend.js";
import { RULINGS } from "./rulings.js";
import { loadSnapshotRecords, snapshotStatus } from "./router-snapshot.js";
import { readSalesExport } from "./sales-export.js";
import { calculatorPrice, loadCalculator } from "./methods/online-calculator.js";
import { loadPriceLabRules } from "./methods/price-lab-rules.js";
import { lotMinimumCheck, sq2NonTube, sq3Throughput, sq4Band, sq5Stabilize } from "./methods/pricegpt-master-v2.js";

// Builds one decision record per RFQ from saved evidence and the current
// Router History snapshot. It reads only; it never sends, approves or writes
// to any live system. Output is a recommendation for human review.

export const DECISION_SCHEMA = "qpc-rfq-decision/0.1";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const blocked = (result) => Boolean(result?.blocked?.length);

// The code that shapes the decision record. A change here produces a new
// recommendation version, so a reviewed version is never silently rewritten.
const ENGINE_FILES = ["decision.js", "email-evidence.js", "part-history.js", "recommend.js", "rulings.js", "router-snapshot.js", "sales-export.js", "xlsx.js", "methods/online-calculator.js", "methods/price-lab-rules.js", "methods/pricegpt-master-v2.js", "../../core.js"];

export function engineFingerprint() {
  const hash = crypto.createHash("sha256");
  for (const file of ENGINE_FILES) hash.update(fs.readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}

export function loadMessages(messagesPath) {
  const data = readJson(messagesPath);
  const searchQueries = data.searchQueries || [];
  const messages = data.messages.map((message) => ({ ...message, searchQueries, source: path.basename(messagesPath) }));
  for (const external of data.external || []) {
    const file = path.resolve(path.dirname(messagesPath), external.path);
    for (const item of readJson(file).messages || []) {
      if (messages.some((message) => message.id === item.id)) continue;
      messages.push({
        id: item.id,
        mailbox: external.mailbox,
        subject: item.subject,
        from: item.sender?.emailAddress?.address,
        to: (item.toRecipients || []).map((recipient) => recipient.emailAddress.address),
        cc: (item.ccRecipients || []).map((recipient) => recipient.emailAddress.address),
        receivedAt: item.receivedDateTime,
        webLink: item.web_link,
        // Codex saved a text rendering of these bodies although contentType says html.
        bodyFormat: "text",
        bodyScope: "full",
        body: item.body?.content || "",
        attachments: [],
        searchQueries,
        source: path.basename(file),
      });
    }
  }
  return messages;
}

// The customer's own job number in either form the Router History export uses:
// "WO NO: W1-100" or "JOB NO: 1234-1". It lives here, inside the engine
// fingerprint, because the job cross-check depends on it.
const JOB_NO = /\bJOB\s*(?:NO|NUMBER|#)\.?\s*:?\s*([A-Z0-9]+(?:\s*-\s*[A-Z0-9]+)*)/i;

export function customerWorkOrder(text) {
  const match = String(text || "").match(/\bWO\s*(?:NO|NUMBER)\.?\s*:?\s*(W\d)\s*-\s*(\d+)/i);
  if (match) return `${match[1].toUpperCase()}-${match[2]}`;
  const job = String(text || "").match(JOB_NO);
  return job ? job[1].replace(/\s+/g, "").toUpperCase() : null;
}

function withinQuantity(quantity, requested) {
  return quantity != null && Math.abs(quantity - requested) / requested <= 0.25;
}

// comparable: same customer, part, revision and scope, all stated.
// unverified: nothing contradicts the request, but a scope fact is not stated.
// different: a stated fact differs. excluded: returned, credit, zero or blank price.
function historyEntry(base) {
  const entry = { unitPrice: null, quantity: null, differences: [], unknown: [], notes: [], ...base };
  if (entry.category && entry.category !== "ordinary") entry.status = "excluded";
  else if (entry.differences.length) entry.status = "different";
  else if (entry.unknown.length) entry.status = "unverified";
  else entry.status = "comparable";
  entry.comparable = entry.status === "comparable";
  return entry;
}

function quantityDifference(quantity, line) {
  return quantity != null && !withinQuantity(quantity, line.quantity) ? [`quantity ${quantity} vs ${line.quantity}`] : [];
}

function oxygenDifference(stated, line) {
  return stated && line.scope.oxygen && stated !== line.scope.oxygen ? [`oxygen service: ${stated} vs requested ${line.scope.oxygen}`] : [];
}

function sizeRuleNote(sizeRule, line) {
  const size = line.sq1?.envelope ? Math.max(line.sq1.envelope.length, line.sq1.envelope.width, line.sq1.envelope.height) : null;
  if (!sizeRule || size == null) return null;
  const extraInches = Math.max(0, size - sizeRule.includedInches);
  const value = extraInches === 0 ? `$${sizeRule.base.toFixed(2)}` : `$${sizeRule.base.toFixed(2)} + $${sizeRule.perInch.toFixed(2)}/in beyond ${sizeRule.includedInches} in (partial-inch treatment not stated)`;
  return `Size rule "${sizeRule.text}" → ${value} at this part's ${size} in largest dimension`;
}

function buildTimeline(line, { dbMatches, invoiceMatches, emails, purchaseOrders }) {
  const entries = [];
  for (const po of purchaseOrders) {
    entries.push(historyEntry({
      date: po.date,
      source: "Customer PO",
      evidence: `${po.poNumber}${po.revision ? ` Rev. ${po.revision}` : ""}`,
      unitPrice: po.unitPrice,
      quantity: po.quantity,
      charges: po.expediteFee ? [`$${po.expediteFee.toLocaleString("en-US")} expedite`] : [],
      scope: `${po.scope.level || "level ?"}; oxygen ${po.scope.oxygen || "not stated"}`,
      proves: "Price the customer issued on its own purchase order",
      differences: [...po.differences, ...quantityDifference(po.quantity, line)],
      unknown: po.unknown,
      notes: po.expediteFee ? [`$${po.expediteFee.toLocaleString("en-US")} expedite fee on the PO`] : [],
      link: po.webLink,
      checks: po.checks,
      customerWorkOrder: po.customerWorkOrder,
      pricingReference: po.pricingReference,
    }));
  }
  for (const email of emails) {
    if (email.type === "qpc-sent-estimate") {
      for (const price of email.prices) {
        const unknown = [];
        if (!email.scopeLatest.oxygen) unknown.push("oxygen service not stated in the authored text");
        if (!email.scopeLatest.level) unknown.push("cleanliness level not stated in the authored text");
        if (price.quantity == null) unknown.push("quantity not stated with the price");
        const notes = [];
        const rule = sizeRuleNote(email.terms.sizeRule, line);
        if (rule) notes.push(rule);
        if (price.style === "linked-by-case") notes.push(`The quote names no part number; the case ties it to this part: ${price.line}`);
        if (email.subjectScopeConflict) notes.push("subject line states a different oxygen scope than the authored text");
        entries.push(historyEntry({
          date: email.receivedAt.slice(0, 10),
          source: "QPC sent estimate",
          evidence: `${email.from} → ${email.customerRecipients.join(", ")}`,
          unitPrice: price.unitPrice,
          quantity: price.quantity,
          scope: `${email.scopeLatest.level || "level not stated"}; oxygen ${email.scopeLatest.oxygen || "not stated"}; Aclar ${email.scopeLatest.aclar || "not stated"}`,
          proves: "What QPC offered; not customer acceptance",
          differences: [...oxygenDifference(email.scopeLatest.oxygen, line), ...quantityDifference(price.quantity, line)],
          unknown,
          notes,
          terms: email.terms,
          link: email.webLink,
        }));
      }
    }
    if (email.type === "qpc-validity-confirmation") {
      entries.push(historyEntry({
        date: email.receivedAt.slice(0, 10),
        source: "QPC price-validity reply",
        evidence: `${email.from} → ${email.customerRecipients.join(", ")}`,
        scope: `${email.scopeSubject.level || "level ?"}; oxygen ${email.scopeSubject.oxygen || "not stated"} (from the subject)`,
        proves: "QPC told the customer an earlier price was still valid; the price itself is not restated",
        differences: oxygenDifference(email.scopeSubject.oxygen, line),
        unknown: ["price not stated in the message"],
        link: email.webLink,
      }));
    }
  }
  for (const match of dbMatches.filter((item) => item.bucket === "same-customer-exact")) {
    const record = match.record;
    entries.push(historyEntry({
      date: record.received,
      source: "Work order (Router History)",
      evidence: `WO ${record.wo}, row ${record.row}`,
      unitPrice: record.unitPrice,
      scope: `${match.scope.level || "level ?"}; oxygen ${match.scope.oxygen || "not stated"}`,
      proves: "Price on QPC's work order; quantity is not in the export",
      category: match.category,
      categoryReason: match.categoryReason,
      differences: match.differences,
      unknown: match.unknown,
      notes: ["quantity not in the export"],
      router: record.routerForms,
      customerWorkOrder: customerWorkOrder(record.description),
    }));
  }
  for (const match of invoiceMatches.filter((item) => item.bucket === "same-customer-exact")) {
    const record = match.record;
    entries.push(historyEntry({
      date: record.date,
      source: "Invoice line (QBO sales export)",
      evidence: `Invoice ${record.invoice}, row ${record.row}`,
      unitPrice: record.unitPrice,
      quantity: record.quantity,
      scope: `${match.scope.level || "level not stated"}; oxygen ${match.scope.oxygen || "not stated"}`,
      proves: "Billed price; not labor cost, margin or payment",
      category: match.category,
      categoryReason: match.categoryReason,
      differences: [...match.differences, ...quantityDifference(record.quantity, line)],
      unknown: match.unknown,
      customerWorkOrder: customerWorkOrder(record.description),
    }));
  }
  return entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// Groups PO, work-order and invoice evidence by the customer's own job number
// ("WO NO: W1-100") and checks whether the ordinary cleaning prices agree.
function crossCheckJobs(timeline) {
  const jobs = new Map();
  for (const entry of timeline) {
    if (!entry.customerWorkOrder) continue;
    if (!jobs.has(entry.customerWorkOrder)) jobs.set(entry.customerWorkOrder, []);
    jobs.get(entry.customerWorkOrder).push(entry);
  }
  return [...jobs].map(([job, entries]) => {
    const ordinary = entries.filter((entry) => entry.status !== "excluded" && entry.unitPrice != null);
    const prices = [...new Set(ordinary.map((entry) => entry.unitPrice))];
    return {
      job,
      date: entries.map((entry) => entry.date).sort()[0],
      sources: entries.map((entry) => ({ source: entry.source, evidence: entry.evidence, unitPrice: entry.unitPrice, quantity: entry.quantity, status: entry.status })),
      agree: prices.length <= 1,
      prices,
      sourceCount: new Set(ordinary.map((entry) => entry.source)).size,
    };
  }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function pick(result) {
  return blocked(result) ? { blocked: result.blocked } : { price: result.price, unit: result.unit, flags: result.flags };
}

// The calculator's price in the volume (SQ2) slot, so the settle step, the
// band and the page read it the way they read the master's volume price.
function volumeFromCalculator(online, { line, sq2Input, quarter }) {
  if (blocked(online)) return { method: online.method, source: "calculator", blocked: online.blocked };
  const c = online.components;
  const { length: L, width: W, height: H } = sq2Input.envelope;
  const reason = line.calculator.complexityReason;
  const flags = sq2Input.flags.filter((flag) => !/^GEOM:|^CAVITY CONFIDENCE/.test(flag))
    .concat([`COMPLEXITY: ${c.complexityKey}${reason ? "" : " (no reason stated)"}`, "CAVITY $0 (ruling calculator-volume-v1)"], online.flags);
  if (line.calculator.cavityDollars) flags.push(`CAVITY $${line.calculator.cavityDollars} IN CASE IGNORED (ruling calculator-volume-v1)`);
  const price = quarter(online.unit);
  return {
    method: `${online.method} (ruling calculator-volume-v1)`,
    source: "calculator",
    blocked: [],
    unit: online.unit,
    price,
    components: { ...c, rawVolume: L * W * H, complexityReason: reason || null },
    trace: [`Raw volume ${L} x ${W} x ${H} = ${(L * W * H).toFixed(4)} in³`, ...online.trace, `→ rounded to nearest $0.25 = $${price.toFixed(2)}`],
    flags,
  };
}

function runCalculations(line, rules, calculator) {
  const sq1 = line.sq1;
  const envelope = { length: sq1.envelope.length, width: sq1.envelope.width, height: sq1.envelope.height };
  const sq2Input = {
    envelope,
    cleanliness: sq1.cleanliness.level,
    geometry: sq1.geometry.class,
    cavities: sq1.cavities.counts,
    lengthSurcharge: sq1.lengthSurcharge,
    specFee: sq1.specFee,
    aclar: sq1.aclar,
    flags: [sq1.envelope.flag, sq1.cleanliness.flag, sq1.specGroup.flag, sq1.aclar.flag, sq1.weight.flag, `GEOM: ${sq1.geometry.class} (${sq1.geometry.confidence})`, `CAVITY CONFIDENCE ${sq1.cavities.confidence}`]
      .concat(sq1.lengthSurcharge.flag ? ["ASM: length surcharge assumed $0"] : []),
  };
  const masterSq2 = sq2NonTube(sq2Input, rules);
  const masterSq2Sensitivity = (line.sq2Sensitivity || []).map((item) => ({
    label: item.label,
    ...pick(sq2NonTube({ ...sq2Input, ...(item.geometry ? { geometry: item.geometry } : {}), ...(item.cavities ? { cavities: item.cavities } : {}) }, rules)),
  }));

  // Ruling calculator-volume-v1: the volume price is the published calculator's,
  // with holes, bores and cavities judged only through its Complexity pick
  // (Cavity $ is always 0; per-hole charges overpriced repeated features).
  // Rounded to the nearest $0.25 like the master's volume price.
  const calculatorInput = { envelope, ...line.calculator, cavityDollars: 0 };
  const online = calculatorPrice(calculatorInput, calculator);
  const onlineAlternatives = (line.calculator.alternatives || []).map((item) => ({ label: item.label, ...pick(calculatorPrice({ ...calculatorInput, ...item, cavityDollars: 0 }, calculator)) }));
  const quarter = (value) => Math.round(value * 4 + 1e-9) / 4;
  const sq2 = volumeFromCalculator(online, { line, sq2Input, quarter });
  const sq2Sensitivity = onlineAlternatives.map((item) => (item.blocked ? item : { ...item, price: quarter(item.unit) }));

  const sq3 = sq3Throughput({ quantity: line.quantity, batch: line.sq3.batch, steps: line.sq3.steps }, rules);
  const sq3Sensitivity = (line.sq3.sensitivity || []).map((item) => {
    const steps = line.sq3.steps.map((step) => (item.stepOverrides?.[step.step] != null ? { ...step, minutes: item.stepOverrides[step.step] } : step));
    const batch = item.batch ? { ...line.sq3.batch, size: item.batch } : line.sq3.batch;
    return { label: item.label, ...pick(sq3Throughput({ quantity: line.quantity, batch, steps }, rules)) };
  });

  // Ruling hands-on-labor-no-inversion-v1: SQ5 compares SQ2 with hands-on
  // labor only (lot setup is recovered by the lot minimum) and never inverts.
  const handsOn = blocked(sq3) ? null : Math.round((sq3.components.partTechMinutes / 60) * sq3.components.rate * 100) / 100;
  const sq5 = blocked(sq2) ? { blocked: ["SQ2 is blocked"] } : sq5Stabilize({ sq2: sq2.price, sq3: handsOn, anchor: line.sq5Anchor, inversion: false });
  const widen = ["100", "50", "25"].includes(String(sq1.cleanliness.level)) || /extensive|critical/i.test(sq1.geometry.class) || [6, 8, 9].includes(sq1.category.value) || Boolean(sq1.aclar.required);
  const sq4 = !blocked(sq2) && !blocked(sq3) ? sq4Band({ sq2: sq2.price, sq3: handsOn, anchor: line.sq5Anchor, widen, rules, inversion: false }) : { blocked: ["needs SQ2 and SQ3"] };

  return {
    sq2,
    sq2Sensitivity,
    masterSq2,
    masterSq2Sensitivity,
    sq3: { ...sq3, handsOnPrice: handsOn, steps: line.sq3.steps, batch: line.sq3.batch, concurrency: line.sq3.concurrency, measuredTimeSearch: line.sq3.measuredTimeSearch },
    sq3Sensitivity,
    sq4,
    sq5,
    sq6: line.sq6 || { status: "not run — SQ6 is a reviewer's challenge step and is not automated" },
    onlineCalculator: online,
    onlineAlternatives,
  };
}

// Ruling lot-minimum-per-po-v1: a lot minimum is for the entire PO, not per
// line item. With more than one part, the minimum is checked once against the
// PO total (each part at its requested quantity; a part with quantity tiers
// counts its first tier) and no line carries a lot charge of its own. With one
// part, each line is a whole PO (tiers are alternatives) and keeps its check.
function applyPoLotMinimum(lines, rules) {
  const parts = new Map();
  for (const line of lines) if (!parts.has(line.request.partNumber)) parts.set(line.request.partNumber, line);
  if (parts.size < 2) return null;
  for (const line of lines) {
    delete line.recommendation.lotMinimum;
    if (line.recommendation.preferred) delete line.recommendation.preferred.lotCharge;
  }
  const counted = [...parts.values()];
  const cents = counted.reduce((sum, line) => sum + (line.recommendation.preferred ? Math.round(line.recommendation.preferred.unitPrice * line.request.quantity * 100) : 0), 0);
  const extended = cents / 100;
  return {
    ruling: "lot-minimum-per-po-v1",
    lineIds: counted.map((line) => line.lineId),
    unpriced: counted.filter((line) => !line.recommendation.preferred).map((line) => line.lineId),
    extended,
    minimum: rules.lotMinimum,
    passes: extended >= rules.lotMinimum,
    lotCharge: extended >= rules.lotMinimum ? null : rules.lotMinimum,
  };
}

// A QPC quote whose text names no part number ("these fittings are $35.00
// each") can be tied to a line by the case (line.quoteLinks: messageId,
// unitPrice, quantity, reason). It counts only when the message is from QPC to
// the customer and its newest authored text shows that exact price; otherwise
// the link is recorded as rejected and nothing is priced from it.
function linkQuote(email, line, kase) {
  const link = (line.quoteLinks || []).find((item) => item.messageId === email.id);
  if (!link) return email;
  const fromQpc = kase.internalDomains.includes(String(email.from).toLowerCase().split("@")[1]);
  const price = Number(link.unitPrice);
  const shown = new RegExp(`\\$\\s*${Math.trunc(price).toLocaleString("en-US").replace(/,/g, ",?")}(?:\\.${(price % 1).toFixed(2).slice(2)})${price % 1 ? "" : "?"}(?![\\d.])`).test(email.latest);
  if (!fromQpc || !email.customerRecipients.length || !shown) {
    return { ...email, linkedQuote: { ...link, accepted: false, why: !fromQpc ? "not sent by QPC" : !email.customerRecipients.length ? "no customer recipient" : `$${price.toFixed(2)} is not in the message's authored text` } };
  }
  const row = { unitPrice: price, quantity: link.quantity ?? null, style: "linked-by-case", matchKind: "linked", line: link.reason };
  return { ...email, type: "qpc-sent-estimate", typeReason: `QPC quote tied to this part by the case: ${link.reason}`, prices: [...email.prices, row], linkedQuote: { ...link, accepted: true } };
}

function readMonitorFreshness(monitorStatePath) {
  if (!monitorStatePath || !fs.existsSync(monitorStatePath)) return null;
  const state = readJson(monitorStatePath);
  return { ...state.freshness, coverage: state.coverage, owner: "Codex hourly monitor (read-only input)" };
}

export function buildDecision({ casePath, storeDir, routerFolder, salesExportPath, priceLabDir, calculatorHtml, monitorStatePath, now = new Date() }) {
  const kase = readJson(casePath);
  const caseDir = path.dirname(casePath);
  const messagesPath = path.resolve(caseDir, kase.evidence.messages);
  const searchLogPath = path.resolve(caseDir, kase.evidence.searchLog);
  const rules = loadPriceLabRules(priceLabDir);
  const calculator = loadCalculator(calculatorHtml);
  const snapshot = loadSnapshotRecords(storeDir);
  const databaseStatus = snapshotStatus(storeDir, { now, folder: routerFolder });
  const sales = readSalesExport(salesExportPath);
  const messages = loadMessages(messagesPath);
  const searchLog = readJson(searchLogPath);
  const requestDate = kase.rfq.initiatedAt.slice(0, 10);

  const lines = kase.lines.map((line) => {
    const dbMatches = matchLineHistory(snapshot.records, line, kase.customer);
    const invoiceMatches = matchLineHistory(sales.records, line, kase.customer, { partText: ["description"], scopeText: ["description"] });
    const emails = messages
      .map((message) => ({ message, classified: linkQuote(classifyMessage(message, { partNumber: line.partNumber, aliases: line.aliases, customerDomains: kase.customer.emailDomains, internalDomains: kase.internalDomains }), line, kase) }))
      .filter(({ message, classified }) => classified.linkedQuote || Object.values(classified.mentions).some(Boolean)
        || (message.searchQueries || []).some((query) => partNumberMatch(query, line.partNumber, line.aliases)))
      .map(({ classified }) => classified)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const purchaseOrders = emails.flatMap((email) => email.purchaseOrders.map((po) => {
      const comparison = compareScope(po.scope, po.revisionOfPart, line);
      const differences = [...comparison.differences];
      const unknown = [...comparison.unknown];
      if (!po.uom) unknown.push("unit of measure not read from the PO");
      else if (line.uom && po.uom !== line.uom.toUpperCase()) differences.push(`unit of measure ${po.uom} vs ${line.uom}`);
      return {
        ...po,
        messageId: email.id,
        webLink: email.webLink,
        from: email.from,
        comparable: email.type === "customer-po" && ["exact", "formatting-variant"].includes(po.partMatch) && !differences.length && !unknown.length,
        differences,
        unknown,
      };
    }));
    const calculations = runCalculations(line, rules, calculator);
    const timeline = buildTimeline(line, { dbMatches, invoiceMatches, emails, purchaseOrders });
    const sentQuotes = timeline.filter((entry) => entry.source === "QPC sent estimate");
    const recommendation = recommend({ policyId: kase.recommendationPolicy, line, requestDate, purchaseOrders, sentQuotes, chain: blocked(calculations.sq5) ? null : calculations.sq5 });
    if (recommendation.preferred) {
      recommendation.lotMinimum = lotMinimumCheck(recommendation.preferred.unitPrice, line.quantity, rules);
      if (!recommendation.lotMinimum.passes) recommendation.preferred.lotCharge = recommendation.lotMinimum.minimum;
    }

    return {
      lineId: line.lineId,
      rulings: RULINGS.map((ruling) => ruling.id),
      request: {
        partNumber: line.partNumber,
        aliases: line.aliases,
        revision: line.revision,
        description: line.description,
        quantity: line.quantity,
        quantityAlternatives: line.quantityAlternatives,
        uom: line.uom,
        currency: line.currency,
        process: line.process,
        scope: line.scope,
        material: line.material,
        drawing: line.drawing,
        packaging: line.packaging,
      },
      history: {
        database: {
          snapshot: { id: snapshot.meta.snapshotId, fileName: snapshot.meta.fileName, exportDate: snapshot.meta.exportDate, receivedMax: snapshot.meta.receivedMax },
          summary: summarizeMatches(dbMatches),
          otherCustomers: dbMatches.filter((item) => item.bucket === "other-customer").map((item) => ({ customer: item.record.customer, wo: item.record.wo, received: item.record.received, unitPrice: item.record.unitPrice })),
          partialTokens: dbMatches.filter((item) => item.bucket === "partial-token").map((item) => ({ matched: item.match.matched, customer: item.record.customer, wo: item.record.wo })),
        },
        invoices: { export: sales.meta, summary: summarizeMatches(invoiceMatches) },
        email: {
          searchLog,
          messagesConsidered: messages.length,
          evidence: emails.map((email) => ({
            id: email.id,
            mailbox: email.mailbox,
            receivedAt: email.receivedAt,
            from: email.from,
            subject: email.subject,
            type: email.type,
            typeReason: email.typeReason,
            mentions: email.mentions,
            prices: email.prices,
            terms: email.terms,
            scopeLatest: email.scopeLatest,
            subjectScopeConflict: email.subjectScopeConflict,
            purchaseOrders: email.purchaseOrders.map((po) => po.poNumber),
            attachmentsNotRead: email.attachmentsNotRead,
            webLink: email.webLink,
            latestExcerpt: email.latest.slice(0, 400),
          })),
        },
        purchaseOrders,
        timeline,
        jobs: crossCheckJobs(timeline),
      },
      calculations,
      recommendation,
    };
  });
  const poLotMinimum = applyPoLotMinimum(lines, rules);

  const engine = engineFingerprint();
  const fingerprint = sha256(JSON.stringify({
    case: fs.readFileSync(casePath, "utf8"),
    messages: fs.readFileSync(messagesPath, "utf8"),
    searchLog: fs.readFileSync(searchLogPath, "utf8"),
    snapshot: snapshot.meta.snapshotId,
    sales: sales.meta.sha256,
    rules: rules.hashes,
    calculator: calculator.sha256,
    engine,
  }));

  return {
    schema: DECISION_SCHEMA,
    caseId: kase.caseId,
    mode: kase.mode,
    generatedAt: now.toISOString(),
    inputsFingerprint: fingerprint,
    engine: { sourceSha256: engine, files: ENGINE_FILES },
    status: `RECOMMENDATION ONLY — not approved, not sent. ${kase.approvers || "An authorized reviewer"} must review before any quote goes to the customer.`,
    rulings: RULINGS,
    customer: kase.customer,
    rfq: kase.rfq,
    commercial: kase.commercial,
    lines,
    poLotMinimum,
    lifecycle: {
      recommendationVersion: null,
      approvedPrice: null,
      approvedBy: null,
      approvedAt: null,
      sentQuote: null,
      customerPo: null,
      contractReview: null,
      note: "Approval, the quote actually sent and any later PO are recorded as separate entries; a new recommendation version never overwrites them.",
    },
    freshness: {
      email: {
        searchedAt: searchLog.searchedAt,
        searches: searchLog.searches.map((item) => ({ mailbox: item.mailbox, query: item.query, results: item.results, complete: item.complete })),
        gaps: searchLog.gaps,
        monitor: readMonitorFreshness(monitorStatePath),
      },
      database: databaseStatus,
      invoices: { fileName: sales.meta.fileName, sha256: sales.meta.sha256, dateMin: sales.meta.dateMin, dateMax: sales.meta.dateMax, note: "Historical QuickBooks Online export; not current invoice coverage; report filters unverified." },
      rules: {
        priceLab: { version: rules.version, capturedAt: rules.capturedAt, hashes: rules.hashes, laborRate: rules.laborRate },
        onlineCalculator: { path: calculator.path, sha256: calculator.sha256, formulaDrift: calculator.formulaDrift },
      },
    },
  };
}

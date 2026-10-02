import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { caseConfidence, reasonsText } from "./confidence.js";
import { lifecyclePath, lifecycleView, readLifecycle } from "./lifecycle.js";
import { isSameCustomer, partNumberMatch } from "./part-history.js";
import { ICON, progressHtml, SCRIPT, STYLE } from "./design.js";
import { displayStatus, escapeHtml } from "./render.js";
import { ASKING_KINDS, caseMail, foundRows, placeMailEvents, readClaudeMail, subjectKey } from "./claude-mail.js";
import { isOwnAddress, mailSources, useOrg } from "./org.js";
import { followupThreads, matchThread, monitorCandidates, readQuotePrepChat } from "./followups.js";
import { readManifest } from "./router-snapshot.js";
import { poTotal, priceSource } from "./review-card.js";

// The pricing front door: where the price pages live. One page joins the mail
// monitor's view of every RFQ with the pricing side's work on it: which RFQs
// have a price page, what was decided, whether the monitor has since seen the
// quote go out, how long customers have waited, method feedback, and every
// unanswered RFQ still without a page. Reads only; the monitor state belongs to its own scheduler
// and is never written.

export const BOARD_FILE = "CLAUDE-DECISIONS-OPEN.html";
// Matches the monitor's own stale threshold. Past this, mail data on the
// board is marked STALE whatever the monitor's file says, because a stopped
// monitor never updates its own stale flag.
export const MONITOR_STALE_MINUTES = 120;
// The page also checks its own age when opened: a board not rebuilt within
// this window means the sync (or the machine running it) has stopped.
export const BOARD_STALE_MINUTES = 120;

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
// Date-only values ("2026-09-23") are shown as written; timestamps in local time.
const day = (iso) => {
  if (!iso) return "—";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Date(dateOnly ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
};
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "—");

// Weekdays after `fromIso` up to and including `now`, both taken as dates in
// the machine's local time zone (the shop's), not UTC.
const localDate = (date) => date.toLocaleDateString("en-CA");
export function businessDaysSince(fromIso, now) {
  if (!fromIso) return null;
  const start = new Date(`${localDate(new Date(fromIso))}T12:00:00Z`);
  const end = new Date(`${localDate(now)}T12:00:00Z`);
  let days = 0;
  for (let cursor = new Date(start); cursor < end;) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

export function latestDecisions(outputsDir) {
  const latest = new Map();
  for (const name of fs.readdirSync(outputsDir)) {
    const match = name.match(/^CLAUDE-DECISION-(.+)-v(\d+)\.json$/);
    if (!match) continue;
    const version = Number(match[2]);
    if (!latest.has(match[1]) || latest.get(match[1]).version < version) latest.set(match[1], { caseId: match[1], version, file: name });
  }
  return [...latest.values()].map((item) => ({ ...item, decision: JSON.parse(fs.readFileSync(path.join(outputsDir, item.file), "utf8")) }));
}

// The customer's RFQ number as the case states it ("ACME RFQ #4100" -> 4100).
function rfqNumbers(text) {
  return [...String(text || "").matchAll(/\bRFQ\s*#?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/gi)].map((match) => match[1].toUpperCase());
}

const nameWords = (text) => String(text || "").toUpperCase().replace(/[^A-Z0-9&]+/g, " ").trim().split(" ").filter(Boolean);
function shortNameOf(monitorName, customer) {
  const words = nameWords(monitorName);
  if (!words.length) return false;
  return [customer.name, ...(customer.aliases || [])].some((candidate) => {
    const have = new Set(nameWords(candidate));
    return words.every((word) => have.has(word));
  });
}

// Links a case to the monitor's queue entry under the monitor's own contract
// (outputs/RFQ-PRICING-INTEGRATION.md). The customer must match (a shortened
// monitor name counts only with the exact reference), and then
// either the case's exact rfq.monitorReference matches, or all of these hold:
// a full part number (not a longer part) appears in the reference (revision
// is not compared), any RFQ number the case states appears there,
// and the two sides share a source email (required whenever the case lists
// its source emails; otherwise the stated RFQ number must agree). More than
// one candidate is left unresolved rather than guessed.
export function monitorLink(decision, queue) {
  const sameCustomer = queue.filter((item) => isSameCustomer(item.customer, decision.customer));
  const explicit = decision.rfq.monitorReference;
  let candidates;
  if (explicit) {
    // The monitor often shortens the customer ("Acme" for "Acme Precision
    // Corporation"); with the exact reference the case names, every word of the
    // monitor's name appearing in the case's name or an alias is enough.
    candidates = queue.filter((item) => item.reference === explicit && (isSameCustomer(item.customer, decision.customer) || shortNameOf(item.customer, decision.customer)));
  } else {
    const caseRfqs = rfqNumbers(decision.rfq.reference);
    const caseMessages = new Set((decision.rfq.sourceMessageIds || []).flatMap((id) => [id, id.replace(/_/g, "+")]));
    candidates = sameCustomer.filter((item) => {
      const reference = item.reference || "";
      const samePart = decision.lines.some((line) => {
        const match = partNumberMatch(reference, line.request.partNumber, line.request.aliases || []);
        return Boolean(match) && match.kind !== "partial-token";
      });
      if (!samePart) return false;
      const tokens = new Set(reference.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean));
      const rfqAgrees = caseRfqs.some((number) => tokens.has(number));
      if (caseRfqs.length && !rfqAgrees) return false;
      const messages = [...(item.evidence_ids || []), ...(item.events || []).map((event) => event.message_id)].filter(Boolean);
      return caseMessages.size ? messages.some((id) => caseMessages.has(id)) : rfqAgrees;
    });
  }
  if (candidates.length === 1) return { entry: candidates[0], ambiguous: [] };
  return { entry: null, ambiguous: candidates.map((item) => item.reference) };
}

// Section 3 also holds PO, readiness and shipment activity, so a case counts
// as sent only when a clause of the monitor's status says a quote went out
// and neither that clause nor a bare qualifier doubts it ("not quoted",
// "quoted per ledger; unverified").
// A customer confirming receipt of the quote also proves it went out
// ("Customer confirmed quote receipt", "confirmed receipt of the quote").
// So does QPC telling the customer an earlier quote still stands ("Prior quote
// confirmed valid in customer-facing response").
const SENT_CLAUSE = /\bquote\s+(?:\w+\s+){0,2}sent\b|\bsent\s+(?:an?\s+|the\s+)?(?:\w+\s+)?quote\b|\bquoted\b|\b(?:confirmed|acknowledged)\s+(?:the\s+)?quote\s+receipt\b|\bquote\s+receipt\s+(?:confirmed|acknowledged)\b|\b(?:confirmed|acknowledged)\s+receipt\s+of\s+(?:the\s+|our\s+)?quote\b|\bquote\s+confirmed\s+valid\s+in\s+customer-facing\b/i;
const DOUBT = /\b(?:not|no|never|unverified|unconfirmed|provisional|pending|draft|per ledger|will|shall|would|to be|going to|plan|plans|planned|scheduled|tomorrow|later|awaiting)\b/i;
const BARE_DOUBT = /^(?:still\s+)?(?:unverified|unconfirmed|provisional|not verified|not confirmed)\.?$/i;
export function quoteSentStatus(status) {
  const clauses = String(status || "").split(/\s*[;/]\s*/).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.some((clause) => BARE_DOUBT.test(clause))) return false;
  return clauses.some((clause) => SENT_CLAUSE.test(clause) && !DOUBT.test(clause));
}
// Section 1 also holds acknowledgment, timing and technical follow-ups.
export const PRICING_REQUEST = /\bRFQ\b|\bquot|\bpric|\bestimat|\bbudgetary\b|\binquir/i;

// The log of rulings, builds and commits lives in a private
// tracker file (config.trackerFile), kept by the Claude session; the board
// adds what it can see itself: pages built, recorded decisions, quotes sent.
// Outlook-on-the-web link for a Graph message id (URL-safe base64 → standard).
export function owaLink(messageId) {
  if (!messageId) return null;
  return `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId.replace(/_/g, "+").replace(/-/g, "/"))}&exvsurl=1&viewmodel=ReadMessageItem`;
}

// The email that carries the request's files (drawings, parts lists, models)
// that the pricing read could not open: the customer's own newest such email,
// else any. Its link opens the message with the attachments to check by hand.
export function attachmentsEmail(decision, share = () => null) {
  const evidence = [...new Map(decision.lines.flatMap((line) => line.history?.email?.evidence || []).map((item) => [item.id, item])).values()]
    .filter((item) => (item.attachmentsNotRead || []).length && item.webLink);
  if (!evidence.length) return null;
  const domains = (decision.customer.emailDomains || []).map((domain) => domain.toLowerCase());
  const fromCustomer = evidence.filter((item) => domains.includes(String(item.from || "").split("@")[1]?.toLowerCase()));
  const pick = (fromCustomer.length ? fromCustomer : evidence).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))[0];
  return { href: share(pick.id) || pick.webLink, at: pick.receivedAt, from: pick.from, names: pick.attachmentsNotRead };
}

// The newest sent or received message the monitor saw in the thread (drafts
// excluded), so replies after the RFQ are one click away. Null when that is
// the RFQ email itself.
// Every saved copy of an email (the same message in several mailboxes), by
// any of its ids, from the private evidence files (config.evidenceDir).
export function readMailCopies(evidenceDir) {
  const copies = new Map();
  if (!evidenceDir || !fs.existsSync(evidenceDir)) return copies;
  for (const folder of fs.readdirSync(evidenceDir)) {
    const file = path.join(evidenceDir, folder, "messages.json");
    if (!fs.existsSync(file)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    for (const message of Array.isArray(data) ? data : data.messages || []) {
      const byMailbox = { ...(message.mailbox && message.id ? { [message.mailbox.toLowerCase()]: message.id } : {}) };
      for (const [mailbox, id] of Object.entries(message.copyIds || {})) byMailbox[mailbox.toLowerCase()] = id;
      for (const key of [message.id, message.internetMessageId, ...Object.values(message.copyIds || {})].filter(Boolean)) {
        copies.set(key, { ...(copies.get(key) || {}), ...byMailbox });
      }
    }
  }
  return copies;
}

// The shared mailbox's copy of a message, so a teammate with access to that
// mailbox (not only the reviewer) can open it. Null when none is saved.
export function sharedLink(id, copies, mailbox) {
  if (!id || !mailbox || !copies?.size) return null;
  const found = copies.get(id) || copies.get(String(id).replace(/\+/g, "-").replace(/\//g, "_"));
  const shared = found?.[mailbox.toLowerCase()];
  return shared ? `https://outlook.office.com/mail/${mailbox}/deeplink?ItemID=${encodeURIComponent(shared)}&exvsurl=1&viewmodel=ReadMessageItem` : null;
}

// Whose mailbox a link opens in, from the message id's mailbox prefix
// (config.mailboxIdPrefixes). A link into one person's own mailbox is marked
// so teammates know to ask for a forward rather than click a dead link.
export function privateOwner(href, prefixes, sharedMailbox) {
  if (!href || !prefixes) return null;
  const id = decodeURIComponent((String(href).match(/ItemID=([^&]+)/) || [])[1] || "");
  const owner = Object.entries(prefixes).find(([prefix]) => id.startsWith(prefix))?.[1];
  if (!owner || /^(frontdesk|sales|info|quotes?)@/i.test(owner) || owner.toLowerCase() === String(sharedMailbox || "").toLowerCase()) return null;
  const name = owner.split("@")[0];
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}
export const onlyTag = (owner) => (owner ? ` <span class="only" title="Opens in ${owner}'s own mailbox; others need a forward">· ${owner} only</span>` : "");

export function latestMessageLink(entry, rfqLink, share = () => null) {
  const events = (entry?.events || []).filter((event) => event.message_id && !event.is_draft);
  if (!events.length) return null;
  const newest = events.reduce((a, b) => (String(b.at) > String(a.at) ? b : a));
  const index = (entry.evidence_ids || []).indexOf(newest.message_id);
  const link = share(newest.message_id) || (index >= 0 && entry.evidence_links?.[index]) || owaLink(newest.message_id);
  return link && link !== rfqLink ? { href: link, at: newest.at, actor: newest.actor || null } : null;
}

// Sender and subject of the monitor's RFQ messages, looked up read-only by the
// Claude session (config.rfqMailCache); the board has no mail access itself.
function readMailCache(mailCachePath) {
  if (!mailCachePath || !fs.existsSync(mailCachePath)) return {};
  return JSON.parse(fs.readFileSync(mailCachePath, "utf8")).messages || {};
}

// The original RFQ email among a set of message ids: the earliest one sent by
// the customer (a QPC forward or reply draft is never the RFQ sender), falling
// back to the earliest of any sender. `isCustomer` says who the customer is.
function originalEmail(ids, known, isCustomer = () => true) {
  const found = (ids || []).map((id) => known(id)).filter(Boolean).sort((a, b) => (a.receivedAt || "").localeCompare(b.receivedAt || ""));
  return found.find((item) => isCustomer(item.from)) || found[0] || null;
}

const domainOf = (address) => String(address || "").toLowerCase().split("@")[1] || "";

function readTracker(trackerPath) {
  if (!trackerPath || !fs.existsSync(trackerPath)) return { history: [] };
  return { history: JSON.parse(fs.readFileSync(trackerPath, "utf8")).history || [] };
}

// When the mail monitor first saw the quote go out: the earliest sent event
// that reads as a sent quote, else its verified time, else the last activity.
function sentAt(monitor) {
  const hit = (monitor?.events || []).filter((event) => !event.is_draft && quoteSentStatus(String(event.meaning || "").split(/[.;]\s/)[0])).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  return hit?.at || monitor?.quote_sent_verified_at || monitor?.last_observed_activity_at || null;
}

// When the first page for this RFQ was built (a later version keeps that date).
function firstBuilt(outputsDir, caseId, version, decision) {
  if (version <= 1) return decision.generatedAt;
  const first = path.join(outputsDir, `CLAUDE-DECISION-${caseId}-v1.json`);
  try { return JSON.parse(fs.readFileSync(first, "utf8")).generatedAt || decision.generatedAt; } catch { return decision.generatedAt; }
}

// RFQ in -> Priced -> Decided -> Quote sent, with dates, for the card and page.
export function progressOf({ decision, lines, monitor, sent, firstPricedAt = null, sentAtOverride = null }) {
  const total = lines.length;
  const priced = lines.filter((line) => line.suggested != null).length;
  const decided = lines.filter((line) => line.decided && line.decided.choice !== "correction");
  const lastDecided = decided.map((line) => line.decided.decidedAt).filter(Boolean).sort().at(-1) || null;
  return [
    { key: "asked", label: "RFQ in", done: true, at: decision.rfq.initiatedAt || null },
    { key: "priced", label: "Priced", done: priced === total || decided.length === total, at: firstPricedAt || decision.generatedAt, pending: priced ? `Priced ${priced} of ${total}` : "Needs facts", tone: "warn" },
    { key: "decided", label: "Decided", done: decided.length === total, at: lastDecided, pending: decided.length ? `Decided ${decided.length} of ${total}` : "Your decision" },
    { key: "sent", label: "Quote sent", done: Boolean(sent), at: sent ? sentAtOverride || sentAt(monitor) : null, pending: "Quote sent" },
  ];
}

function caseEvents({ caseId, version, decision, lifecycle, monitor, sent, mailSent = null }) {
  const name = `${decision.customer.name.replace(/\.$/, "")} ${decision.rfq.reference || caseId}`;
  const events = [{ at: decision.generatedAt, kind: "priced", text: `${name}: price page v${version} built`, caseId }];
  for (const entry of lifecycle.entries) {
    if (entry.type === "method-review") events.push({ at: entry.decidedAt, kind: "review", text: `${name} ${entry.lineId}: method ${entry.verdict}${entry.note ? ` (“${entry.note}”)` : ""} — ${entry.decidedBy}`, caseId });
    else if (entry.type === "decision") {
      const price = entry.unitPrice != null ? ` $${Number(entry.unitPrice).toFixed(2)}` : "";
      const words = entry.reply || entry.note;
      events.push({ at: entry.decidedAt, kind: entry.choice === "correction" ? "correction" : "decision", text: `${name} ${entry.lineId} v${entry.version}: ${entry.choice}${price} — ${entry.decidedBy}${words ? ` (“${words}”)` : ""}`, caseId });
    }
  }
  if (sent && monitor && quoteSentStatus(monitor.status)) events.push({ at: monitor.last_observed_activity_at || null, kind: "sent", text: `${name}: quote seen sent by the mail monitor (“${monitor.status}”)`, caseId });
  else if (sent && mailSent) events.push({ at: mailSent.at, kind: "sent", text: `${name}: quote seen sent by Claude's mail check (${mailSent.from} to ${(mailSent.to || []).join(", ")}, “${mailSent.subject}”)`, caseId });
  return events;
}

export function buildBoard({ outputsDir, monitorStatePath, storeDir = null, lastSync = null, trackerPath = null, mailCachePath = null, quotePrepChatPath = null, claudeMailPath = null, evidenceDir = null, sharedMailbox = null, mailboxIdPrefixes = null, org = null, triagePath = null, now = new Date() }) {
  if (org) useOrg(org);
  const mailCache = readMailCache(mailCachePath);
  const ownerOf = (href) => privateOwner(href, mailboxIdPrefixes, sharedMailbox);
  // Links prefer the shared mailbox's copy so teammates can open them too.
  const copies = sharedMailbox ? readMailCopies(evidenceDir) : new Map();
  const share = (id) => sharedLink(id, copies, sharedMailbox);
  const claudeMail = readClaudeMail(claudeMailPath);
  const state = monitorStatePath && fs.existsSync(monitorStatePath) ? JSON.parse(fs.readFileSync(monitorStatePath, "utf8")) : null;
  const queue = state?.operational_queue || [];
  const currentSnapshot = storeDir ? readManifest(storeDir).current : null;

  const cases = latestDecisions(outputsDir).map(({ caseId, version, file, decision }) => {
    const lifecycle = readLifecycle(lifecyclePath(outputsDir, caseId), caseId);
    const view = lifecycleView(decision, lifecycle);
    const status = displayStatus(decision, view);
    const partNumbers = [...new Set(decision.lines.map((line) => line.request.partNumber))];
    const link = monitorLink(decision, queue);
    const monitor = link.entry;
    const monitorSent = monitor?.priority_section === 3 && quoteSentStatus(monitor.status);
    // Claude's own mail check can see a quote go out before the monitor does.
    const mail = claudeMail ? caseMail({ customerRecord: decision.customer, askedAt: decision.rfq.initiatedAt, lines: partNumbers.map((partNumber) => ({ partNumber })), reference: decision.rfq.reference, monitorReference: decision.rfq.monitorReference }, claudeMail.events) : null;
    const sent = monitorSent || Boolean(mail?.sent);
    const priceSnapshot = decision.lines[0]?.history.database.snapshot;
    let label = status.text.startsWith("PARTLY") ? "Partly decided" : { warn: "Waiting on you", ok: "Decided — not sent", alert: "Correction requested" }[status.tone];
    let tone = status.tone;
    if (sent) {
      label = monitorSent ? "Quote sent (per monitor status)" : "Quote sent (per mail check)";
      tone = "ok";
    }
    return {
      caseId,
      version,
      page: file.replace(/\.json$/, ".html"),
      customer: decision.customer.name,
      customerRecord: decision.customer,
      reference: decision.rfq.reference || null,
      askedAt: decision.rfq.initiatedAt,
      chasedAt: decision.rfq.latestAskAt,
      waitingBusinessDays: businessDaysSince(decision.rfq.initiatedAt, now),
      tone,
      state: label,
      open: !sent && status.tone !== "ok",
      monitor: monitor ? { reference: monitor.reference, section: monitor.priority_section, status: monitor.status, lastActivityAt: monitor.last_observed_activity_at || null } : null,
      monitorAmbiguous: link.ambiguous,
      staleSnapshot: Boolean(currentSnapshot && priceSnapshot && priceSnapshot.id !== currentSnapshot),
      priceSnapshot: priceSnapshot?.fileName || null,
      dueDate: monitor?.explicit_due_date || null,
      lines: decision.lines.map((line) => ({
        lineId: line.lineId,
        partNumber: line.request.partNumber,
        quantity: line.request.quantity,
        suggested: line.recommendation.preferred?.unitPrice ?? null,
        lotCharge: line.recommendation.preferred?.lotCharge ?? null,
        source: priceSource(line.recommendation.preferred),
        decided: view.current.get(line.lineId) || null,
        missing: line.recommendation.preferred ? null : missingFact(line),
      })),
      partNumbers,
      confidence: (() => { const grade = caseConfidence(decision.lines, view); return { level: grade.level, reasons: reasonsText(grade.weakest) }; })(),
      value: potentialValue(decision, view),
      feedback: lifecycle.entries.filter((entry) => entry.type === "method-review" || entry.choice === "correction").map((entry) => ({ ...entry, caseId })),
      events: caseEvents({ caseId, version, decision, lifecycle, monitor, sent, mailSent: mail?.sent }),
      get progress() { return progressOf({ decision, lines: this.lines, monitor, sent, firstPricedAt: firstBuilt(outputsDir, caseId, version, decision), sentAtOverride: monitorSent ? null : mail?.sent?.at || null }); },
      monitorReference: decision.rfq.monitorReference || null,
      rfqLink: share(monitor?.evidence_ids?.[0]) || monitor?.evidence_links?.[0] || share(decision.rfq.sourceMessageIds?.[0]) || owaLink(decision.rfq.sourceMessageIds?.[0]),
      get rfqOwner() { return ownerOf(this.rfqLink); },
      files: (() => { const files = attachmentsEmail(decision, share); return files ? { ...files, owner: ownerOf(files.href) } : null; })(),
      latestLink: (() => {
        const fromMonitor = latestMessageLink(monitor, share(monitor?.evidence_ids?.[0]) || monitor?.evidence_links?.[0] || owaLink(decision.rfq.sourceMessageIds?.[0]), share);
        const seen = mail?.latest;
        const chosen = seen?.link && (!fromMonitor || seen.at > fromMonitor.at) ? { href: share(seen.id) || seen.link, at: seen.at, actor: seen.from || null } : fromMonitor;
        return chosen ? { ...chosen, owner: ownerOf(chosen.href) } : null;
      })(),
      email: (() => {
        const evidence = new Map(decision.lines.flatMap((line) => line.history?.email?.evidence || []).map((item) => [item.id, item]));
        const customerDomains = (decision.customer.emailDomains || []).map((item) => item.toLowerCase());
        const found = originalEmail(decision.rfq.sourceMessageIds, (id) => evidence.get(id) || mailCache[id], (from) => customerDomains.includes(domainOf(from)));
        const fromCustomer = found && customerDomains.includes(domainOf(found.from));
        return { from: fromCustomer ? found.from : decision.rfq.initiatedBy || found?.from || null, fromName: fromCustomer ? found.fromName || null : null, subject: found?.subject || null };
      })(),
    };
  });
  cases.sort((a, b) => Number(b.open) - Number(a.open) || (a.askedAt || "").localeCompare(b.askedAt || ""));

  // Where every message Claude's mail check kept lands: on a card, in a list
  // the board already shows, answered by a later quote, or listed by itself.
  const since = new Date(now.getTime() - CHASE_DAYS * 86400000).toISOString();
  const placements = claudeMail ? placeMailEvents(claudeMail.events, cases, queue, { monitorCovers, since }) : [];
  for (const placement of placements.filter((item) => item.place === "case")) {
    const kase = cases.find((item) => item.caseId === placement.caseId);
    if (kase && (!kase.mailChase || Date.parse(kase.mailChase.at) < Date.parse(placement.event.at))) kase.mailChase = placement.event;
  }
  const mailRows = claudeMail ? foundRows(placements, claudeMail.events) : [];
  const chasing = chasingFrom(readQuotePrepChat(quotePrepChatPath), cases, queue, now, readAnswered(triagePath));
  // A customer email the front desk also logged in the chat is one chase: keep
  // the chat row and give it the email's monitor match.
  const chatKeys = new Map((chasing?.unmatched || []).map((thread) => [subjectKey(thread.subject), thread]));
  const mailFound = mailRows.filter((row) => {
    const thread = row.kind !== "rfq" && row.kind !== "secure" && chatKeys.get(subjectKey(row.subject));
    if (!thread) return true;
    if (!thread.monitor && row.monitor && row.monitor.matchedBy !== "customer") thread.monitor = { reference: row.monitor.reference, section: row.monitor.section, status: row.monitor.status, lastActivityAt: row.monitor.lastActivityAt };
    thread.email = { link: row.link, at: row.at };
    return false;
  });

  let monitor = null;
  if (state) {
    const covered = new Set(cases.flatMap((kase) => [kase.monitor?.reference, kase.monitorReference]).filter(Boolean));
    const shownByMail = new Set([...mailFound, ...(chasing?.unmatched || [])].map((row) => row.monitor?.matchedBy !== "customer" && row.monitor?.reference).filter(Boolean));
    const waiting = queue.filter((item) => item.priority_section === 1);
    const cutoff = state.freshness?.source_cutoff || null;
    const ageMinutes = cutoff ? (now.getTime() - Date.parse(cutoff)) / 60000 : null;
    const row = (item) => ({
      customer: item.customer,
      reference: item.reference,
      section: item.priority_section,
      status: item.status,
      pricing: PRICING_REQUEST.test(`${item.reference} ${item.status}`),
      lastActivityAt: item.last_observed_activity_at || null,
      dueDate: item.explicit_due_date || null,
      dueBasis: item.due_basis || item.due_date_basis || null,
      ask: `Price RFQ: ${item.customer} ${item.reference}`,
      rfqLink: item.evidence_links?.[0] || owaLink(item.evidence_ids?.[0]),
      email: (() => {
        const firstActor = [...(item.events || [])].sort((a, b) => (a.at || "").localeCompare(b.at || ""))[0]?.actor || null;
        const found = originalEmail(item.evidence_ids, (id) => mailCache[id], (from) => Boolean(firstActor) && domainOf(from) === domainOf(firstActor));
        return { from: found?.from || firstActor, fromName: found?.fromName || null, subject: found?.subject || null };
      })(),
    });
    const oldestFirst = (a, b) => (a.lastActivityAt ? 0 : 1) - (b.lastActivityAt ? 0 : 1) || (a.lastActivityAt || "").localeCompare(b.lastActivityAt || "");
    monitor = {
      cutoff,
      ageMinutes,
      // Each mail source is judged on its own: Claude's check adds messages
      // but does not refresh the monitor's lists and statuses.
      stale: Boolean(state.freshness?.stale) || ageMinutes == null || ageMinutes > MONITOR_STALE_MINUTES,
      claudeCutoff: claudeMail?.cutoff || null,
      report: state.last_check_report ? path.basename(state.last_check_report) : null,
      sections: { 1: waiting.length, 2: queue.filter((item) => item.priority_section === 2).length, 3: queue.filter((item) => item.priority_section === 3).length },
      waiting: waiting.length,
      withoutPage: waiting.filter((item) => !covered.has(item.reference)).map(row).sort(oldestFirst),
      // Section 2: the customer got an acknowledgment, not a price. The quote
      // is still owed, but nothing else on the board lists these.
      owed: queue.filter((item) => item.priority_section === 2 && !covered.has(item.reference) && !shownByMail.has(item.reference) && PRICING_REQUEST.test(`${item.reference} ${item.status}`) && !quoteSentStatus(item.status)).map(row).sort(oldestFirst),
    };
  }
  const tracker = readTracker(trackerPath);
  const history = [...tracker.history.map((item) => ({ ...item, source: "log" })), ...cases.flatMap((kase) => kase.events)]
    .filter((item) => item.at)
    .sort((a, b) => b.at.localeCompare(a.at));
  return { generatedAt: now.toISOString(), cases, monitor, lastSync, history, mailFound, mailPlacements: placements, triage: readTriage(triagePath), claudeMail: claudeMailView(claudeMail, now), chasing };
}

// What the board says about Claude's own mail check: how far it reached,
// whether that is current, and what its last run searched and found.
function claudeMailView(claudeMail, now) {
  if (!claudeMail) return null;
  const run = claudeMail.runs.at(-1) || null;
  const failed = run ? mailSources().filter((source) => !(run.searched || []).some((item) => item.source === source && item.ok)) : [];
  return { cutoff: claudeMail.cutoff, fresh: claudeFresh(claudeMail, now), stale: claudeStale(claudeMail, now), run, failed };
}

// A monitor entry accounts for a mail-check message when the board lists it
// (section 1, under "No page yet" or on its case) or when the monitor says the
// quote went out and QPC wrote on the entry after the message. Section 2
// (acknowledged, quote pending) is not listed, so those customers would
// otherwise not appear at all.
const monitorCovers = (entry, event) => entry.priority_section === 1
  || (entry.priority_section === 3 && quoteSentStatus(entry.status) && qpcWroteAfter(entry, event.at));

// QPC wrote on the entry after `at`: an event from our own domain's address,
// or, for an entry with no events, an own-domain last sender. A customer's own later
// message (a thank-you, another question) does not count, and neither does an
// unknown sender, so an unanswered question stays on the board.
function qpcWroteAfter(entry, at) {
  const after = (time) => Date.parse(time || "") > Date.parse(at);
  const events = (entry.events || []).filter((item) => !item.is_draft);
  if (events.length) return events.some((item) => isOwnAddress(item.actor) && after(item.at));
  return isOwnAddress(entry.last_observed_actor) && after(entry.last_observed_activity_at);
}

// Claude's mail check counts as fresh on the same two-hour rule as the monitor.
// A cutoff in the future is a bad write, never fresh.
const claudeAge = (claudeMail, now) => (claudeMail?.cutoff ? (now.getTime() - Date.parse(claudeMail.cutoff)) / 60000 : null);
const claudeFresh = (claudeMail, now) => { const age = claudeAge(claudeMail, now); return age != null && age >= -5 && age <= MONITOR_STALE_MINUTES; };
// It runs on weekdays through the working day, so it is late only then (or
// when its cutoff is in the future).
const CLAUDE_HOURS = { from: 8, to: 18 };
function claudeStale(claudeMail, now) {
  const age = claudeAge(claudeMail, now);
  if (age == null || age < -5) return true;
  const local = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const working = local.getDay() >= 1 && local.getDay() <= 5 && local.getHours() >= CLAUDE_HOURS.from && local.getHours() < CLAUDE_HOURS.to;
  return working && age > MONITOR_STALE_MINUTES;
}

// Front desk follow-ups from the last two weeks: each one on the card it
// belongs to (unless the quote went out after it), the rest listed as
// customers chasing a request with no price page.
const CHASE_DAYS = 14;
// Chases a Claude session confirmed answered in the mail (private triage
// file, config.triageFile): key "chat|<company>|<subject>" with answered: true.
// One comes back if the customer chases again after it was checked.
// Every item a Claude session checked and judged not a price request, with
// its reason (private triage file, config.triageFile).
export function readTriage(file) {
  if (!file || !fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}
function readAnswered(file) {
  return new Map(Object.entries(readTriage(file)).filter(([key, entry]) => key.startsWith("chat|") && entry?.answered));
}

// The kind of reason, for grouping: a question only the reviewer can answer,
// protected content, paperwork, the customer's move, or already done.
export function triageGroup(reason) {
  const text = String(reason || "").toLowerCase();
  if (/\banswered\b|already ordered|already quoted|\bordered\b/.test(text)) return "Already answered or ordered";
  if (/protected|encrypted|kiteworks|password/.test(text)) return "Protected files";
  if (/\w+'s (?:call|number)|capability|testing|expedite|supply item/.test(text)) return "Your call";
  if (/waiting|no part|trial|clarification/.test(text)) return "Waiting on the customer";
  return "Paperwork, not pricing";
}
const TRIAGE_ORDER = ["Your call", "Waiting on the customer", "Protected files", "Paperwork, not pricing", "Already answered or ordered"];
const TRIAGE_TONE = { "Your call": "warn", "Waiting on the customer": "muted", "Protected files": "muted", "Paperwork, not pricing": "muted", "Already answered or ordered": "ok" };

// Items checked and set aside, grouped by why, folded under the section.
function notPricedTable(items, now) {
  if (!items.length) return "";
  const sorted = [...items].sort((a, b) => TRIAGE_ORDER.indexOf(a.group) - TRIAGE_ORDER.indexOf(b.group));
  const rows = sorted.map((item) => `<tr><td><span class="strong">${esc(item.customer)}</span><div class="why-not">${esc(item.reference)}</div></td><td><span class="chip ${TRIAGE_TONE[item.group] || "muted"}">${esc(item.group)}</span><div class="why-not">${esc(item.reason)}</div></td><td class="date">${item.lastAt ? relativeDay(item.lastAt, now) : "—"}</td></tr>`).join("");
  return `<details class="fold"><summary>${ICON.chevron}<h3>Checked: not a price request <small>${items.length}</small></h3></summary><div class="scroll"><table class="queue"><thead><tr><th>Company · reference</th><th>Why no page</th><th>Last activity</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function chasingFrom(chat, cases, queue, now, answered = new Map()) {
  if (!chat) return null;
  const recent = followupThreads(chat.messages).filter((thread) => Date.parse(thread.lastAt) >= now.getTime() - CHASE_DAYS * 86400000)
    .filter((thread) => { const seen = answered.get(`chat|${thread.company}|${thread.subject}`); return !seen || String(thread.lastAt) > String(seen.at); });
  const unmatched = [];
  for (const thread of recent) {
    const hits = matchThread(thread, cases);
    if (!hits.length) {
      const { entry, candidates } = monitorCandidates(thread, queue);
      // Answered: the monitor says the quote went out and QPC wrote after the last chase.
      if (entry && entry.priority_section === 3 && quoteSentStatus(entry.status) && qpcWroteAfter(entry, thread.lastAt)) continue;
      unmatched.push({ ...thread, monitor: entry ? { reference: entry.reference, section: entry.priority_section, status: entry.status, lastActivityAt: entry.last_observed_activity_at || null } : null, candidates });
      continue;
    }
    for (const kase of hits) {
      const sent = kase.progress.find((step) => step.key === "sent");
      if (sent.done && sent.at && thread.lastAt <= sent.at) continue;
      if (!kase.followup || kase.followup.lastAt < thread.lastAt) kase.followup = thread;
    }
  }
  return { readAt: chat.readAt, unmatched };
}

// The first reason a line has no price, in the reviewer's words.
const PLAIN_MISSING = [[/envelope/i, "part size (L × W × H)"], [/weight/i, "part weight"], [/complexity/i, "part complexity"], [/process|cleanliness/i, "cleanliness level"]];
function missingFact(line) {
  const reason = line.calculations?.sq2?.blocked?.[0] || line.calculations?.onlineCalculator?.blocked?.[0] || line.recommendation.uncalculated || "a fact the price needs";
  return PLAIN_MISSING.find(([pattern]) => pattern.test(reason))?.[1] || reason.replace(/\.$/, "");
}

// Where a case sits in the reviewer's day: a price to say yes to, a fact to
// find first, a correction to rebuild, or already decided or sent.
export function caseGroup(kase) {
  if (!kase.open) return kase.tone === "ok" && kase.state.startsWith("Quote sent") ? "sent" : "decided";
  if (kase.tone === "alert") return "facts";
  const priced = kase.lines.every((line) => line.suggested != null || (line.decided && line.decided.choice !== "correction"));
  return priced ? "ready" : "facts";
}

const esc = (value) => escapeHtml(value);

// The page tells one story, top to bottom: what to say yes to, what to find
// out first, what is already out the door, and what has no page yet. Each
// case is one card with its price or its missing fact up front; everything
// else is one click away on the price page.

const localDay = (iso) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso).toLocaleDateString("en-CA");
// Past this many business days a customer's wait is flagged, not just shown.
const WAITING_TOO_LONG = 5;
function dueChip(kase, now) {
  if (kase.dueDate) {
    const days = Math.round((Date.parse(`${localDay(kase.dueDate)}T12:00:00Z`) - Date.parse(`${localDay(now.toISOString())}T12:00:00Z`)) / 86400000);
    if (days < 0) return `<span class="chip alert">Past due · ${day(kase.dueDate)}</span>`;
    if (days === 0) return '<span class="chip alert">Due today</span>';
    if (days === 1) return '<span class="chip warn">Due tomorrow</span>';
    return `<span class="chip muted">Due ${day(kase.dueDate)}</span>`;
  }
  // Red is kept for a due date; a long wait gets a quiet orange dot, not a colour.
  if (kase.open && kase.waitingBusinessDays >= 3) return `<span class="chip muted${kase.waitingBusinessDays >= WAITING_TOO_LONG ? " late" : ""}">${kase.waitingBusinessDays} business days waiting</span>`;
  return "";
}
// Due dates first, then customers chasing (urgent first), then longest waiting.
const chaseRank = (kase) => (kase.followup ? (kase.followup.urgent ? 0 : 1) : 2);
const byUrgency = (a, b) => (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1) || (a.dueDate || "").localeCompare(b.dueDate || "") || chaseRank(a) - chaseRank(b) || (a.askedAt || "").localeCompare(b.askedAt || "");

// "Today", "Yesterday" or the date, in the shop's time zone.
function relativeDay(iso, now) {
  const days = Math.round((Date.parse(`${localDay(now.toISOString())}T12:00:00Z`) - Date.parse(`${localDay(iso)}T12:00:00Z`)) / 86400000);
  return days === 0 ? "today" : days === 1 ? "yesterday" : day(iso);
}
// A ready-to-fill FACTS line per unpriced part, for the quote-prep chat.
function factsTemplates(kase) {
  const parts = [...new Set(kase.lines.filter((line) => line.suggested == null && !line.decided).map((line) => line.partNumber))];
  if (!parts.length) return "";
  return `<div class="mail-row facts-row">${parts.map((part) => { const line = `FACTS ${part}: _ x _ x _ in, _ lb`; return `<button type="button" class="copy-chip above" data-copy="${esc(line)}" data-label="${esc(line)}" title="Copy, fill in and post in the QUOTE PREP TRACKER chat">${ICON.copy}<span>${esc(line)}</span></button>`; }).join("")}</div>`;
}

// Opens the email with the request's attachments; the file names are in the tooltip.
function filesButton(files, className) {
  if (!files) return "";
  const title = `${files.names.length} attachment${files.names.length === 1 ? "" : "s"} in ${files.from}'s email of ${day(files.at)}: ${files.names.join(", ")}`;
  return `<a class="${className}" href="${esc(files.href)}" target="_blank" rel="noopener" title="${esc(title)}">${ICON.attach}Attachments <span class="count-inline">${files.names.length}</span>${onlyTag(files.owner)}</a>`;
}

// The front desk's latest reminder that this customer is chasing.
function chaseChip(followup, now) {
  if (!followup) return "";
  const title = `Front desk, ${when(followup.lastAt)}: ${followup.contact}${followup.company ? ` from ${followup.company}` : ""} is chasing “${followup.subject}”${followup.note ? ` — ${followup.note}` : ""}`;
  return `<span class="chip ${followup.urgent ? "alert" : "muted late"}" title="${esc(title)}">Chasing · ${esc(followup.label.toLowerCase())} ${relativeDay(followup.lastAt, now)}</span>`;
}

// Days from today (shop time) to a due date: negative is past due.
const dueDays = (dueDate, now) => Math.round((Date.parse(`${localDay(dueDate)}T12:00:00Z`) - Date.parse(`${localDay(now.toISOString())}T12:00:00Z`)) / 86400000);
const dueText = (dueDate, now) => { const days = dueDays(dueDate, now); return days < 0 ? `Past due · ${day(dueDate)}` : days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due ${day(dueDate)}`; };
// A due date shown for a row only when it is the row's own request, not a
// same-customer guess.
const ownDue = (item) => (item.monitor && item.monitor.matchedBy !== "customer" ? item.monitor.dueDate : null);

// A row's Done box: this viewer's own mark, kept in the browser. A newer
// message in the thread is a new row, so it comes back.
const rowDone = (key, label) => `<label class="done-check row-done"><input type="checkbox" data-row="${esc(key)}" aria-label="Mark ${esc(label)} done"><span>Done</span></label>`;

// What Claude's mail check says about a message, by who owes the next email.
const MAIL_CHIP = { followup: ["warn", "Chasing"], question: ["warn", "Needs reply"], rfq: ["muted", "New request"], secure: ["alert", "Can't read here · open it"] };
const MAIL_RANK = { secure: 0, followup: 1, question: 2, rfq: 3 };
const byDueThenKind = (now) => (a, b) => {
  const da = ownDue(a), db = ownDue(b);
  return (da ? 0 : 1) - (db ? 0 : 1) || (da && db ? dueDays(da, now) - dueDays(db, now) : 0) || (MAIL_RANK[a.kind] ?? 9) - (MAIL_RANK[b.kind] ?? 9) || Date.parse(b.at) - Date.parse(a.at);
};
const whereItStands = (item, now) => {
  if (!item.monitor) return item.candidates ? `<span class="warn-text">Mail monitor has ${item.candidates} open entries for this customer; none picked</span>` : '<span class="warn-text">No match in the mail monitor</span>';
  const due = item.monitor.matchedBy === "customer" ? null : item.monitor.dueDate;
  const label = item.monitor.matchedBy === "customer" ? "Codex mail monitor, same customer" : "Codex mail monitor";
  return `${esc(item.monitor.status || "no status")}<div class="why-not">${label} · ${esc(item.monitor.reference)}</div>${due ? `<div><span class="chip ${dueDays(due, now) <= 0 ? "alert" : "muted"}">${dueText(due, now)}</span></div>` : ""}`;
};

// Messages Claude's mail check found that no card and no other list here shows.
function mailRowsTable(items, now, title) {
  if (!items.length) return "";
  const rows = [...items].sort(byDueThenKind(now)).map((item) => {
    const [tone, chip] = MAIL_CHIP[item.kind] || ["muted", item.kind];
    const closed = item.closedCase ? `<div class="why-not">Wrote after the ${esc(item.closedCase.customer || item.closedCase.caseId)} page was ${esc(String(item.closedCase.state || "closed").toLowerCase())}</div>` : "";
    const reply = item.reply ? `<div class="why-not">Front desk replied ${esc(when(item.reply.at))}${item.reply.note ? `: ${esc(item.reply.note)}` : ""}, no price yet</div>` : "";
    return `<tr data-row-key="mail:${esc(item.id)}"><td><span class="strong">${esc(item.customerDomain || "—")}</span><div class="why-not">${esc(item.from || "")}</div></td><td>${esc(item.subject || "—")}${item.note ? `<div class="why-not">${esc(item.note)}</div>` : ""}${closed}${reply}${item.link ? `<div><a class="small" href="${esc(item.link)}" target="_blank" rel="noopener">Open email</a></div>` : ""}</td><td class="date"><span class="chip ${tone}">${esc(chip)}</span><div class="why-not">${relativeDay(item.at, now)}</div></td><td class="status-cell">${whereItStands(item, now)}</td><td>${rowDone(`mail:${item.id}`, item.customerDomain || "row")}</td></tr>`;
  }).join("");
  return `<details class="fold" open><summary>${ICON.chevron}<h3>${esc(title)} <small>${items.length}</small></h3></summary><div class="scroll"><table class="queue chase"><thead><tr><th>Customer · sender</th><th>Email subject</th><th>Seen</th><th>Where it stands</th><th><span class="visually-hidden">Done</span></th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

// Customers chasing a request that has no price page yet, as the front desk logged them.
function chasingTable(items, now) {
  const rows = items.map((item) => `<tr class="${item.urgent ? "urgent" : ""}" data-row-key="chat:${esc(item.id)}:${esc(item.lastAt)}"><td><span class="strong">${esc(item.company || "—")}</span><div class="why-not">${esc(item.contact)}</div></td><td>${esc(item.subject || "—")}${item.note ? `<div class="why-not">“${esc(item.note)}”</div>` : ""}${item.email?.link ? `<div><a class="small" href="${esc(item.email.link)}" target="_blank" rel="noopener">Open email</a></div>` : ""}</td><td class="date"><span class="chip ${item.urgent ? "alert" : "muted"}">${esc(item.label)}</span><div class="why-not">${relativeDay(item.lastAt, now)}</div></td><td class="status-cell">${whereItStands(item, now)}</td><td>${rowDone(`chat:${item.id}:${item.lastAt}`, item.company || "row")}</td></tr>`).join("");
  return `<div class="scroll"><table class="queue chase"><thead><tr><th>Company · contact</th><th>What they asked for</th><th>Chased</th><th>Where it stands</th><th><span class="visually-hidden">Done</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Everything due today or past due, whether or not it has a page: the one
// list that has to be empty by the end of the day.
function dueStrip(items, now) {
  const rows = items.map((item) => `<tr><td><span class="strong">${esc(item.customer)}</span><div class="why-not">${esc(item.reference || "")}</div></td><td>${esc(item.where)}</td><td class="date"><span class="chip alert">${dueText(item.dueDate, now)}</span></td><td>${item.href ? `<a class="small" href="${esc(item.href)}"${item.href.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${item.href.startsWith("#") ? "Go to card" : "Open email"}</a>` : ""}</td></tr>`).join("");
  return `<div class="scroll"><table class="queue due"><thead><tr><th>Customer · reference</th><th>Where it is</th><th>Due</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Where each message of the last two weeks landed, for checking the mail check.
function placementTable(placements) {
  const PLACE = { case: "On a card", listed: "In a monitor list here", answered: "Answered", found: "Listed by itself", old: "Older than two weeks", "sent-mark": "Marked a page sent", unattached: "Quote not tied to a page", "by-design": "Kept, not shown" };
  const rows = [...placements].sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at)).map(({ event, place, detail }) => `<tr><td class="date">${esc(when(event.at))}</td><td>${esc(event.kind)}</td><td><span class="strong">${esc(event.customerDomain || "—")}</span><div class="why-not">${esc(event.subject || "")}</div></td><td>${esc(PLACE[place] || place)}<div class="why-not">${esc(detail || "")}</div></td></tr>`).join("");
  return `<div class="scroll"><table class="queue"><thead><tr><th>Seen</th><th>Kind</th><th>Customer · subject</th><th>Where it landed</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// One plain line on what Claude's last mail check searched and found.
function claudeRunLine(view) {
  if (!view) return "";
  const run = view.run;
  if (!run) return `<p class="runline">Claude mail check reached ${esc(when(view.cutoff))}.</p>`;
  const kept = run.keptByKind || {};
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    kept.rfq ? plural(kept.rfq, "new request", "new requests") : "",
    (kept.followup || 0) + (kept.question || 0) ? plural((kept.followup || 0) + (kept.question || 0), "customer message", "customer messages") : "",
    kept.secure ? plural(kept.secure, "unreadable message", "unreadable messages") : "",
    kept.ack ? plural(kept.ack, "front-desk reply", "front-desk replies") : "",
    kept["quote-sent"] ? plural(kept["quote-sent"], "quote sent", "quotes sent") : "",
  ].filter(Boolean);
  const sources = view.failed.length ? `<span class="warn-text">could not search ${esc(view.failed.join(", "))}</span>` : `${mailSources().length} sources searched`;
  return `<p class="runline">Claude mail check ${esc(when(run.finishedAt || run.runStart))} · ${sources} · ${parts.length ? esc(parts.join(", ")) : "nothing new"}</p>`;
}

// A mail-check message on a card: the customer wrote since the page was built.
function mailChip(kase, now) {
  const mail = kase.mailChase;
  if (!mail || (kase.followup && Date.parse(kase.followup.lastAt) >= Date.parse(mail.at))) return "";
  const [tone, label] = mail.kind === "rfq" ? ["muted late", "Customer wrote"] : MAIL_CHIP[mail.kind] || ["muted", "Customer wrote"];
  const title = `Claude's mail check, ${when(mail.at)}: ${mail.from || mail.customerDomain} — “${mail.subject}”${mail.note ? ` (${mail.note})` : ""}`;
  return `<span class="chip ${tone === "warn" ? "muted late" : tone}" title="${esc(title)}">${esc(label)} · ${relativeDay(mail.at, now)}</span>`;
}

const LINE_LIMIT = 4;
const linePrice = (line) => (line.decided && line.decided.choice !== "correction" ? line.decided.unitPrice : line.suggested);
function linesTable(kase) {
  const rows = kase.lines.map((line, index) => {
    const decided = line.decided && line.decided.choice !== "correction" ? line.decided : null;
    const unit = linePrice(line);
    const matchesSuggestion = !decided || decided.unitPrice === line.suggested;
    const total = line.lotCharge != null && matchesSuggestion ? line.lotCharge : unit == null ? null : Math.round(unit * line.quantity * 100) / 100;
    const from = decided ? `<span class="chip ok">${ICON.check}${esc(decided.choice)}</span>` : line.source ? `<span class="${line.source.kind === "method" ? "muted" : "dated"}">${esc(line.source.text)}</span>` : `<span class="needs">needs ${esc(line.missing || "facts")}</span>`;
    const samePart = index > 0 && kase.lines[index - 1].partNumber === line.partNumber;
    return `<tr><td class="pn">${samePart ? "" : esc(line.partNumber)}</td><td class="num">${line.quantity}</td><td class="num strong">${usd(unit)}</td><td class="num">${usd(total)}${line.lotCharge != null && matchesSuggestion ? '<span class="note">lot minimum</span>' : ""}</td><td class="from">${from}</td></tr>`;
  });
  const shown = rows.slice(0, LINE_LIMIT).join("");
  const more = rows.length > LINE_LIMIT ? `<tr class="more"><td colspan="5">+ ${rows.length - LINE_LIMIT} more line${rows.length - LINE_LIMIT === 1 ? "" : "s"} on the price page</td></tr>` : "";
  return `<div class="scroll"><table class="lines"><colgroup><col class="c-part"><col class="c-qty"><col class="c-unit"><col class="c-total"><col class="c-from"></colgroup><thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th><th>Price from</th></tr></thead><tbody>${shown}${more}</tbody></table></div>`;
}

function partsSummary(kase) {
  const quantities = [...new Set(kase.lines.map((line) => line.quantity))];
  const qty = quantities.length === 1 ? `${quantities[0]} pcs${kase.partNumbers.length > 1 ? " each" : ""}` : `qty ${Math.min(...quantities)}–${Math.max(...quantities)}`;
  const parts = kase.partNumbers.length > 3 ? `${kase.partNumbers.slice(0, 3).join(", ")} + ${kase.partNumbers.length - 3} more` : kase.partNumbers.join(", ");
  return `${esc(parts)} · ${qty}`;
}

// The one thing to decide, set against the customer's name: the price, or
// what is missing before there can be one.
function headline(kase, group) {
  const lines = `${kase.lines.length} line${kase.lines.length === 1 ? "" : "s"}`;
  if (group === "facts") {
    if (kase.tone === "alert") return `<div class="headline needs"><span class="big">Correction requested</span><span class="sub">rebuild before pricing</span></div>`;
    const blocked = kase.lines.filter((line) => linePrice(line) == null);
    const facts = [...new Set(blocked.map((line) => line.missing).filter(Boolean))];
    return `<div class="headline needs"><span class="big">Needs ${esc(facts.join(", ") || "facts")}</span><span class="sub">${blocked.length} of ${lines} unpriced</span></div>`;
  }
  const prices = kase.lines.map(linePrice).filter((price) => price != null);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const status = group === "sent" ? "quote sent" : group === "decided" ? "decided" : "per piece";
  return `<div class="headline"><span class="big">${low === high ? usd(low) : `${usd(low)}–${usd(high)}`}</span><span class="sub">${status} · ${lines}</span></div>`;
}

// The sender's address and the subject, each copied with one click (the card's
// own link covers the rest of the card, so plain text there can't be selected).
function mailRow(email) {
  const chip = (text, shown, title, extra = "") => `<button type="button" class="copy-chip above${extra}" data-copy="${esc(text)}" data-label="${esc(shown)}" title="${esc(title)}">${ICON.copy}<span>${esc(shown)}</span></button>`;
  const parts = [
    email?.from ? chip(email.from, email.from, `Copy email address${email.fromName ? ` (${email.fromName})` : ""}`) : "",
    email?.subject ? chip(email.subject, email.subject, "Copy subject", " subject") : "",
  ].filter(Boolean);
  return parts.length ? `<div class="mail-row">${parts.join("")}</div>` : "";
}

// What the quote could be worth, for the Highest value sort and the card chip:
// a multi-part RFQ is the whole PO (every priced line, lot minimum as the
// floor); a one-part RFQ quoted at several quantities is its largest tier.
// Decided prices count over suggested ones. Null when nothing is priced.
export function potentialValue(decision, view) {
  const priceOf = (line) => {
    const recorded = view?.current.get(line.lineId);
    const decided = recorded && recorded.choice !== "correction" ? recorded : null;
    return decided?.unitPrice ?? line.recommendation.preferred?.unitPrice ?? null;
  };
  const po = poTotal(decision, view);
  if (po) {
    const counted = decision.lines.filter((line) => decision.poLotMinimum.lineIds.includes(line.lineId));
    if (counted.every((line) => priceOf(line) == null)) return null;
    return { amount: po.charge, kind: "po", partial: po.unpriced.length > 0 };
  }
  const tiers = decision.lines.map((line) => {
    const unit = priceOf(line);
    if (unit == null) return null;
    return Math.max(Math.round(unit * line.request.quantity * 100) / 100, line.recommendation.lotMinimum?.minimum ?? 0);
  }).filter((amount) => amount != null);
  if (!tiers.length) return null;
  return { amount: Math.max(...tiers), kind: decision.lines.length > 1 ? "tiers" : "single", partial: tiers.length < decision.lines.length };
}

function valueChip(value) {
  if (!value) return "";
  const amount = `$${Math.round(value.amount).toLocaleString("en-US")}`;
  const text = value.kind === "tiers" ? `up to ${amount}` : `${amount} potential`;
  const title = value.kind === "po" ? "Whole PO at the decided or suggested prices, lot minimum as the floor" : value.kind === "tiers" ? "Largest quantity tier at its decided or suggested price" : "Quantity times the decided or suggested price, lot minimum as the floor";
  return `<span class="chip muted value-chip" title="${title}${value.partial ? "; some lines not priced yet" : ""}">${text}${value.partial ? "+" : ""}</span>`;
}

// Sort key for the board's confidence sorts: High 3, Medium 2, Low 1, and 0
// when any line has no price yet (those always sort last).
export function confidenceRank(kase) {
  if ((kase.lines || []).some((line) => line.suggested == null && !line.decided)) return 0;
  return { High: 3, Medium: 2, Low: 1 }[kase.confidence?.level] || 0;
}

function caseCard(kase, now) {
  const group = caseGroup(kase);
  const notes = [
    kase.monitorAmbiguous.length ? `Monitor link unresolved: ${kase.monitorAmbiguous.length} entries match (${esc(kase.monitorAmbiguous.join("; "))})` : "",
    kase.open && kase.staleSnapshot ? `Priced on ${esc(kase.priceSnapshot)}; newer Router History is in. Ask to rebuild.` : "",
  ].filter(Boolean);
  const open = group === "ready" || group === "facts";
  return `<article class="card is-${group}" id="case-${esc(kase.caseId)}" data-page="${esc(kase.page)}" data-case="${esc(kase.caseId)}" data-asked="${esc(kase.askedAt || "")}" data-confidence="${confidenceRank(kase)}" data-value="${kase.value ? kase.value.amount : -1}">
    <div class="card-head">
      <div class="card-title">
        <a class="card-link" href="${esc(kase.page)}">${esc(kase.customer)}</a>
        <p class="ref">${esc(kase.reference || kase.caseId)}</p>
        <p class="marks">${open ? progressHtml(kase.progress, { compact: true }) : ""}${kase.askedAt ? `<span class="chip muted">Asked ${day(kase.askedAt)}</span>` : ""}${valueChip(kase.value)}${dueChip(kase, now)}${chaseChip(kase.followup, now)}${mailChip(kase, now)}<span class="chip ok done-mark">${ICON.check}Done</span><span class="chip muted opened-mark">${ICON.check}Opened</span></p>
      </div>
      ${headline(kase, group)}
    </div>
    ${open ? "" : progressHtml(kase.progress)}
    ${group === "facts" ? `<p class="parts">${partsSummary(kase)}</p>${factsTemplates(kase)}${kase.files ? `<p class="files-note">${ICON.attach}<span>The missing facts may be in ${kase.files.names.length === 1 ? "this file" : `these ${kase.files.names.length} files`}: ${kase.files.names.map((name) => `<b>${esc(name)}</b>`).join(", ")}</span></p>` : ""}` : linesTable(kase)}
    ${notes.map((note) => `<p class="hint">${ICON.alert}<span>${note}</span></p>`).join("")}
    ${mailRow(kase.email)}
    <div class="card-foot">
      <label class="done-check above"><input type="checkbox" class="done-box" aria-label="Mark ${esc(kase.customer)} done"><span>Done</span></label>
      <span class="spacer"></span>
      ${kase.rfqLink ? `<a class="btn ghost above" href="${esc(kase.rfqLink)}" target="_blank" rel="noopener">Open RFQ email${onlyTag(kase.rfqOwner)} ${ICON.external}</a>` : ""}
      ${filesButton(kase.files, "btn ghost above")}
      ${kase.latestLink ? `<a class="btn ghost above" href="${esc(kase.latestLink.href)}" target="_blank" rel="noopener" title="Newest message in the thread${kase.latestLink.actor ? `, from ${esc(kase.latestLink.actor)}` : ""}, ${esc(String(kase.latestLink.at).slice(0, 10))}">Latest reply${onlyTag(kase.latestLink.owner)} ${ICON.external}</a>` : ""}
      <span class="go">Price page ${ICON.chevron}</span>
    </div>
  </article>`;
}

const senderHtml = (email) => (email?.from ? `${email.fromName ? `<span class="strong">${esc(email.fromName)}</span><div class="why-not">${esc(email.from)}</div>` : esc(email.from)}` : '<span class="muted">not looked up</span>');

function monitorTable(items, title, now) {
  if (!items.length) return "";
  // Opens by itself when it holds something due today or past due.
  const urgent = items.some((item) => item.dueDate && dueDays(item.dueDate, now) <= 0);
  const rows = items.map((item) => `<tr><td><span class="strong">${esc(item.customer)}</span><div class="why-not">${esc(item.reference)}</div></td><td>${senderHtml(item.email)}</td><td>${item.email?.subject ? esc(item.email.subject) : '<span class="muted">not looked up</span>'}${item.rfqLink ? `<div><a class="small" href="${esc(item.rfqLink)}" target="_blank" rel="noopener">Open RFQ email</a></div>` : ""}</td><td class="status-cell">${esc(item.status)}</td><td class="date">${item.lastActivityAt ? day(item.lastActivityAt) : "unknown"}${item.dueDate ? `<div class="why-not">Due ${day(item.dueDate)} · ${esc(item.dueBasis ?? "basis not stated")}</div>` : ""}</td></tr>`).join("");
  return `<details class="fold"${urgent ? " open" : ""}><summary>${ICON.chevron}<h3>${esc(title)} <small>${items.length}</small></h3></summary><div class="scroll"><table class="queue"><thead><tr><th>Company · reference</th><th>Sender</th><th>Email subject</th><th>Monitor status</th><th>Last activity</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

const KIND_TONE = { ruling: "warn", decision: "ok", sent: "ok", correction: "alert", priced: "muted", commit: "muted", build: "muted", review: "muted", note: "muted" };

// Method reviews that share a case, verdict and note read as one entry.
function feedbackList(feedback) {
  const groups = new Map();
  for (const entry of feedback) {
    const verdict = entry.type === "method-review" ? entry.verdict : "correction";
    const key = [entry.caseId, verdict, entry.version, entry.note || ""].join("|");
    if (!groups.has(key)) groups.set(key, { ...entry, verdict, lines: [] });
    groups.get(key).lines.push(entry.lineId);
  }
  return `<ul class="feedback">${[...groups.values()].map((entry) => `<li><span class="chip ${entry.verdict === "ok" ? "ok" : "alert"}">${entry.verdict === "ok" ? `${ICON.check}method ok` : entry.verdict === "wrong" ? "method wrong" : "correction"}</span><div><span class="strong">${esc(entry.caseId)} ${esc(entry.lines.join(", "))}</span> <span class="muted small">v${entry.version}${entry.field ? ` · ${esc(entry.field)}` : ""} · ${esc(entry.decidedBy)}, ${day(entry.decidedAt)}</span>${entry.note ? `<p>${esc(entry.note)}</p>` : ""}</div></li>`).join("")}</ul>`;
}

function historyTable(history) {
  const row = (item) => `<tr><td class="date">${day(item.at)}</td><td><span class="chip ${KIND_TONE[item.kind] || "muted"}">${esc(item.kind)}</span></td><td>${esc(item.text)}</td></tr>`;
  return `<div class="scroll"><table><thead><tr><th>Date</th><th>Kind</th><th>What happened</th></tr></thead><tbody>${history.slice(0, 40).map(row).join("")}</tbody></table></div>${history.length > 40 ? `<p class="muted small">${history.length - 40} older entries are in the records.</p>` : ""}`;
}

function section(id, title, count, lede, body) {
  return `<section id="${id}" class="group" aria-labelledby="${id}-title">
    <div class="group-head"><h2 id="${id}-title">${esc(title)}</h2><span class="count">${count}</span></div>
    ${lede ? `<p class="lede">${lede}</p>` : ""}
    ${body}
  </section>`;
}

export function renderBoard(board, { badge = null } = {}) {
  const now = new Date(board.generatedAt);
  const grouped = { ready: [], facts: [], decided: [], sent: [] };
  for (const kase of board.cases) grouped[caseGroup(kase)].push(kase);
  for (const list of Object.values(grouped)) list.sort(byUrgency);
  const closed = [...grouped.decided, ...grouped.sent];
  const feedback = board.cases.flatMap((kase) => kase.feedback);
  const monitor = board.monitor;
  const sync = board.lastSync;
  const rejected = (sync?.imports || []).filter((item) => item.outcome !== "accepted" && item.outcome !== "replay-noop" && item.outcome !== "archived-older");
  const claude = board.claudeMail;
  const alerts = [
    ...(monitor?.stale ? [`Codex mail monitor data is STALE: its last successful check was ${monitor.cutoff ? when(monitor.cutoff) : "never recorded"}. The "No page yet" and "Quote still owed" lists and its quote-sent marks may be out of date.${claude?.fresh ? ` Claude's mail check is current (${when(claude.cutoff)}) and still adds what it finds.` : ""}`] : []),
    ...(claude?.stale ? [`Claude's mail check last reached ${claude.cutoff ? when(claude.cutoff) : "no time recorded"}: its hourly runs may have stopped. Check the qpc-claude-mail-check task's runs.`] : []),
    ...(claude?.run && claude.failed.length ? [`Claude's last mail check (${when(claude.run.finishedAt || claude.run.runStart)}) could not search ${claude.failed.join(", ")}; its cutoff was held, so the next run searches that time again.`] : []),
    ...rejected.map((item) => item.outcome === "not-downloaded"
      ? `Router History export ${item.fileName} is in OneDrive but not downloaded to this Mac, so the background sync can't read it. Open the ROUTER HISTORY folder in Finder (or set it to "Always Keep on This Device"), or ask Claude to import it. Prices still use the last good snapshot.`
      : `Router History export ${item.fileName} was ${item.outcome}${item.failures.length ? ` (${item.failures.join(", ")})` : ""}. Prices still use the last good snapshot.`),
    ...(sync?.errors || []).map((error) => `Sync error: ${error}`),
  ];
  const openCount = grouped.ready.length + grouped.facts.length;
  const pill = alerts.length ? ["alert", "Needs attention"] : openCount ? ["warn", `${openCount} waiting on you`] : ["ok", "Nothing waiting"];
  const unpricedAll = monitor ? monitor.withoutPage : [];
  const mailFound = board.mailFound || [];
  const mailChases = mailFound.filter((item) => item.kind === "followup" || item.kind === "question");
  const mailAll = mailFound.filter((item) => !mailChases.includes(item));
  // Items a session checked and set aside stay listed, folded, with the reason;
  // new activity after the check brings one back.
  const checked = (key, lastAt) => { const entry = (board.triage || {})[key]; return entry && (!lastAt || String(lastAt) <= String(entry.at)) ? entry : null; };
  const setAside = [];
  const keep = (item, key, lastAt, customer, reference) => { const entry = checked(key, lastAt); if (!entry) return true; setAside.push({ customer, reference, lastAt, reason: entry.reason, group: triageGroup(entry.reason) }); return false; };
  const mailNew = mailAll.filter((item) => keep(item, `mail|${item.customerDomain}|${String(item.subject).replace(/^(re|fw|fwd):\s*/gi, "")}`, item.at, item.customerDomain, item.subject));
  const unpriced = unpricedAll.filter((item) => keep(item, `monitor|${item.customer}|${item.reference}`, item.lastActivityAt, item.customer, item.reference));
  const owed = (monitor?.owed || []).filter((item) => keep(item, `monitor|${item.customer}|${item.reference}`, item.lastActivityAt, item.customer, item.reference));
  // Due today or past due, from every source: cards, mail-check rows, and
  // the monitor's lists without a page.
  const dueItems = [
    ...[...grouped.ready, ...grouped.facts].filter((kase) => kase.dueDate).map((kase) => ({ customer: kase.customer, reference: kase.reference || kase.caseId, dueDate: kase.dueDate, where: caseGroup(kase) === "ready" ? "Ready for your yes" : "Needs facts first", href: `#case-${kase.caseId}` })),
    ...mailFound.filter(ownDue).map((item) => ({ customer: item.monitor.customer || item.customerDomain, reference: item.monitor.reference, dueDate: ownDue(item), where: `No page yet · ${(MAIL_CHIP[item.kind] || ["", item.kind])[1]} (Claude's mail check)`, href: item.link })),
    ...unpriced.filter((item) => item.dueDate && item.pricing).map((item) => ({ customer: item.customer, reference: item.reference, dueDate: item.dueDate, where: "No page yet (Codex mail monitor)", href: item.rfqLink })),
    ...owed.filter((item) => item.dueDate).map((item) => ({ customer: item.customer, reference: item.reference, dueDate: item.dueDate, where: "Quote still owed (Codex mail monitor)", href: item.rfqLink })),
  ].filter((item) => dueDays(item.dueDate, now) <= 0).sort((a, b) => dueDays(a.dueDate, now) - dueDays(b.dueDate, now));
  const pastDue = dueItems.filter((item) => dueDays(item.dueDate, now) < 0).length;
  const dueToday = dueItems.length - pastDue;
  const chasingOpen = [...grouped.ready, ...grouped.facts].filter((kase) => kase.followup || mailChip(kase, now));
  const chasingNoPage = board.chasing?.unmatched || [];
  // One count of customers chasing, the same in the header and the tab: each
  // card once, each front-desk thread once, each emailed chase once.
  const chasingCount = new Set([...chasingOpen.map((kase) => `case:${kase.caseId}`), ...chasingNoPage.map((thread) => `chat:${thread.id}`), ...mailChases.map((item) => `mail:${item.customerDomain}|${subjectKey(item.subject)}`)]).size;
  const chasingNoPageCount = chasingNoPage.length + mailChases.length;
  const chaseTarget = chasingOpen.find((kase) => kase.followup?.urgent) || chasingOpen[0];
  const summary = [
    grouped.ready.length ? `<a class="n-ready" href="#ready"><b>${grouped.ready.length}</b> ready for your yes</a>` : "",
    grouped.facts.length ? `<a class="n-facts" href="#facts"><b>${grouped.facts.length}</b> need facts first</a>` : "",
    pastDue ? `<a class="due-now" href="#due">${pastDue} past due</a>` : "",
    dueToday ? `<a class="due-now" href="#due">${dueToday} due today</a>` : "",
    chasingCount ? `<a class="chasing-now" href="${chasingNoPageCount ? "#chasing" : `#case-${esc(chaseTarget.caseId)}`}">${chasingCount} customer${chasingCount === 1 ? "" : "s"} chasing</a>` : "",
  ].filter(Boolean).join('<span class="sep">·</span>') || "Nothing waiting on you.";
  const tabs = [["due", "Due now", dueItems.length], ["ready", "Ready", grouped.ready.length], ["facts", "Needs facts", grouped.facts.length], ["chasing", "Chasing", chasingNoPageCount], ["closed", "Decided & sent", closed.length], ["unpriced", "No page yet", unpriced.length + mailNew.length], ["owed", "Quote owed", owed.length], ["log", "Log", null]]
    .filter(([id, , count]) => count !== 0 && (id !== "unpriced" || monitor || mailNew.length) && (id !== "owed" || owed.length) && (id !== "due" || dueItems.length));
  const recentPlacements = (board.mailPlacements || []).filter((item) => item.place !== "old");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RFQ Pricing Board</title>
${badge ? `<link rel="icon" type="image/svg+xml" href="${badge}">` : ""}
<style>
${STYLE}
${BOARD_STYLE}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="who">${badge ? `<img class="badge" src="${badge}" alt="" width="24" height="24">` : ""}<span class="customer">RFQ pricing</span><span class="sep">·</span><span>QPC</span></div>
    <span class="pill ${pill[0]}">${esc(pill[1])}</span>
  </div>
  <nav class="tabs" aria-label="Sections">${tabs.map(([id, label, count]) => `<a href="#${id}">${esc(label)}${count ? ` <small>${count}</small>` : ""}</a>`).join("")}</nav>
</header>
<main>
  <div class="intro">
    <div id="board-stale" class="status alert" hidden></div>
    ${alerts.map((alert) => `<div class="status alert">${esc(alert)}</div>`).join("")}
    <p class="eyebrow">QPC · RFQ pricing</p>
    <h1 class="summary">${summary}</h1>
    ${claudeRunLine(claude)}
    <div class="sortbar" role="group" aria-label="Sort the cards"><span>Sort</span><button type="button" data-sort="urgent" aria-pressed="true">Most urgent</button><button type="button" data-sort="newest" aria-pressed="false">Newest first</button><button type="button" data-sort="oldest" aria-pressed="false">Oldest first</button><button type="button" data-sort="confident" aria-pressed="false">Most confident</button><button type="button" data-sort="unsure" aria-pressed="false">Least confident</button><button type="button" data-sort="value" aria-pressed="false">Highest value</button></div>
  </div>

  ${dueItems.length ? section("due", "Due now", dueItems.length, "Due today or past due, with a page or without one. Each should have a quote or an answer before the day ends.", dueStrip(dueItems, now)) : ""}

  ${grouped.ready.length ? section("ready", "Ready for your yes", grouped.ready.length, "Each has a suggested price. Click a card to open its price page, then approve it or give yours.", `<div class="cards">${grouped.ready.map((kase) => caseCard(kase, now)).join("")}</div>`) : ""}

  ${grouped.facts.length ? section("facts", "Needs facts first", grouped.facts.length, "No price until the missing fact is in. Open the attachments or ask the customer, then post the size in the QUOTE PREP TRACKER chat as <b>FACTS part-number: L x W x H in, weight lb</b> (copy the line on each card). Claude reprices the page within the hour.", `<div class="cards">${grouped.facts.map((kase) => caseCard(kase, now)).join("")}</div>`) : ""}

  ${openCount ? "" : `<p class="empty">${ICON.check}<span>Nothing waiting. Every priced RFQ has a decision.</span></p>`}

  ${chasingNoPageCount ? section("chasing", "Customers chasing, no price page", chasingNoPageCount, "Follow-ups from the last two weeks with no price page: logged by the front desk in the quote-prep chat, or found in customer email by Claude's mail check. Ask Claude to price any of them.", `${chasingNoPage.length ? chasingTable(chasingNoPage, now) : ""}${mailRowsTable(mailChases, now, "From customer email (Claude's mail check)")}`) : ""}

  ${closed.length ? section("closed", "Decided & sent", closed.length, "", `<details class="fold"><summary>${ICON.chevron}<h3>Show ${closed.length}</h3></summary><div class="cards">${closed.map((kase) => caseCard(kase, now)).join("")}</div></details>`) : ""}

  ${(monitor && unpriced.length) || mailNew.length || setAside.length ? section("unpriced", "No price page yet", unpriced.length + mailNew.length, unpriced.length + mailNew.length ? "Open in the mail with no page here; ask Claude to price any of them." : `Nothing here needs pricing. ${setAside.length} item${setAside.length === 1 ? " was" : "s were"} checked and ${setAside.length === 1 ? "is" : "are"} not a price request (below).`, `${mailRowsTable(mailNew, now, "Found by Claude's mail check, not listed elsewhere here")}${monitorTable(unpriced.filter((item) => item.pricing), "Status mentions a quote, RFQ or inquiry", now)}${monitorTable(unpriced.filter((item) => !item.pricing), "Status doesn't say (may be a follow-up or an RFQ)", now)}${notPricedTable(setAside, now)}`) : ""}

  ${owed.length ? section("owed", "Acknowledged, quote still owed", owed.length, "The Codex mail monitor saw each of these customers get a reply but no price. Oldest first. Ask Claude to price any of them, or tell it which are not pricing work.", monitorTable(owed, `Show ${owed.length}`, now)) : ""}

  <section id="log" class="group" aria-labelledby="log-title">
    <div class="group-head"><h2 id="log-title">Log</h2></div>
    <details class="fold" id="feedback"><summary>${ICON.chevron}<h3>Method feedback <small>${feedback.length}</small></h3></summary>${feedback.length ? feedbackList(feedback) : `<p class="muted">No method reviews recorded yet. Add <code>; method ok</code> or <code>; method wrong why: …</code> to an answer.</p>`}</details>
    ${recentPlacements.length ? `<details class="fold" id="mail-placement"><summary>${ICON.chevron}<h3>Where each checked email landed <small>${recentPlacements.length}</small></h3></summary>${placementTable(recentPlacements)}</details>` : ""}
    ${board.history.length ? `<details class="fold" id="history"><summary>${ICON.chevron}<h3 id="history-title">History <small>${board.history.length}</small></h3></summary>${historyTable(board.history)}</details>` : ""}
  </section>

  <footer class="fresh">${badge ? `<img class="badge" src="${badge}" alt="" width="20" height="20">` : ""}<span>
    ${monitor ? `<span class="${monitor.stale ? "stale" : ""}">Mail checked ${when(monitor.cutoff)} (Codex mail monitor)</span>${claude?.cutoff ? ` · <span class="${claude.stale ? "stale" : ""}">${when(claude.cutoff)} (Claude mail check)</span>` : ""}${monitor.report ? ` · <a href="${esc(monitor.report)}">latest check</a>` : ""} · ` : ""}${sync ? `synced ${when(sync.at)}${sync.imports.length ? ` (imported ${sync.imports.map((item) => `${esc(item.fileName)} ${esc(item.outcome)}`).join(", ")})` : ""}` : "no sync has run yet"}
${board.chasing ? ` · front desk chat read ${when(board.chasing.readAt)}` : ""}${board.codeVersion ? ` · board code ${esc(board.codeVersion)}` : ""}
    <br>Private working file · keep inside QPC</span>
  </footer>
</main>
<div class="toast" role="status" aria-live="polite">${ICON.check}<span>Copied to clipboard</span></div>
<script>
// Checked when the page is opened, so a board nothing has rebuilt still says so.
(() => {
  const generated = Date.parse(${JSON.stringify(board.generatedAt)});
  const minutes = (Date.now() - generated) / 60000;
  if (minutes > ${BOARD_STALE_MINUTES}) {
    const banner = document.getElementById("board-stale");
    banner.textContent = "This board has not refreshed for " + Math.round(minutes / 60) + " hours (built " + new Date(generated).toLocaleString() + "). The pricing sync or this Mac may have stopped; do not rely on it until it refreshes.";
    banner.hidden = false;
  }
})();
${SCRIPT}
// Marks the price pages this viewer has opened, so progress down the list shows.
// A per-viewer convenience: the board reads the same without it.
(() => {
  const key = "qpc-board-opened";
  let opened = [];
  try { opened = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
  const mark = () => document.querySelectorAll(".card[data-page]").forEach((card) => card.classList.toggle("opened", opened.includes(card.dataset.page)));
  document.addEventListener("click", (event) => {
    const card = event.target.closest(".card-link")?.closest(".card");
    if (!card || opened.includes(card.dataset.page)) return;
    opened = [...opened, card.dataset.page].slice(-200);
    try { localStorage.setItem(key, JSON.stringify(opened)); } catch {}
    mark();
  });
  mark();
})();
// Done marks and the sort order are this viewer's own, kept in this browser
// by RFQ (so a rebuilt page keeps them). Done cards sink to the bottom of their
// group. The board reads the same without them.
(() => {
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const DONE = "qpc-board-notes", SORT = "qpc-board-sort";
  const marks = read(DONE, {});
  let sort = read(SORT, "urgent");
  const cards = [...document.querySelectorAll(".card[data-case]")];
  cards.forEach((card, index) => { card.dataset.order = index; });
  const byAsked = (a, b) => (a.dataset.asked || "").localeCompare(b.dataset.asked || "");
  // Confidence: High 3, Medium 2, Low 1; 0 = a line still has no price, always last.
  const rank = (card) => Number(card.dataset.confidence || 0);
  const byConfidence = (direction) => (a, b) => (rank(a) === 0) - (rank(b) === 0) || direction * (rank(b) - rank(a)) || a.dataset.order - b.dataset.order;
  const order = { urgent: (a, b) => a.dataset.order - b.dataset.order, newest: (a, b) => byAsked(b, a), oldest: byAsked, confident: byConfidence(1), unsure: byConfidence(-1),
    // Highest value first; cards with nothing priced (-1) last.
    value: (a, b) => Number(b.dataset.value) - Number(a.dataset.value) || a.dataset.order - b.dataset.order };
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Cards glide to their new place (first/last/invert/play) so the eye can follow.
  const arrange = (animate = true) => {
    const before = new Map(cards.map((card) => [card, card.getBoundingClientRect().top]));
    for (const list of document.querySelectorAll(".cards")) {
      const items = [...list.children].filter((el) => el.matches(".card"));
      items.sort((a, b) => a.classList.contains("done") - b.classList.contains("done") || (order[sort] || order.urgent)(a, b) || a.dataset.order - b.dataset.order);
      items.forEach((el) => list.appendChild(el));
    }
    if (animate && !still) for (const card of cards) {
      const moved = before.get(card) - card.getBoundingClientRect().top;
      if (Math.abs(moved) > 1 && card.offsetParent) card.animate([{ transform: "translateY(" + moved + "px)" }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.7,.2,1)" });
    }
    document.querySelectorAll(".sortbar button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.sort === sort)));
  };
  for (const card of cards) {
    const id = card.dataset.case, box = card.querySelector(".done-box");
    const show = () => { card.classList.toggle("done", Boolean(marks[id]?.done)); box.checked = Boolean(marks[id]?.done); };
    box.addEventListener("change", () => {
      if (box.checked) marks[id] = { done: true, at: new Date().toISOString() }; else delete marks[id];
      write(DONE, marks); show(); arrange();
      window.qpcToast?.(box.checked ? "Marked " + (card.querySelector(".card-link")?.textContent || "RFQ") + " done" : "Moved back to waiting");
    });
    show();
  }
  document.querySelectorAll(".sortbar button").forEach((button) => button.addEventListener("click", () => { sort = button.dataset.sort; write(SORT, sort); arrange(); }));
  arrange(false);
  // Rows in the mail and chasing tables take a Done mark too; a done row greys
  // out and moves to the bottom of its table until a newer message replaces it.
  for (const box of document.querySelectorAll("input[data-row]")) {
    const row = box.closest("tr"), id = box.dataset.row;
    const show = () => {
      box.checked = Boolean(marks[id]?.done);
      row.classList.toggle("done", box.checked);
      if (box.checked) row.parentElement.appendChild(row);
    };
    box.addEventListener("change", () => {
      if (box.checked) marks[id] = { done: true, at: new Date().toISOString() }; else delete marks[id];
      write(DONE, marks); show();
      window.qpcToast?.(box.checked ? "Marked done" : "Moved back");
    });
    show();
  }
})();
</script>
</body>
</html>`;
}

const BOARD_STYLE = `
/* Board tokens. Brand gold marks a price ready for a yes (graphics use --gold;
   text uses --gold-text, darker on light and brighter on dark). Attention is
   orange, set apart from the gold so each colour keeps one meaning. */
:root { --gold:#C9A34D; --gold-text:#7d6427; --warn:#b45309; --warn-bg:#fdf0e4; --hover:color-mix(in srgb, var(--surface) 96%, var(--ink)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --gold-text:#d9b96a; --warn:#f0a066; --warn-bg:#2b1d12; --hover:color-mix(in srgb, var(--surface) 93%, var(--ink)); } }
:root[data-theme="dark"] { --gold-text:#d9b96a; --warn:#f0a066; --warn-bg:#2b1d12; --hover:color-mix(in srgb, var(--surface) 93%, var(--ink)); }

main { gap:var(--s8); }
.topbar { border-top:2px solid var(--gold); }
.who { align-items:center; }
.who .badge { width:24px; height:24px; flex:none; }
.tabs a small { color:var(--ink-3); font-weight:600; margin-left:2px; }

.intro { gap:var(--s2); }
.intro .eyebrow { color:var(--gold-text); }
h1.summary { font-size:24px; font-weight:650; letter-spacing:-.02em; line-height:1.3; color:var(--ink-2); display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--s1) var(--s3); }
h1.summary a { color:var(--ink); text-decoration:none; border-bottom:1px solid var(--line-2); transition:border-color .15s; }
h1.summary a:hover { border-bottom-color:currentColor; }
h1.summary .n-ready b { color:var(--gold-text); } h1.summary .n-facts b { color:var(--warn); }
h1.summary .chasing-now { color:var(--warn); border-bottom-color:color-mix(in srgb, var(--warn) 40%, transparent); }
table.chase tr.urgent td:first-child { box-shadow:inset 3px 0 0 var(--alert); }
.warn-text { color:var(--warn); font-weight:600; }
/* A section never grows to its widest table: tables scroll inside their own box. */
.group > *, details.fold, details.fold > * { min-width:0; max-width:100%; }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.runline { font-size:13px; color:var(--ink-3); margin:var(--s1) 0 0; }
.row-done { font-size:12px; color:var(--ink-3); white-space:nowrap; display:inline-flex; gap:4px; align-items:center; }
table.queue tr.done td { opacity:.5; }
table.due td:first-child { box-shadow:inset 3px 0 0 var(--alert); }
table.due td:last-child, table.queue td:last-child .row-done { white-space:nowrap; }
h1.summary .due-now { color:var(--alert); border-bottom-color:color-mix(in srgb, var(--alert) 40%, transparent); }
.chip.late::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--warn); }
.card { scroll-margin-top:120px; }
.card:target { animation:card-flash 1.6s ease-out; }
@keyframes card-flash { 0%, 30% { border-color:var(--alert); box-shadow:0 0 0 3px color-mix(in srgb, var(--alert) 25%, transparent); } 100% { box-shadow:0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .card:target { animation:none; border-color:var(--alert); } }
h1.summary .sep { color:var(--line-2); font-weight:400; }

.group { display:grid; gap:var(--s3); }
.group-head { display:flex; align-items:center; gap:var(--s3); }
.group-head .count { margin-left:0; }
.lede { font-size:13px; color:var(--ink-3); }
.cards { display:grid; gap:var(--s3); }
.fold .cards { margin-top:var(--s1); }

/* A card is one link to its price page; only the email button sits above it. */
.card { min-width:0; position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:var(--s4) var(--s5); display:grid; gap:var(--s3); transition:background .15s, border-color .15s, transform .15s; }
.card::before { content:""; position:absolute; left:-1px; top:var(--s3); bottom:var(--s3); width:3px; border-radius:0 3px 3px 0; background:var(--bar, var(--line-2)); }
.card.is-ready { --bar:var(--gold); } .card.is-facts { --bar:var(--warn); } .card.is-sent, .card.is-decided { --bar:var(--ok); }
.card:hover { background:var(--hover); border-color:var(--line-2); transform:translateY(-1px); }
.card:has(.card-link:focus-visible) { outline:2px solid var(--focus); outline-offset:2px; }
.card-link { font-size:17px; font-weight:650; color:var(--ink); text-decoration:none; letter-spacing:-.01em; outline:none; }
.card-link::after { content:""; position:absolute; inset:0; border-radius:inherit; }
.card .above { position:relative; z-index:1; }
.card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s4); }
.card-title { display:grid; gap:var(--s1); min-width:0; }
.card-title .ref { font-size:13px; color:var(--ink-3); overflow-wrap:anywhere; }
.marks { display:flex; flex-wrap:wrap; gap:var(--s2); }
.opened-mark { display:none; } .card.opened .opened-mark { display:inline-flex; }
.card.opened .card-link, .card.opened .headline .big { color:var(--ink-2); }
.headline { display:grid; justify-items:end; text-align:right; gap:2px; flex-shrink:0; }
.headline .big { font-size:24px; font-weight:700; letter-spacing:-.02em; line-height:1.2; font-variant-numeric:tabular-nums; color:var(--gold-text); }
.headline .sub { font-size:12px; color:var(--ink-3); }
.headline.needs .big { font-size:15px; font-weight:650; letter-spacing:0; color:var(--warn); max-width:240px; }
.card.is-sent .headline .big, .card.is-decided .headline .big { color:var(--ink); }

table.lines { table-layout:fixed; margin:0; }
.lines col.c-part { width:30%; } .lines col.c-qty { width:10%; } .lines col.c-unit { width:15%; } .lines col.c-total { width:17%; } .lines col.c-from { width:28%; }
.lines th { padding-top:0; }
.lines td { padding-top:var(--s2); padding-bottom:var(--s2); font-size:13px; }
.lines td.pn { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lines td.from { font-size:12px; } .lines .dated { color:var(--ink-2); font-weight:600; } .lines .needs { color:var(--warn); }
.lines tr.more td { color:var(--ink-3); font-size:12px; border-bottom:0; }
.parts { font-size:13px; color:var(--ink-2); }

.card-foot { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s2) var(--s3); }
.go { display:inline-flex; align-items:center; gap:var(--s1); font-size:13px; font-weight:600; color:var(--ink-3); transition:color .15s; }
.go .chevron { transition:transform .15s; }
.card:hover .go { color:var(--ink); } .card:hover .go .chevron { transform:translateX(2px); }
a.btn { text-decoration:none; }
.done-check { display:inline-flex; align-items:center; gap:var(--s2); font-size:13px; font-weight:600; color:var(--ink-2); cursor:pointer; flex:none; }
.done-check input { width:16px; height:16px; margin:0; accent-color:var(--ok); cursor:pointer; }
.mail-row { display:flex; flex-wrap:wrap; gap:var(--s2); min-width:0; }
.copy-chip { display:inline-flex; align-items:center; gap:var(--s1); max-width:100%; min-width:0; font:500 12px/20px var(--font); color:var(--ink-2); background:transparent; border:1px solid var(--line); border-radius:999px; padding:1px var(--s2); cursor:copy; transition:background .15s, border-color .15s, color .15s; }
.copy-chip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.copy-chip.subject { max-width:min(100%, 460px); }
.copy-chip:hover { color:var(--ink); background:var(--surface-2); border-color:var(--line-2); }
.copy-chip:active { transform:scale(.98); }
.copy-chip:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
.copy-chip.done { color:var(--ok); border-color:var(--ok); }
.copy-chip .icon { flex:none; }
.card-foot .spacer { flex:1; }
.files-note { display:flex; gap:var(--s2); align-items:flex-start; font-size:13px; color:var(--ink-2); overflow-wrap:anywhere; }
.files-note b { font-weight:600; color:var(--ink); }
.only { font-weight:500; color:var(--ink-3); font-size:12px; }
.count-inline { font-variant-numeric:tabular-nums; color:var(--ink-3); font-weight:600; }
.done-mark { display:none; } .card.done .done-mark { display:inline-flex; }
.card.done { opacity:.6; } .card.done:hover, .card.done:focus-within { opacity:1; }
.sortbar { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s2); margin-top:var(--s3); font-size:13px; color:var(--ink-3); }
.sortbar button { font:600 13px/20px var(--font); padding:2px var(--s3); border-radius:999px; border:1px solid var(--line-2); background:transparent; color:var(--ink-2); cursor:pointer; }
.sortbar button:hover { color:var(--ink); background:var(--surface-2); }
.sortbar button[aria-pressed="true"] { background:var(--ink); color:var(--surface); border-color:var(--ink); }
.sortbar button:focus-visible, .done-check input:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }

td.date { white-space:nowrap; } td.date .why-not { white-space:normal; }
table.queue td.status-cell { min-width:220px; }
.empty { display:flex; gap:var(--s2); align-items:center; color:var(--ok); font-weight:600; }
.fold > summary h3 { display:inline; font-size:13px; margin:0; } .fold > summary h3 small { color:var(--ink-3); font-weight:600; margin-left:var(--s1); }
.feedback { list-style:none; margin:var(--s2) 0 0; padding:0; display:grid; gap:var(--s3); }
.feedback li { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--s3); align-items:start; }
.feedback p { margin-top:var(--s1); font-size:13px; color:var(--ink-2); }
.intro .status.alert { color:var(--alert); background:var(--alert-bg); border-left:3px solid var(--alert); border-radius:var(--radius-sm); padding:var(--s2) var(--s3); font-weight:600; }
.fresh { display:flex; align-items:center; gap:var(--s3); font-size:12px; color:var(--ink-3); line-height:1.7; }
.fresh .badge { width:20px; height:20px; flex:none; opacity:.85; }
.fresh .stale { color:var(--alert); font-weight:600; }
@media (max-width:640px) {
  h1.summary { font-size:17px; }
  .card { padding:var(--s4); }
  .card-head { flex-direction:column; gap:var(--s2); }
  .headline { justify-items:start; text-align:left; }
  .card-foot { flex-wrap:wrap; }
}
`;

// A read-only copy of the board, its current price pages and the monitor's
// latest check report, for another computer through a synced folder
// (config.pagesMirror). Files are copied only when changed, so the sync client
// sees no churn, and superseded page versions are removed from the copy only;
// the originals and their records stay in outputsDir.
const MIRRORED = /^(CLAUDE-DECISIONS-OPEN\.html|CLAUDE-DECISION-.+\.html|RFQ-CHECK-.+\.md)$/;
export function mirrorPages({ outputsDir, mirrorDir, board }) {
  fs.mkdirSync(mirrorDir, { recursive: true });
  const keep = new Set([BOARD_FILE, ...board.cases.map((kase) => kase.page), board.monitor?.report].filter(Boolean));
  const copied = [];
  for (const name of keep) {
    const from = path.join(outputsDir, name);
    const to = path.join(mirrorDir, name);
    if (!fs.existsSync(from)) continue;
    const content = fs.readFileSync(from);
    if (fs.existsSync(to) && Buffer.compare(fs.readFileSync(to), content) === 0) continue;
    fs.writeFileSync(to, content);
    copied.push(name);
  }
  const removed = fs.readdirSync(mirrorDir).filter((name) => MIRRORED.test(name) && !keep.has(name));
  for (const name of removed) fs.rmSync(path.join(mirrorDir, name));
  return { copied, removed };
}

// The company badge is private branding, so it is read from the private
// config (config.brandBadge) at render time and never kept in this repo. It is
// embedded as an image, which cannot run script whatever the file holds.
export function readBrandBadge(badgePath) {
  if (!badgePath || !fs.existsSync(badgePath)) return null;
  const svg = fs.readFileSync(badgePath, "utf8");
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/.test(svg)) return null;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function writeBoard({ outputsDir, monitorStatePath, storeDir, lastSync, trackerPath = null, mailCachePath = null, brandBadgePath = null, quotePrepChatPath = null, claudeMailPath = null, evidenceDir = null, sharedMailbox = null, mailboxIdPrefixes = null, org = null, triagePath = null, now }) {
  const file = path.join(outputsDir, BOARD_FILE);
  const board = buildBoard({ outputsDir, monitorStatePath, storeDir, lastSync, trackerPath, mailCachePath, quotePrepChatPath, claudeMailPath, evidenceDir, sharedMailbox, mailboxIdPrefixes, org, triagePath, now });
  board.codeVersion = codeVersion();
  fs.writeFileSync(file, renderBoard(board, { badge: readBrandBadge(brandBadgePath) }));
  return { file, board };
}

// The one place the private config becomes the board's inputs, for every
// command that writes it.
export function boardInputs(config) {
  return { outputsDir: config.outputsDir, monitorStatePath: config.monitorState, storeDir: config.storeDir, trackerPath: config.trackerFile || null, mailCachePath: config.rfqMailCache || null, brandBadgePath: config.brandBadge || null, quotePrepChatPath: config.quotePrepChat || null, claudeMailPath: config.claudeMail || null, evidenceDir: config.evidenceDir || null, sharedMailbox: config.sharedMailbox || null, mailboxIdPrefixes: config.mailboxIdPrefixes || null, org: config.org || null, triagePath: config.triageFile || null };
}

// The commit the board was built from, marked when the working tree has
// uncommitted changes, so a board built from half-finished code says so.
function codeVersion() {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  try {
    const head = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirty ? `${head} + uncommitted changes` : head;
  } catch {
    return null;
  }
}

import { isNeverRead, ownDomain } from "./org.js";
import fs from "node:fs";
import path from "node:path";

// A second, independent mail check kept by an authorized Claude session
// (config.claudeMail), alongside the Codex mail monitor, which it never writes.
// Each event is one message it read and classified:
//   { id, mailbox, at, from, to: [], subject, kind, customerDomain,
//     partNumbers: [], rfqNumbers: [], note, link }
// The save tool (work/claude-pricing/tools/claude-mail-save.mjs) and the board
// both use this file's kinds, checks and matching, so each rule lives once.
// Each run also appends one line to runs.jsonl beside the store: the sources it
// searched, what it kept and what it skipped.

// The kind says who owes the next email.
//   QPC owes it: rfq (a customer asks for a price), followup (a customer
//     chases one), question (a customer asks about a request or a sent quote,
//     or answers QPC's question), secure (a customer message nobody can read
//     here: encrypted, or a secure-portal notice).
//   The customer owes it: quote-sent (QPC sent prices), ack (QPC replied
//     without a price).
//   other: kept for the record only (a receipt confirmation, a PO).
export const MAIL_KINDS = ["rfq", "followup", "question", "secure", "quote-sent", "ack", "other"];
export const ASKING_KINDS = new Set(["rfq", "followup", "question", "secure"]);
const OUTBOUND_KINDS = new Set(["quote-sent", "ack"]);
// The own domain, the mail sources one complete run searches and the
// never-read mailboxes come from private config through org.js.
export { mailSources } from "./org.js";

export function readClaudeMail(file) {
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return { checkedAt: data.checkedAt || null, cutoff: data.cutoff || null, events: Object.values(data.events || {}), runs: readRuns(runsPath(file)) };
}
export const runsPath = (storeFile) => path.join(path.dirname(storeFile), "runs.jsonl");
function readRuns(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// The Outlook item id inside a web link: the same id the Codex monitor keeps
// as evidence, written URL-safe (+ as _, / as -).
export function itemIdFromLink(link) {
  const match = /[?&]ItemID=([^&#]+)/.exec(String(link || ""));
  if (!match) return null;
  try { return decodeURIComponent(match[1]).replace(/\+/g, "_").replace(/\//g, "-"); } catch { return null; }
}

const iso = (value) => { const time = Date.parse(value); return Number.isNaN(time) ? null : new Date(time).toISOString(); };
const lower = (value) => String(value || "").trim().toLowerCase();
const domainOf = (address) => lower(address).split("@")[1] || "";
const OWA_LINK = /^https:\/\/outlook\.office365\.com\/owa\/\?ItemID=/;

// Checks one classified event and returns it in stored form. Problems stop a
// save; warnings are printed and kept.
export function normalizeEvent(event, index = 0) {
  const where = `#${index} ${event?.id ? `${String(event.id).slice(0, 24)}…` : "(no id)"}${event?.subject ? ` "${String(event.subject).slice(0, 60)}"` : ""}`;
  const problems = [], warnings = [];
  const fail = (text) => problems.push(`${where}: ${text}`);
  if (!event || typeof event !== "object") return { event: null, problems: [`#${index}: not an object`], warnings };
  if (!event.id) fail("id is required");
  const at = iso(event.at);
  if (!at) fail("a valid at is required");
  if (!MAIL_KINDS.includes(event.kind)) fail(`kind must be one of ${MAIL_KINDS.join(", ")}`);
  for (const field of ["to", "partNumbers", "rfqNumbers"]) {
    if (event[field] != null && !Array.isArray(event[field])) fail(`${field} must be a list, e.g. ["${event[field]}"]`);
  }
  const customerDomain = lower(event.customerDomain);
  if (event.kind !== "other") {
    if (!customerDomain) fail(`customerDomain is required for ${event.kind}`);
    else if (!customerDomain.includes(".") || customerDomain.includes("@")) fail(`customerDomain "${event.customerDomain}" is not an email domain like acme.com`);
    else if (customerDomain === ownDomain()) fail(`customerDomain is the outside company's domain, never ${ownDomain()}`);
  }
  if (isNeverRead(event.mailbox)) fail(`${event.mailbox} is a mailbox that is never read`);
  if (!OWA_LINK.test(String(event.link || ""))) fail("link must be the message's Outlook web link (https://outlook.office365.com/owa/?ItemID=…)");
  const from = lower(event.from);
  const to = Array.isArray(event.to) ? event.to.map(lower).filter(Boolean) : [];
  if (OUTBOUND_KINDS.has(event.kind)) {
    if (domainOf(from) !== ownDomain()) fail(`${event.kind} is our own mail: from must be an @${ownDomain()} address`);
    if (customerDomain && !to.some((address) => domainOf(address) === customerDomain)) fail(`${event.kind} needs the customer's address in to (take recipients from the shared-mailbox copy or the message itself)`);
  } else if (ASKING_KINDS.has(event.kind) && from && customerDomain && domainOf(from) !== customerDomain) {
    warnings.push(`${where}: sender ${from} is not at ${customerDomain} (forwarded?)`);
  }
  const stored = {
    mailbox: null, subject: "", note: "", ...event,
    at, from: from || null, to, partNumbers: event.partNumbers || [], rfqNumbers: event.rfqNumbers || [],
    customerDomain: customerDomain || null, itemId: itemIdFromLink(event.link),
  };
  return { event: stored, problems, warnings };
}

// Upper-case, all spacing removed: how part and RFQ numbers are compared.
const squash = (value) => String(value || "").toUpperCase().replace(/\s+/g, "");
const eventTokens = (event) => [...(event.partNumbers || []), ...(event.rfqNumbers || [])].map(squash).filter((token) => token.length >= 4);
// A token found inside a reference only as a whole number: "4803" is in
// "4803-3" and "RFQ 4803" but not in "WO44803WA". Spaces between two digits
// stay a break, so "55120 12345" never reads as one number.
function referenceHas(reference, token) {
  const hay = String(reference || "").toUpperCase().replace(/\s+/g, "|").replace(/\|(?=[^0-9|])|(?<=[^0-9|])\|/g, "");
  const digit = /[0-9]/;
  for (let at = hay.indexOf(token); at >= 0; at = hay.indexOf(token, at + 1)) {
    const before = hay[at - 1] || "", after = hay[at + token.length] || "";
    if (digit.test(token[0]) && digit.test(before)) continue;
    if (digit.test(token.at(-1)) && digit.test(after)) continue;
    return true;
  }
  return false;
}

// Reply and forward marks and external-sender tags removed, so every message
// of one thread shares a key.
export function subjectKey(subject) {
  let text = String(subject || "").toUpperCase().replace(/\s+/g, " ").trim();
  for (let previous = null; previous !== text;) {
    previous = text;
    text = text.replace(/^(?:(?:RE|FWD?|AW)\s*:|\[EXTERNAL\]|\[EXT\]|EXTERNAL\s*:)\s*/, "");
  }
  return text.replace(/\s+/g, "");
}

// Part and RFQ numbers a case answers to.
// RFQ numbers compare by their digits ("RFQ-CA-4100" and "4100" are one
// request; 4100 and 14100 are not).
const rfqDigits = (value) => String(value || "").replace(/\D/g, "");
const caseRfqNumbers = (kase) => [...String([kase.reference, kase.monitorReference].join(" ")).matchAll(/\bRFQ\s*#?\s*-?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/gi)].map((match) => rfqDigits(match[1])).filter((token) => token.length >= 4);
function caseTokens(kase) {
  const numbers = [...String([kase.reference, kase.monitorReference].join(" ")).matchAll(/\bRFQ\s*#?\s*-?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/gi)].map((match) => match[1]);
  return [...(kase.lines || []).map((line) => line.partNumber), ...numbers].map(squash).filter((token) => token.length >= 4);
}
const sharesToken = (tokens, own) => tokens.some((token) => own.some((mine) => mine === token || mine.includes(token) || token.includes(mine)));
const caseDomains = (kase) => (kase.customerRecord?.emailDomains || []).map(lower);

// Messages about this case: the customer's domain and a shared part or RFQ number.
export function caseMail(kase, events) {
  const domains = caseDomains(kase);
  if (!domains.length) return { sent: null, latest: null };
  const mine = caseTokens(kase);
  const related = events.filter((event) => domains.includes(lower(event.customerDomain)) && sharesToken(eventTokens(event), mine));
  const byTime = related.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const quotes = byTime.filter((event) => event.kind === "quote-sent" && (!kase.askedAt || Date.parse(event.at) >= Date.parse(kase.askedAt)));
  // The quote that can answer an open price question must not name an RFQ
  // number this request does not have (pricing owner, 2026-10-09).
  const ownRfqs = caseRfqNumbers(kase);
  const sameRequest = (event) => !(event.rfqNumbers || []).length || (ownRfqs.length > 0 && event.rfqNumbers.map(rfqDigits).some((number) => ownRfqs.includes(number)));
  // A quote naming only other RFQ numbers than this case's own is another
  // request's quote.
  const notOther = (event) => !(event.rfqNumbers || []).length || !ownRfqs.length || event.rfqNumbers.map(rfqDigits).some((number) => ownRfqs.includes(number));
  return { sent: quotes.filter(notOther)[0] || null, lastSent: quotes.filter(sameRequest).at(-1) || null, latest: byTime.at(-1) || null };
}

// Monitor entries a message belongs to: the entry that holds this very email
// (by its Outlook item id), then entries whose reference names one of its
// numbers, the customer's own first.
function monitorEntries(event, queue) {
  const id = event.itemId || itemIdFromLink(event.link);
  const byMessage = id ? queue.filter((entry) => (entry.evidence_ids || []).includes(id) || (entry.events || []).some((item) => item.message_id === id)) : [];
  const tokens = eventTokens(event);
  const domain = lower(event.customerDomain);
  const ours = (entry) => [entry.last_observed_actor, ...(entry.events || []).map((item) => item.actor)].some((actor) => domainOf(actor) === domain);
  const byNumber = tokens.length ? queue.filter((entry) => !byMessage.includes(entry) && tokens.some((token) => referenceHas(entry.reference, token))).sort((a, b) => Number(ours(b)) - Number(ours(a))) : [];
  return [...byMessage.map((entry) => ({ entry, by: "message" })), ...byNumber.map((entry) => ({ entry, by: "number" }))];
}

// Domains many unrelated senders share, where only the full address names a customer.
const SHARED_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net"]);

// With no number and no known email, the customer's most recently active
// monitor entry: one whose senders use the message's email domain (or, for a
// shared mail domain, its exact address). Shown for context only; it never
// hides a message, since the customer may have more than one request.
function sameCustomerEntry(event, queue) {
  const domain = lower(event.customerDomain);
  if (!domain || domain === ownDomain()) return null;
  const address = lower(event.from);
  if (SHARED_DOMAINS.has(domain) && !address) return null;
  const sameSender = (actor) => (SHARED_DOMAINS.has(domain) ? actor === address : actor.endsWith(`@${domain}`));
  const actors = (entry) => [entry.last_observed_actor, ...(entry.events || []).map((item) => item.actor)].map(lower);
  return queue
    .filter((entry) => actors(entry).some(sameSender))
    .sort((a, b) => (Date.parse(b.last_observed_activity_at || "") || 0) - (Date.parse(a.last_observed_activity_at || "") || 0))[0] || null;
}

const monitorView = (entry, by) => ({ customer: entry.customer || null, reference: entry.reference, section: entry.priority_section ?? null, status: entry.status ?? null, dueDate: entry.explicit_due_date || null, lastActivityAt: entry.last_observed_activity_at || null, matchedBy: by });
const caseSentAt = (kase) => { try { const step = kase.progress?.find?.((item) => item.key === "sent"); return step?.done ? step.at || null : null; } catch { return null; } };

// Where each message lands on the board, and why. One placement per event:
//   case      on an open case's card (as a "customer wrote" mark)
//   listed    the board already lists its monitor entry (`monitorCovers` says so)
//   answered  a later quote to the same customer covers it
//   found     listed by itself under what the mail check found
//   old       older than `since`
//   sent-mark a quote-sent that marks a case sent
//   unattached a quote-sent no case matches (the quote stays in the records)
//   by-design an ack or other: kept, not shown
// `monitorCovers(entry, event)` is the board's own rule; with none, no
// monitor entry hides anything.
export function placeMailEvents(events, cases, queue, { monitorCovers = () => false, since = null } = {}) {
  const sentBy = new Map();
  for (const kase of cases) {
    const { sent } = caseMail(kase, events);
    if (sent) sentBy.set(sent.id, kase);
  }
  // Both name RFQ numbers and none agree by digits: another request's quote.
  const rfqConflict = (a, b) => (a.rfqNumbers || []).length > 0 && (b.rfqNumbers || []).length > 0 && !a.rfqNumbers.map(rfqDigits).some((number) => b.rfqNumbers.map(rfqDigits).includes(number));
  const answeredBy = (event) => events.find((other) => other.kind === "quote-sent" && lower(other.customerDomain) === lower(event.customerDomain) && Date.parse(other.at) > Date.parse(event.at) && !rfqConflict(other, event) && (sharesToken(eventTokens(other), eventTokens(event)) || subjectKey(other.subject) === subjectKey(event.subject)));
  const casesFor = (event, entries) => {
    const domain = lower(event.customerDomain);
    const tokens = eventTokens(event);
    const references = new Set(entries.map(({ entry }) => entry.reference));
    return cases.filter((kase) => (caseDomains(kase).includes(domain) && tokens.length && sharesToken(tokens, caseTokens(kase))) || (references.size && [kase.monitor?.reference, kase.monitorReference].some((reference) => reference && references.has(reference))));
  };
  return events.map((event) => {
    if (event.kind === "quote-sent") {
      const kase = sentBy.get(event.id);
      return kase ? { event, place: "sent-mark", caseId: kase.caseId, detail: `marks ${kase.customer || kase.caseId} sent` } : { event, place: "unattached", detail: "no page matches its customer and numbers" };
    }
    if (!ASKING_KINDS.has(event.kind)) return { event, place: "by-design", detail: `${event.kind}: kept, not shown` };
    if (since && Date.parse(event.at) < Date.parse(since)) return { event, place: "old", detail: "older than the board's two-week window" };
    const answer = answeredBy(event);
    if (answer) return { event, place: "answered", detail: `answered by the quote of ${answer.at}` };
    const entries = monitorEntries(event, queue);
    const onCases = casesFor(event, entries);
    const open = onCases.find((kase) => kase.open !== false);
    if (open) return { event, place: "case", caseId: open.caseId, detail: `on the ${open.customer || open.caseId} card` };
    const closed = onCases[0];
    // A message after a closed case's quote is new business or a question on it: list it.
    const afterClose = closed && !(caseSentAt(closed) && Date.parse(event.at) <= Date.parse(caseSentAt(closed)));
    const listed = !closed && entries.find(({ entry }) => monitorCovers(entry, event));
    if (listed) return { event, place: "listed", reference: listed.entry.reference, detail: `the board lists monitor entry ${listed.entry.reference}` };
    if (closed && !afterClose) return { event, place: "answered", caseId: closed.caseId, detail: `before ${closed.customer || closed.caseId}'s quote went out` };
    const first = entries[0];
    const entry = first?.entry || (eventTokens(event).length ? null : sameCustomerEntry(event, queue));
    return { event, place: "found", closedCase: closed ? { caseId: closed.caseId, customer: closed.customer || null, state: closed.state || null } : null, monitor: entry ? monitorView(entry, first ? first.by : "customer") : null, detail: "listed under what the mail check found" };
  });
}

// The rows for "found": the newest message per customer and thread, with the
// front desk's latest reply to that thread, if any.
export function foundRows(placements, events) {
  const latest = new Map();
  for (const placement of placements.filter((item) => item.place === "found")) {
    const key = `${lower(placement.event.customerDomain)}|${subjectKey(placement.event.subject)}`;
    if (!latest.has(key) || Date.parse(latest.get(key).event.at) < Date.parse(placement.event.at)) latest.set(key, placement);
  }
  return [...latest.values()].map(({ event, monitor, closedCase }) => {
    const reply = events.filter((other) => other.kind === "ack" && lower(other.customerDomain) === lower(event.customerDomain) && subjectKey(other.subject) === subjectKey(event.subject) && Date.parse(other.at) > Date.parse(event.at)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return { ...event, monitor: monitor || null, closedCase: closedCase || null, reply: reply ? { at: reply.at, from: reply.from, note: reply.note || "" } : null };
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// Requests and chases the check found that nothing else on the board shows.
export function newRequests(events, cases, queue, monitorCovers = () => false) {
  return foundRows(placeMailEvents(events, cases, queue, { monitorCovers }), events);
}

// The side-by-side trial in numbers, for the reviewer: did the hourly runs
// happen, did every source get searched, and what did Claude's check find that
// the Codex monitor had no entry for. Read-only.
export function mailScorecard({ runs, events, queue, since, until, expectedPerWeekday = 11 }) {
  const from = Date.parse(since), to = Date.parse(until);
  const inWindow = (at) => Date.parse(at) >= from && Date.parse(at) <= to;
  const windowRuns = runs.filter((run) => inWindow(run.runStart)).sort((a, b) => Date.parse(a.runStart) - Date.parse(b.runStart));
  const dayOf = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  // Shop days from the first to the last, Monday to Friday.
  const weekdays = [];
  for (let day = dayOf(new Date(from).toISOString()); day <= dayOf(new Date(to).toISOString()); day = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) weekdays.push(day);
  }
  const perDay = [...new Set(weekdays)].map((day) => ({ day, runs: windowRuns.filter((run) => dayOf(run.runStart) === day).length, expected: expectedPerWeekday }));
  const gaps = windowRuns.slice(1).map((run, index) => ({ from: windowRuns[index].runStart, to: run.runStart, minutes: Math.round((Date.parse(run.runStart) - Date.parse(windowRuns[index].runStart)) / 60000) }))
    .filter((gap) => gap.minutes > 120 && dayOf(gap.from) === dayOf(gap.to));
  const failedRuns = windowRuns.filter((run) => run.held);
  const kept = events.filter((event) => inWindow(event.at));
  const claudeOnly = kept.filter((event) => (ASKING_KINDS.has(event.kind) || event.kind === "quote-sent") && !monitorEntries(event, queue).length);
  const skipped = windowRuns.flatMap((run) => run.skipped || []);
  const skippedBy = skipped.reduce((acc, item) => ((acc[item.reason || "other"] = (acc[item.reason || "other"] || 0) + 1), acc), {});
  return { since: new Date(from).toISOString(), until: new Date(to).toISOString(), runs: windowRuns.length, perDay, gaps, failedRuns: failedRuns.length, kept: kept.length, claudeOnly, skipped: skipped.length, skippedBy };
}

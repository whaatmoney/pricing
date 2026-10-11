import { isPricingRequest, isQuoteOwed, quoteSentStatus } from "./board.js";
import { SOON, URGENT, groupThreads, parsePost } from "./followups.js";
import { TYPESAFE_MODEL, judgeAll, topLevel } from "./typesafe.js";

// Shadow trial: TypeSafe answers the same questions the board's keyword rules
// answer, and only the disagreements are reported. Nothing here changes the
// board, a case or a decision. Only internal text is sent: the mail monitor's
// status notes and the quote-prep chat posts, with the customer's and
// contact's names replaced and @-mentions removed. References, subjects and
// email bodies are never sent.

const YES = 0.5;
const UNSURE = [0.3, 0.7];

export const SENT_QUESTION = {
  type: "noul",
  instructions: {
    question: "Does `status` say that QPC has already sent this customer a quote or price?",
    counts_as_yes: [
      "QPC sent or emailed a quote or price to the customer",
      "the customer confirmed they received QPC's quote",
      "QPC told the customer an earlier quote still stands",
    ],
    counts_as_no: [
      "a quote is planned, pending, drafted or to be sent later",
      "a quote is only recorded in a ledger or is unverified",
      "the status is about a purchase order, readiness, shipping or a technical question with no quote sent",
    ],
  },
};

// What the board's Quote owed list needs (the first wording, "is the customer
// asking for a price?", missed quotes still owed; reworded 2026-10-06).
export const PRICING_QUESTION = {
  type: "noul",
  instructions: {
    question: "Does `status` say that QPC still owes this customer a quote or price?",
    counts_as_yes: [
      "the customer asked for a quote, a price, a cost estimate or an RFQ response, and QPC has not sent it yet",
      "a quote is pending, still being prepared, or not verified as sent to the customer",
      "the customer asks again for a quote or an official quote",
    ],
    counts_as_no: [
      "the status is only about a completion date, pickup, shipping, delivery, or receipt of parts or a purchase order",
      "QPC already sent the quote or price to the customer",
      "the customer withdrew or cancelled the request",
      "QPC asked the customer for a revised purchase order",
    ],
  },
};

export const URGENCY_QUESTION = {
  type: "score",
  instructions: "How urgent is this customer's follow-up on their quote request, judged only from the words in `posts`?",
  criteria: [
    "Routine: asks for a status update with no deadline or pressure stated",
    "Soon: names a near deadline such as due tomorrow or this week",
    "Urgent: says it is due today, past due, urgent, ASAP or hot, or says they have already been waiting for weeks or a month",
  ],
};
const LEVELS = ["routine", "soon", "urgent"];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Replace each name (and its first word, for "Acme" in "Acme Precision") with a neutral word.
export function scrub(text, names, as) {
  let out = String(text || "");
  for (const name of names.filter((value) => value && value.trim().length >= 2)) {
    const words = [name.trim(), name.trim().split(/\s+/)[0]].filter((word) => word.length >= 2);
    for (const word of words) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`, "giu"), as);
  }
  return out;
}
const dropMentions = (text) => String(text || "").replace(/@[\w.-]+(?:\s[A-Z][\w]*)?/g, "").trim();

// Everyone the data names (pricing owner, 2026-10-09: names never leave QPC):
// chat authors, and each mail sender's address before the @ ("pat.lee@…" ->
// "pat", "lee"), skipping role mailboxes. The list is built from the data, so
// no name is written in this public repo.
const ROLE_WORDS = new Set(["quote", "quotes", "rfq", "rfqs", "sales", "info", "admin", "purchasing", "buyer", "buyers", "orders", "order", "accounts", "ap", "ar", "frontdesk", "front", "desk", "office", "support", "service", "quality", "receiving", "shipping", "customer", "contact", "team", "noreply", "no", "reply", "mail", "email", "procurement", "supply", "chain", "planning", "qa", "qc"]);
export function peopleIn({ queue = [], messages = [], common = new Set() }) {
  const names = new Set();
  const add = (word) => { const value = String(word || "").trim(); if (value.length >= 2 && !/\d/.test(value) && !ROLE_WORDS.has(value.toLowerCase()) && !FUNCTION_WORDS.has(value.toLowerCase())) names.add(value); };
  for (const message of messages) {
    String(message.from || "").split(/[\s,()]+/).forEach(add);
    // The contact a chase post names ("Al from Beta is F/U ..."); a word the
    // texts also use in lower case ("and", "sheet") is not a name.
    String(parsePost(message.text)?.contact || "").split(/\s+/).filter((word) => !common.has(word.toLowerCase())).forEach(add);
  }
  for (const entry of queue) {
    for (const actor of [entry.last_observed_actor, ...(entry.events || []).map((event) => event.actor)]) {
      const [local, domain = ""] = String(actor || "").toLowerCase().split("@");
      local.split(/[._+-]+/).forEach(add);
      // The company behind a sender's domain ("acme.example" -> "acme").
      const label = domain.split(".").slice(-2, -1)[0];
      if (label && !SHARED_MAIL.has(domain)) add(label);
    }
    // Distinctive words of the customer's name ("Acme Precision Corp" -> "Acme").
    for (const word of String(entry.customer || "").split(/[\s(),&/]+/)) if (/^[A-Z]/.test(word) && word.length >= 4 && !CORP_WORDS.has(word.toLowerCase()) && !common.has(word.toLowerCase())) add(word);
  }
  return [...names];
}
// Proper nouns the lists above miss (an end user or product named in passing):
// a capitalised word that never appears in lower case anywhere in the texts.
const FUNCTION_WORDS = new Set(["not", "no", "never", "none", "all", "any", "both", "each", "some", "will", "would", "can", "could", "should", "may", "might", "must", "shall", "please", "thanks", "thank", "yes", "the", "this", "that", "these", "those", "our", "their", "its", "his", "her", "new", "old", "next", "last", "per", "re", "fw", "fwd", "and", "but", "or", "if", "when", "after", "before", "still", "also", "only", "just", "again", "already", "sent", "quote", "quoted", "customer", "buyer", "pending", "ready", "waiting", "received", "revised", "updated", "current", "prior", "earlier", "older", "estimate", "estimated", "pricing", "price", "prices", "completion", "pickup", "receipt", "expedite", "acknowledged", "requested", "confirmed", "partial", "internal", "external", "urgent", "open", "closed", "duplicate", "formal", "detailed", "corrected"]);
const CALENDAR = /^(?:Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/;
export function lowerCaseWords(texts) {
  const lower = new Set();
  // Mentions and addresses ("@al.smith", "al@…") are not ordinary use.
  for (const text of texts) for (const word of dropMentions(text).replace(/\S+@\S+/g, " ").match(/[\p{Ll}][\p{Ll}]+/gu) || []) lower.add(word);
  return lower;
}
export function properNounsIn(texts) {
  const lower = new Set();
  const capital = new Set();
  for (const text of texts) {
    for (const clause of String(text || "").split(/[\n;.:!?/]+/)) {
      const words = clause.match(/[\p{L}][\p{Ll}]+/gu) || [];
      // The first word of a clause is capitalised anyway, so a plain word
      // there ("Not quoted") is never taken for a name.
      words.forEach((word, index) => (/^\p{Lu}/u.test(word) ? ((index > 0 || !FUNCTION_WORDS.has(word.toLowerCase())) && capital.add(word)) : lower.add(word)));
    }
  }
  return [...capital].filter((word) => !lower.has(word.toLowerCase()) && !CALENDAR.test(word));
}
const SHARED_MAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net"]);
const CORP_WORDS = new Set(["company", "corporation", "corp", "incorporated", "limited", "group", "systems", "system", "technologies", "technology", "industries", "international", "precision", "manufacturing", "engineering", "services", "defense", "space", "security", "aerospace", "products", "solutions", "institution", "science", "division", "national", "laboratory", "laboratories", "research", "center", "global", "machine", "machining", "works", "fabrication", "components", "metals", "electronics", "dynamics", "controls", "valve", "valves", "fittings", "customer", "unknown"]);
// What stays in text sent out: a capitalised name next to "by", "to", "from"
// and the like becomes "someone" (days, months and "Customer" stay, so "by
// Friday" keeps its deadline); numbers of three or more digits (RFQs, POs,
// parts) become "#".
const KEEP = "(?!(?:Customer|Buyer|QPC|Vendor|Supplier|RFQ|PO|WO|The|A|An|Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|EOD|EOW|ASAP|Next|This)\\b)";
const NAMED = new RegExp(`\\b(by|to|from|with|cc|per|thanks|and|for)\\s+${KEEP}[A-Z][a-z]+(?:\\s+${KEEP}[A-Z][a-z]+)?\\b`, "g");
// All-caps words other than the trade's own abbreviations may be company names.
const ABBREVIATIONS = new Set(["RFQ", "RFQS", "QPC", "ECD", "NDA", "NVR", "ASAP", "EOD", "EOW", "ETA", "COC", "FAI", "PO", "POS", "WO", "PN", "PNS", "QTY", "EA", "PCS", "LOT", "MIN", "TBD", "USA", "UPS", "FEDEX", "DHL", "PDF", "LOX", "ITAR", "EAR", "AMS", "ASTM", "MIL", "SPEC", "REV", "OK"]);
export function anonymize(text, names) {
  return scrub(ownWords(text), names, "someone")
    .replace(/["“”][^"“”]*["“”]/g, "a quoted message")
    .replace(NAMED, (_, word) => `${word} someone`)
    .replace(/(?<![\p{L}\p{N}_])\p{Lu}{3,}(?![\p{L}\p{N}_])/gu, (word) => (ABBREVIATIONS.has(word) ? word : "someone"))
    .replace(/\b[\w-]*\d{3,}[\w-]*\b/g, "#");
}
// Only the poster's own words: no "Subject Line:" or header lines, and nothing
// from a forwarded or quoted email.
export function ownWords(text) {
  const kept = [];
  for (const line of dropMentions(text).split("\n")) {
    if (/^\s*(?:-{2,}|_{2,}|>|from:|sent:|on\s.+wrote:|original message)/i.test(line)) break;
    if (/^\s*(?:subject(?:\s+line)?|to|cc|date):/i.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
const band = (p) => (p >= UNSURE[0] && p <= UNSURE[1] ? "unsure" : p >= YES ? "yes" : "no");

// Monitor entries in sections 2 and 3: "quote sent?" for both, "price request?"
// for section 2 (what decides the board's Quote owed list).
export async function shadowMonitor({ queue, cache, ask, people = peopleIn({ queue }) }) {
  const entries = queue.filter((entry) => [2, 3].includes(entry.priority_section) && String(entry.status || "").trim());
  const states = entries.map((entry) => ({ status: anonymize(scrub(entry.status, [entry.customer], "the customer"), people) }));
  const sent = await judgeAll({ states, questions: { sent: SENT_QUESTION }, cache, ask });
  const section2 = entries.map((entry, index) => [entry, index]).filter(([entry]) => entry.priority_section === 2);
  const pricing = await judgeAll({ states: section2.map(([, index]) => states[index]), questions: { pricing: PRICING_QUESTION }, cache, ask });
  const rows = [];
  const errors = [];
  entries.forEach((entry, index) => {
    const result = sent.results[index];
    if (result.error) return errors.push(`${entry.reference}: ${result.error}`);
    const p = result.answers.sent.noul;
    const rule = quoteSentStatus(entry.status);
    if (rule !== (p >= YES)) rows.push({ check: "quote sent", section: entry.priority_section, customer: entry.customer, reference: entry.reference, status: entry.status, rule, typesafe: p, band: band(p), effect: sentEffect(entry.priority_section, rule) });
  });
  section2.forEach(([entry], position) => {
    const result = pricing.results[position];
    if (result.error) return errors.push(`${entry.reference}: ${result.error}`);
    const p = result.answers.pricing.noul;
    const rule = isQuoteOwed(`${entry.reference} ; ${entry.status}`) && !quoteSentStatus(entry.status);
    if (rule !== (p >= YES)) rows.push({ check: "price request", section: 2, customer: entry.customer, reference: entry.reference, status: entry.status, rule, typesafe: p, band: band(p), ruleFromReferenceOnly: rule && !isPricingRequest(entry.status), effect: rule ? "rule can list it under Quote owed; TypeSafe does not read a quote still owed" : "TypeSafe reads a quote still owed that the rule misses; it is not under Quote owed" });
  });
  return { judged: entries.length, tokens: sent.tokens + pricing.tokens, errors, rows };
}

function sentEffect(section, rule) {
  if (section === 3) return rule ? "board marks the quote sent; TypeSafe doubts it" : "TypeSafe reads a sent quote the rule missed";
  return rule ? "rule keeps it off Quote owed as sent; TypeSafe doubts it was sent" : "TypeSafe reads a sent quote; the rule could list it as owed";
}

// Chase threads from the quote-prep chat: urgency from the words only. The
// "3 or more chases is urgent" count stays in code and is not compared.
export async function shadowChases({ messages, cache, ask, people = peopleIn({ messages }) }) {
  const threads = groupThreads(messages);
  const states = threads.map((thread) => ({
    posts: thread.posts.map((post) => anonymize(scrub(scrub(scrub(ownWords(post.text), [thread.subject], "the request"), [thread.company], "the customer"), [thread.contact], "the contact"), people)),
  }));
  const judged = await judgeAll({ states, questions: { urgency: URGENCY_QUESTION }, cache, ask });
  const rows = [];
  const errors = [];
  threads.forEach((thread, index) => {
    const result = judged.results[index];
    if (result.error) return errors.push(`${thread.company}: ${result.error}`);
    const words = thread.posts.map((post) => post.text).join("\n");
    const rule = URGENT.test(words) ? "urgent" : SOON.test(thread.posts.at(-1).text) ? "soon" : "routine";
    const level = LEVELS[topLevel(result.answers.urgency)];
    if (rule !== level) rows.push({ check: "chase urgency", company: thread.company, subject: thread.subject, lastAt: thread.posts.at(-1).at, posts: thread.posts.length, rule, typesafe: level, confidence: result.answers.urgency.confidence, ruleWord: words.match(URGENT)?.[0] || null });
  });
  return { judged: threads.length, tokens: judged.tokens, errors, rows };
}

export async function runShadow({ queue = [], chatMessages = [], cache, ask, now = new Date() }) {
  const texts = [...queue.map((entry) => entry.status), ...chatMessages.map((message) => message.text)];
  const people = [...peopleIn({ queue, messages: chatMessages, common: lowerCaseWords(texts) }), ...properNounsIn(texts)];
  const monitor = await shadowMonitor({ queue, cache, ask, people });
  const chases = await shadowChases({ messages: chatMessages, cache, ask, people });
  return { at: now.toISOString(), model: TYPESAFE_MODEL, tokens: monitor.tokens + chases.tokens, monitor, chases };
}

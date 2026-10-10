import { isPricingRequest, isQuoteOwed, quoteSentStatus } from "./board.js";
import { SOON, URGENT, groupThreads } from "./followups.js";
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
  for (const name of names.filter((value) => value && value.trim().length >= 3)) {
    const words = [name.trim(), name.trim().split(/\s+/)[0]].filter((word) => word.length >= 3);
    for (const word of words) out = out.replace(new RegExp(`\\b${escape(word)}\\b`, "gi"), as);
  }
  return out;
}
const dropMentions = (text) => String(text || "").replace(/@[A-Z][\w]*(?:\s[A-Z][\w]*)?/g, "").trim();
const band = (p) => (p >= UNSURE[0] && p <= UNSURE[1] ? "unsure" : p >= YES ? "yes" : "no");

// Monitor entries in sections 2 and 3: "quote sent?" for both, "price request?"
// for section 2 (what decides the board's Quote owed list).
export async function shadowMonitor({ queue, cache, ask }) {
  const entries = queue.filter((entry) => [2, 3].includes(entry.priority_section) && String(entry.status || "").trim());
  const states = entries.map((entry) => ({ status: scrub(entry.status, [entry.customer], "the customer") }));
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
    const rule = isQuoteOwed(`${entry.reference} ; ${entry.status}`);
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
export async function shadowChases({ messages, cache, ask }) {
  const threads = groupThreads(messages);
  const states = threads.map((thread) => ({
    posts: thread.posts.map((post) => scrub(scrub(dropMentions(post.text), [thread.company], "the customer"), [thread.contact], "the contact")),
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
  const monitor = await shadowMonitor({ queue, cache, ask });
  const chases = await shadowChases({ messages: chatMessages, cache, ask });
  return { at: now.toISOString(), model: TYPESAFE_MODEL, tokens: monitor.tokens + chases.tokens, monitor, chases };
}

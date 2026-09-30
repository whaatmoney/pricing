import fs from "node:fs";

// Customer follow-ups the front desk posts in the team's quote-prep chat
// ("Kevin from Acme is F/U on this request: RFQ 4100"), read by an authorized
// Claude session into a private store (config.quotePrepChat). A later post that
// quotes an earlier one ("2nd f/u", "due today") joins its thread. The board
// only reads the store; it never posts in the chat.

const URGENT = /\b(?:due today|urgent|asap|hot|past due|overdue|3rd|third|4th|fourth|in a month|month)\b/i;
const SOON = /\bdue tomorrow\b/i;
const STOP = new Set(["INC", "LLC", "CORP", "CORPORATION", "CO", "COMPANY", "US", "USA", "THE", "LTD", "LIMITED", "INC.", "OF"]);

export function readQuotePrepChat(file) {
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return { readAt: data.readAt || null, messages: Object.values(data.messages || {}) };
}

// "Kevin from Acme is F/U on this request: RFQ 4100" -> contact, company, subject.
export function parsePost(text) {
  const first = String(text || "").split("\n")[0].replace(/^new customer:?\s*/i, "").trim();
  const match = first.match(/^(.+?)\s+(?:from\s+(.+?)\s+)?(?:is F\/U|called to F\/U|is following up|called (?:to see|about|regarding))\b[^:]*:?\s*(.*)$/i);
  const subjectLine = String(text || "").match(/Subject Line:\s*(.+)/i)?.[1]?.trim();
  if (!match) return null;
  let [, contact, company, subject] = match;
  if (!company && contact.trim().split(/\s+/).length > 1) {
    // "E & K Precision Erick is F/U ..." puts the company before the contact.
    const parts = contact.trim().split(/\s+/);
    contact = parts.pop();
    company = parts.join(" ");
  }
  if (!company) {
    // "Lee is F/U on this request: Omega RFQ: ..." names the company in the subject.
    company = (subject.match(/^([A-Za-z][\w&.-]*)\s+RFQ\b/i) || [])[1] || null;
  }
  return { contact: contact.trim(), company: company?.replace(/[.,]+$/, "").trim() || null, subject: (subjectLine || subject || "").trim() };
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

// One entry per chased request: the first post names it, replies count up.
export function followupThreads(messages) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const rootOf = (message) => {
    let current = message;
    for (let hops = 0; current.replyTo && byId.has(current.replyTo) && hops < 20; hops++) current = byId.get(current.replyTo);
    return current;
  };
  const threads = new Map();
  for (const message of [...messages].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const root = rootOf(message);
    const parsed = parsePost(root.text);
    if (!parsed) continue;
    if (!threads.has(root.id)) threads.set(root.id, { id: root.id, ...parsed, posts: [] });
    threads.get(root.id).posts.push(message);
  }
  return [...threads.values()].map((thread) => {
    const last = thread.posts.at(-1);
    const words = thread.posts.map((post) => post.text).join("\n");
    const count = thread.posts.length;
    return {
      id: thread.id, contact: thread.contact, company: thread.company, subject: thread.subject,
      firstAt: thread.posts[0].at, lastAt: last.at, count, label: count > 1 ? `${ordinal(count)} follow-up` : "Follow-up",
      note: noteOf(last.text), urgent: URGENT.test(words) || count >= 3, soon: SOON.test(last.text),
    };
  }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

// The front desk's own words beyond the header line and the @-mentions.
function noteOf(text) {
  return String(text || "").split("\n").slice(1).join(" ").replace(/@[A-Z][\w]*(?:\s[A-Z][\w]*)?/g, "").replace(/\s+/g, " ").replace(/\.\.\.$/, "…").trim()
    || (/^(?:\d+(?:st|nd|rd|th)|2nd|3rd)\b/i.test(String(text).trim()) ? String(text).split("\n")[0].replace(/@\S+/g, "").trim() : "");
}

const words = (text) => String(text || "").toUpperCase().replace(/[^A-Z0-9&]+/g, " ").trim().split(" ").filter((word) => word && !STOP.has(word));
// Every word of the chat's company name appears in the case's name or an alias.
export function companyMatches(company, customer) {
  const want = words(company);
  if (!want.length || !customer) return false;
  return [customer.name, ...(customer.aliases || [])].some((candidate) => {
    const have = new Set(words(candidate));
    return want.every((word) => have.has(word));
  });
}
// Numbers that identify a request: RFQ numbers, part numbers ("PR-0224857", "17320").
const idTokens = (text) => [...String(text || "").toUpperCase().matchAll(/[A-Z0-9]*\d[A-Z0-9-]{2,}/g)].map((m) => m[0].replace(/-+$/, "")).filter((token) => (token.match(/\d/g) || []).length >= 4);

// A thread belongs to a case when the company matches and, if the subject
// names a number, that number is the case's (reference, part number, email
// subject); a subject with no number matches only the customer's single case.
export function matchThread(thread, cases) {
  const same = cases.filter((kase) => companyMatches(thread.company, kase.customerRecord));
  const tokens = idTokens(thread.subject);
  if (tokens.length) {
    return same.filter((kase) => {
      const hay = [kase.reference, kase.monitorReference, kase.email?.subject, kase.caseId, ...kase.lines.map((line) => line.partNumber)].join(" ").toUpperCase();
      return tokens.some((token) => hay.includes(token));
    });
  }
  return same.length === 1 ? same : [];
}

// Monitor entries (no page yet) for the same company, for the unmatched list.
export function monitorFor(thread, entries) {
  return monitorCandidates(thread, entries).entry;
}
// The entry, and how many of the company's open entries were left to choose
// from when none could be picked (so the board can say so rather than
// claiming the monitor has nothing).
export function monitorCandidates(thread, entries) {
  const tokens = idTokens(thread.subject);
  const same = entries.filter((entry) => words(thread.company).length && words(thread.company).every((word) => words(entry.customer).includes(word)));
  const exact = tokens.length ? same.filter((entry) => tokens.some((token) => String(entry.reference).toUpperCase().includes(token))) : [];
  const open = same.filter((entry) => entry.priority_section !== 3);
  const entry = exact[0] || (open.length === 1 ? open[0] : same.length === 1 ? same[0] : null);
  return { entry, candidates: entry ? 0 : open.length };
}

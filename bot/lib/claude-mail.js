import fs from "node:fs";

// A second, independent mail check kept by an authorized Claude session
// (config.claudeMail), alongside the Codex monitor, which it never writes. Each
// event is one message it read and classified:
//   { id, mailbox, at, from, to: [], subject, kind, customerDomain,
//     partNumbers: [], rfqNumbers: [], note, link }
// kind: "rfq" (a customer asks for a price), "followup" (a customer chases
// one), "quote-sent" (QPC sent the customer a price), "ack" (QPC acknowledged
// without a price) or "other". `cutoff` is the latest received time the check
// covered; the board uses whichever mail check is fresher.

export function readClaudeMail(file) {
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return { checkedAt: data.checkedAt || null, cutoff: data.cutoff || null, events: Object.values(data.events || {}) };
}

const norm = (value) => String(value || "").toUpperCase().replace(/\s+/g, "");
const eventTokens = (event) => [...(event.partNumbers || []), ...(event.rfqNumbers || [])].map(norm).filter((token) => token.length >= 4);

// Part and RFQ numbers a case answers to.
function caseTokens(kase) {
  const numbers = [...String([kase.reference, kase.monitorReference].join(" ")).matchAll(/\bRFQ\s*#?\s*-?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/gi)].map((match) => match[1]);
  return [...kase.lines.map((line) => line.partNumber), ...numbers].map(norm).filter((token) => token.length >= 4);
}

// Messages about this case: the customer's domain and a shared part or RFQ number.
export function caseMail(kase, events) {
  const domains = (kase.customerRecord?.emailDomains || []).map((domain) => domain.toLowerCase());
  if (!domains.length) return { sent: null, latest: null };
  const mine = caseTokens(kase);
  const related = events.filter((event) => domains.includes(String(event.customerDomain || "").toLowerCase()) && eventTokens(event).some((token) => mine.some((own) => own === token || own.includes(token) || token.includes(own))));
  const byTime = related.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const sent = byTime.find((event) => event.kind === "quote-sent" && (!kase.askedAt || event.at >= kase.askedAt)) || null;
  return { sent, latest: byTime.at(-1) || null };
}

// Requests and chases the check found that nothing else on the board shows:
// no price page, no later quote, and no monitor entry that `monitorCovers`
// accepts (the board passes its own rule; by default any entry counts). The
// newest message per customer and subject, with the monitor entry it matched.
export function newRequests(events, cases, queue, monitorCovers = () => true) {
  const entriesFor = (event) => {
    const tokens = eventTokens(event);
    return tokens.length ? queue.filter((entry) => tokens.some((token) => norm(entry.reference).includes(token))) : [];
  };
  const covered = (event) => {
    const tokens = eventTokens(event);
    const domain = String(event.customerDomain || "").toLowerCase();
    const onCase = cases.some((kase) => (kase.customerRecord?.emailDomains || []).map((d) => d.toLowerCase()).includes(domain) && (!tokens.length || caseTokens(kase).some((own) => tokens.some((token) => own === token || own.includes(token) || token.includes(own)))));
    return onCase || entriesFor(event).some((entry) => monitorCovers(entry, event));
  };
  const answered = (event) => events.some((other) => other.kind === "quote-sent" && other.customerDomain === event.customerDomain && other.at > event.at && eventTokens(other).some((token) => eventTokens(event).includes(token)));
  const latest = new Map();
  for (const event of events.filter((item) => (item.kind === "rfq" || item.kind === "followup") && !covered(item) && !answered(item))) {
    const key = `${String(event.customerDomain).toLowerCase()}|${norm(event.subject).replace(/^(RE|FW|FWD):/g, "")}`;
    if (!latest.has(key) || latest.get(key).at < event.at) latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).map((event) => {
    const byNumber = entriesFor(event)[0];
    const entry = byNumber || sameCustomerEntry(event, queue);
    return { ...event, monitor: entry ? { reference: entry.reference, section: entry.priority_section ?? null, status: entry.status ?? null, dueDate: entry.explicit_due_date || null, lastActivityAt: entry.last_observed_activity_at || null, matchedBy: byNumber ? "number" : "customer" } : null };
  });
}

// With no shared number, the customer's most recently active monitor entry:
// one whose senders use the message's email domain. Shown for context only;
// it never hides a message, since the customer may have more than one request.
function sameCustomerEntry(event, queue) {
  const domain = String(event.customerDomain || "").toLowerCase();
  if (!domain) return null;
  const actors = (entry) => [entry.last_observed_actor, ...(entry.events || []).map((item) => item.actor)];
  return queue
    .filter((entry) => actors(entry).some((actor) => String(actor || "").toLowerCase().endsWith(`@${domain}`)))
    .sort((a, b) => String(b.last_observed_activity_at || "").localeCompare(String(a.last_observed_activity_at || "")))[0] || null;
}

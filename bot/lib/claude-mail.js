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

// Requests and chases the check found that match no price page and no
// monitor entry: the newest message per customer and subject.
export function newRequests(events, cases, queue) {
  const covered = (event) => {
    const tokens = eventTokens(event);
    const domain = String(event.customerDomain || "").toLowerCase();
    const onCase = cases.some((kase) => (kase.customerRecord?.emailDomains || []).map((d) => d.toLowerCase()).includes(domain) && (!tokens.length || caseTokens(kase).some((own) => tokens.some((token) => own === token || own.includes(token) || token.includes(own)))));
    const inMonitor = tokens.length && queue.some((entry) => tokens.some((token) => norm(entry.reference).includes(token)));
    return onCase || inMonitor;
  };
  const answered = (event) => events.some((other) => other.kind === "quote-sent" && other.customerDomain === event.customerDomain && other.at > event.at && eventTokens(other).some((token) => eventTokens(event).includes(token)));
  const latest = new Map();
  for (const event of events.filter((item) => (item.kind === "rfq" || item.kind === "followup") && !covered(item) && !answered(item))) {
    const key = `${String(event.customerDomain).toLowerCase()}|${norm(event.subject).replace(/^(RE|FW|FWD):/g, "")}`;
    if (!latest.has(key) || latest.get(key).at < event.at) latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

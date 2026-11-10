import { extractSheetQuotes, extractTemplateQuotes, htmlToText, splitLatestAuthored } from "./email-evidence.js";
import { partNumberMatch } from "./part-history.js";
import { spelledRfqNumbers } from "./claude-mail.js";

// The reviewer's own quote email is their decision (ruling sent-quote-is-decision-v1):
// once a quote leaves QPC for the customer, each line it prices is recorded as
// decided by the sender, at the price sent and in the sender's own words. The
// email is read by an authorized session and handed in as
// { id, from, to, cc, sentAt, subject, body, bodyType }; nothing here reads mail.
// Only the newest authored text counts, so an older quote quoted below the
// reply can never be taken for this one. A line the email does not price is
// left open rather than guessed.

const domainOf = (address) => String(address || "").toLowerCase().split("@")[1] || "";
const cents = (value) => Math.round(Number(value) * 100);

export const SENT_QUOTE_RULING = "sent-quote-is-decision-v1";

export function readSentQuote({ decision, email, approverAddresses = {} }) {
  const problems = [];
  const sender = String(email.from || "").toLowerCase();
  const decidedBy = Object.entries(approverAddresses).find(([address]) => address.toLowerCase() === sender)?.[1] || null;
  if (!decidedBy) problems.push(`sender ${email.from || "unknown"} is not a listed approver address`);
  const customerDomains = (decision.customer.emailDomains || []).map((item) => item.toLowerCase());
  const recipients = [...(email.to || []), ...(email.cc || [])].map((item) => String(item).toLowerCase());
  if (!recipients.some((address) => customerDomains.includes(domainOf(address)))) problems.push(`no recipient at the customer's domain (${customerDomains.join(", ") || "none on file"})`);
  if (!email.sentAt) problems.push("the email has no sent time");

  const text = email.bodyType === "html" ? htmlToText(email.body) : String(email.body || "");
  const { latest } = splitLatestAuthored(text);
  const lines = decision.lines.map((line) => {
    const aliases = (line.request.aliases || []).map((alias) => alias.value || alias);
    const rows = [...extractTemplateQuotes(latest, line.request.partNumber, aliases), ...extractSheetQuotes(latest, line.request.partNumber, aliases)];
    const quantity = line.request.quantity;
    const exact = rows.filter((row) => row.quantity === quantity);
    const loose = rows.filter((row) => row.quantity == null);
    const pool = exact.length ? exact : loose.length ? loose : rows.length && new Set(rows.map((row) => cents(row.unitPrice))).size === 1 ? rows : [];
    const prices = new Set(pool.map((row) => cents(row.unitPrice)));
    if (!pool.length) return { lineId: line.lineId, partNumber: line.request.partNumber, quantity, found: false, reason: rows.length ? "the email prices this part at other quantities with different prices" : "the email does not price this part" };
    if (prices.size > 1) return { lineId: line.lineId, partNumber: line.request.partNumber, quantity, found: false, reason: "the email gives this part more than one price at this quantity" };
    const row = pool[0];
    const suggested = line.recommendation.preferred?.unitPrice ?? null;
    return {
      lineId: line.lineId,
      partNumber: line.request.partNumber,
      quantity,
      found: true,
      unitPrice: row.unitPrice,
      choice: suggested != null && cents(suggested) === cents(row.unitPrice) ? "approved" : "alternative",
      words: row.line,
    };
  });
  return { ok: problems.length === 0, problems, decidedBy, decidedAt: email.sentAt || null, lines };
}

// The note kept with each decision: where the words came from, then the words.
export function sentQuoteNote(email, words) {
  return `Sent quote ${email.sentAt} to ${(email.to || []).join(", ")} ("${email.subject || ""}"), message ${email.id}: ${words}`;
}

// ---- For the board's "price from the quote sent …" chip -------------------
// from-sent keeps, on each price it records, a note naming the sent quote it
// read and the row that priced the line. When every line of a case carries
// such a note for its price as decided now, the board says so on the card.
// That is a wording on a card and nothing else: it never moves a card, closes
// it or takes it out of a count, so everything here is read strictly and
// anything unsure gives no chip.

// The sent time in a note sentQuoteNote wrote (UTC ISO), its subject, message
// id and kept words; null for any other note, or one with no usable date or
// message id. The whole shape must be there, so a note someone typed that
// merely starts the same way gives nothing.
export function readSentQuoteNote(note) {
  const [, at, subject, words] = String(note || "").match(/^Sent quote (\S+) to \S[^\n]*? \("([^\n]*)"\), message (?!undefined:|null:)\S+: ([\s\S]*)$/) || [];
  const ms = at ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? null : { at: new Date(ms).toISOString(), subject, words };
}

// False unless the subject plainly belongs to this request: when it names any
// RFQ number, the request must name RFQ numbers too and every one in the
// subject must be among them; a number after "RFQ" that cannot be made out
// counts against it.
function subjectIsThisRequest(subject, decision) {
  const named = spelledRfqNumbers(subject);
  if (named.unread) return false;
  if (!named.length) return true;
  const own = spelledRfqNumbers([decision.rfq?.reference, decision.rfq?.monitorReference].join(" "));
  return own.length > 0 && named.every((number) => own.includes(number));
}

const NOTE_FIELD = /^(P\/N|Qty|Unit Price|Process|Material):\s*(.*)$/i;
const PRICE_FIELD = /^\$\s*(\d[\d,]*(?:\.\d{1,2})?)(?:\s*\/?\s*(?:ea|each)\.?)?$/i;
const PACKING_NOTE = /^\((?:individually packed|\d+\s*(?:ea|pcs?)\s*per\s*(?:pack|bag|box))\)$/i;
// The quantities in a list such as "18, 54 & 72" or "500 & 5,000", read once
// from left to right; null when the text is anything but such a list. A comma
// belongs to a number only as thousands grouping, so "10,20" is 10 and 20 and
// "10,2000" is 10 and 2000.
function quantitiesListed(text) {
  const quantities = [];
  let rest = String(text || "").trim();
  for (;;) {
    const number = rest.match(/^(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)/)?.[0];
    if (!number) return null;
    quantities.push(Number(number.replaceAll(",", "")));
    rest = rest.slice(number.length);
    if (!rest) return quantities;
    const separator = rest.match(/^\s*(?:,|&|and|or)\s*/i)?.[0];
    if (!separator) return null;
    rest = rest.slice(separator.length);
  }
}

// Whether a note's kept words plainly give this price for this line at its
// very quantity. The words are the quote template's fields joined with " / ":
// every piece must be one of those fields, each of P/N, Qty and Unit Price
// exactly once (so a stray piece, which may be a hedge, or a second price,
// gives nothing); the price field must hold nothing but the price; the Qty
// field nothing but a list of numbers, with at most a packing note in
// brackets; and the P/N must be this line's part.
function wordsGivePrice(words, line, unitPrice) {
  const fields = new Map();
  for (const piece of String(words || "").split(" / ").map((item) => item.trim()).filter(Boolean)) {
    const [, label, value] = piece.match(NOTE_FIELD) || [];
    const key = label?.toLowerCase();
    if (!key || (fields.has(key) && ["p/n", "qty", "unit price"].includes(key))) return false;
    fields.set(key, value.trim());
  }
  if (!fields.has("p/n") || !fields.has("qty") || !fields.has("unit price")) return false;
  const price = fields.get("unit price").match(PRICE_FIELD)?.[1];
  if (!price || cents(price.replaceAll(",", "")) !== cents(unitPrice)) return false;
  const [, list, packing] = fields.get("qty").match(/^(.*?)\s*(\([^()]*\))?$/) || [];
  if (packing && !PACKING_NOTE.test(packing)) return false;
  if (!quantitiesListed(list)?.includes(line.request.quantity)) return false;
  const aliases = (line.request.aliases || []).map((alias) => alias.value || alias);
  const part = partNumberMatch(fields.get("p/n"), line.request.partNumber, aliases);
  return Boolean(part) && part.kind !== "partial-token";
}

// The newest sent quote in which every line's price, as decided now, was
// read (see above), else null. A line counts only through its CURRENT
// decision: one that from-sent recorded (dated the moment the quote went
// out, as from-sent dates it), on or after the day the request came in, from
// an email whose subject is this request's, and whose kept words plainly give
// that very price for that very quantity.
export function quoteEmailAt(decision, view) {
  const asked = Date.parse(decision.rfq?.initiatedAt || "");
  const dates = decision.lines.map((line) => {
    const current = view.current.get(line.lineId);
    if (!current || current.choice === "correction") return null;
    const note = readSentQuoteNote(current.note);
    if (!note || Date.parse(note.at) !== Date.parse(current.decidedAt) || Date.parse(note.at) < asked) return null;
    if (!subjectIsThisRequest(note.subject, decision)) return null;
    return wordsGivePrice(note.words, line, current.unitPrice) ? note.at : null;
  });
  return dates.length > 0 && dates.every(Boolean) ? [...dates].sort().at(-1) : null;
}

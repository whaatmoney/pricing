import { extractSheetQuotes, extractTemplateQuotes, htmlToText, splitLatestAuthored } from "./email-evidence.js";

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

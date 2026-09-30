import assert from "node:assert/strict";
import test from "node:test";
import { readSentQuote, sentQuoteNote } from "../../bot/lib/sent-quote.js";

const decision = {
  customer: { name: "Acme Precision Corp", emailDomains: ["acme.example"] },
  lines: [
    { lineId: "L1", request: { partNumber: "ABC-100", aliases: [], quantity: 10 }, recommendation: { preferred: { unitPrice: 8.5 } } },
    { lineId: "L2", request: { partNumber: "DEF-200", aliases: [], quantity: 4 }, recommendation: { preferred: { unitPrice: 12 } } },
    { lineId: "L3", request: { partNumber: "GHI-300", aliases: [], quantity: 2 }, recommendation: { preferred: null } },
  ],
};
const approverAddresses = { "pat@shop.example": "Pat Reviewer" };
const email = (body, overrides = {}) => ({ id: "m1", from: "pat@shop.example", to: ["buyer@acme.example"], cc: [], sentAt: "2026-09-29T17:00:00Z", subject: "RE: RFQ 9", body, ...overrides });

const QUOTE = `Thank you for your RFQ. Please see our quote below:

P/N: ABC-100
Qty: 10
Unit Price: $8.50

P/N: DEF-200
Qty: 4
Unit Price: $11.00

Please let me know how you'd like to proceed.`;

test("a sent quote in the reviewer's template decides each line it prices, at the price sent", () => {
  const read = readSentQuote({ decision, email: email(QUOTE), approverAddresses });
  assert.equal(read.ok, true);
  assert.equal(read.decidedBy, "Pat Reviewer");
  assert.equal(read.decidedAt, "2026-09-29T17:00:00Z");
  const [l1, l2, l3] = read.lines;
  assert.deepEqual([l1.found, l1.choice, l1.unitPrice], [true, "approved", 8.5], "the suggested price, sent as is");
  assert.deepEqual([l2.found, l2.choice, l2.unitPrice], [true, "alternative", 11], "a different price is the reviewer's own");
  assert.equal(l3.found, false, "a line the email does not price stays open");
  assert.match(sentQuoteNote(email(QUOTE), l1.words), /^Sent quote 2026-09-29T17:00:00Z to buyer@acme\.example \("RE: RFQ 9"\), message m1: P\/N: ABC-100/);
});

test("only the newest authored text counts; an older quote below the reply is never taken for this one", () => {
  const body = `Thanks, we are reviewing and will send pricing tomorrow.

From: Pat Reviewer <pat@shop.example>
Sent: Monday, May 4, 2026 9:00 AM
To: buyer@acme.example

${QUOTE}`;
  const read = readSentQuote({ decision, email: email(body), approverAddresses });
  assert.ok(read.lines.every((line) => !line.found));
});

test("a quote is not a decision unless an approver sent it to the customer", () => {
  assert.match(readSentQuote({ decision, email: email(QUOTE, { from: "someone@shop.example" }), approverAddresses }).problems.join(), /not a listed approver/);
  assert.match(readSentQuote({ decision, email: email(QUOTE, { to: ["colleague@shop.example"] }), approverAddresses }).problems.join(), /no recipient at the customer's domain/);
  assert.equal(readSentQuote({ decision, email: email(QUOTE, { to: ["x@shop.example"], cc: ["buyer@acme.example"] }), approverAddresses }).ok, true, "a customer on cc counts");
});

test("two different prices for the same part and quantity leave the line open", () => {
  const body = "P/N: ABC-100\nQty: 10\nUnit Price: $8.50\n\nP/N: ABC-100\nQty: 10\nUnit Price: $9.00";
  const [l1] = readSentQuote({ decision, email: email(body), approverAddresses }).lines;
  assert.equal(l1.found, false);
  assert.match(l1.reason, /more than one price/);
});

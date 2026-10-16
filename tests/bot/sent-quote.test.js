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

// Quotes laid out as a table (the JRI thermistor quote of 2026-10-15 was one):
// the connector gives the plain-text form one cell per line, and an HTML body
// one row per line once converted. Both decide the lines they price.
const TABLE_TEXT = `Thanks for your patience. Please see your estimated pricing below:

P/N
UNIT PRICE
ABC-100 Rev A
$8.50
DEF-200 Rev A
$11.00
Vacuum Bakeout
$500.00

Process:

Standard Lead Time: 8-10 business days`;

test("a quote sent as a part / price table, one cell per line, decides each part it lists", () => {
  const read = readSentQuote({ decision, email: email(TABLE_TEXT), approverAddresses });
  assert.equal(read.ok, true);
  const [l1, l2, l3] = read.lines;
  assert.deepEqual([l1.found, l1.choice, l1.unitPrice, l1.words], [true, "approved", 8.5, "ABC-100 Rev A | $8.50"]);
  assert.deepEqual([l2.found, l2.choice, l2.unitPrice], [true, "alternative", 11]);
  assert.equal(l3.found, false, "a part the table does not list stays open; the bakeout row is not a part");
});

test("an HTML table with a quantity column decides at the quantity it prices", () => {
  const html = `<div>Please see pricing:</div><table><tr><td><div>P/N</div></td><td>QTY</td><td>Unit Price</td></tr><tr><td><div>ABC-100</div></td><td>10</td><td>$8.50</td></tr><tr><td>DEF-200</td><td>40</td><td>$9.00</td></tr><tr><td>DEF-200</td><td>400</td><td>$8.00</td></tr></table><div>Lead time 8-10 days</div>`;
  const [l1, l2] = readSentQuote({ decision, email: email(html, { bodyType: "html" }), approverAddresses }).lines;
  assert.deepEqual([l1.found, l1.unitPrice, l1.words], [true, 8.5, "ABC-100 | 10 | $8.50"]);
  assert.equal(l2.found, false, "priced at other quantities, at different prices");
  assert.match(l2.reason, /other quantities/);
});

test("a table below the reply, or a header with no price column, is not a quote", () => {
  const quoted = `We will have pricing tomorrow.\n\nFrom: Pat Reviewer <pat@shop.example>\nSent: Monday\n\n${TABLE_TEXT}`;
  assert.ok(readSentQuote({ decision, email: email(quoted), approverAddresses }).lines.every((line) => !line.found));
  const noPrice = "P/N\nQTY\nABC-100\n10\nDEF-200\n4";
  assert.ok(readSentQuote({ decision, email: email(noPrice), approverAddresses }).lines.every((line) => !line.found));
});

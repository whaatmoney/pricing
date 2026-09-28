import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessage, extractPriceRows, extractTerms, htmlToText, parsePurchaseOrder, splitLatestAuthored } from "../../bot/lib/email-evidence.js";
import { purchaseOrderText } from "./helpers.js";

const context = { partNumber: "ABC-100", aliases: [], customerDomains: ["acme.example"], internalDomains: ["qpc.example"] };
const message = (overrides) => ({ id: "m1", mailbox: "a@qpc.example", subject: "RFQ", from: "buyer@acme.example", to: ["sales@qpc.example"], cc: [], receivedAt: "2026-01-01T00:00:00Z", bodyFormat: "text", body: "", attachments: [], ...overrides });

test("the newest authored text is separated from quoted history", () => {
  const { latest, quoted } = splitLatestAuthored("New price below.\n\nFrom: Buyer <b@acme.example>\nSent: Monday\nSubject: old\n\nOld text");
  assert.equal(latest, "New price below.");
  assert.match(quoted, /Old text/);
  assert.equal(splitLatestAuthored("Yes, still valid\n________________________________\nFrom: x").latest, "Yes, still valid");
  assert.equal(splitLatestAuthored("Revised.\n\n* * *\n\n**From:** x\n**Sent:** y").latest, "Revised.");
});

test("HTML bodies keep table rows on one line", () => {
  assert.equal(htmlToText("<table><tr><td>ABC-100</td><td>500</td><td>$7.50</td></tr></table>"), "ABC-100 | 500 | $7.50 |");
});

test("a revised estimate is read from its authored text, not its subject or quoted older price", () => {
  const body = "Without oxygen service, see the estimated pricing below:\nP/N | QTY | UNIT PRICE\nABC-100 | 5000 | $7.00\n\n* * *\n\n**From:** Estimator <e@qpc.example>\n**Sent:** Monday\n\nFor oxygen service:\nABC-100 | 5000 | $9.00";
  const result = classifyMessage(message({ subject: "Re: Pricing for Oxygen Service", from: "e@qpc.example", to: ["buyer@acme.example"], body }), context);
  assert.equal(result.type, "qpc-sent-estimate");
  assert.deepEqual(result.prices.map((price) => [price.unitPrice, price.quantity]), [[7, 5000]]);
  assert.equal(result.scopeLatest.oxygen, "not-for");
  assert.equal(result.subjectScopeConflict, true);
});

test("a QPC sender is not a customer-facing quote without a customer recipient", () => {
  const result = classifyMessage(message({ from: "e@qpc.example", to: ["jay@qpc.example"], body: "ABC-100 | 500 | $7.50" }), context);
  assert.equal(result.type, "internal");
});

test("acknowledgments and validity replies are kept distinct from quotes", () => {
  assert.equal(classifyMessage(message({ from: "desk@qpc.example", to: ["buyer@acme.example"], body: "We've received your request and assigned it an RFQ# of RFQ-1." }), context).type, "qpc-acknowledgment");
  const valid = classifyMessage(message({ from: "desk@qpc.example", to: ["buyer@acme.example"], body: "Yes, it's still valid.\n________________________________\nFrom: Buyer\nSent: Monday\nIs the ABC-100 price still valid?" }), context);
  assert.equal(valid.type, "qpc-validity-confirmation");
  assert.deepEqual(valid.prices, []);
});

test("a price for a sibling part is never attributed to the requested part", () => {
  const sibling = classifyMessage(message({ from: "e@qpc.example", to: ["buyer@acme.example"], body: "The unit price would be $7.00 each plus $1.00 per inch after the first inch re: PN: ABC-120 Rev. B" }), context);
  assert.notEqual(sibling.type, "qpc-sent-estimate");
  assert.deepEqual(extractPriceRows("We had pricing confirmed for ABC-10E for a total of $7.50.\nABC-100 qty 139", "ABC-100"), []);
});

test("size-based pricing is captured as a rule", () => {
  assert.deepEqual(extractTerms("Unit price would be $7.00 each plus $1.00 per inch after the first inch").sizeRule, { base: 7, perInch: 1, includedInches: 1, text: "$7.00 each plus $1.00 per inch after the first inch" });
  const terms = extractTerms("**Lot Minimum Charge:**  $350\n**Standard Lead Time:**  8-10 business days\n* $1,200 – 2-3 business days\n* $600 – 4-5 business days\nEstimate valid for 90 days.");
  assert.equal(terms.lotMinimum, 350);
  assert.equal(terms.validityDays, 90);
  assert.deepEqual(terms.expediteOptions, [{ fee: 1200, businessDays: "2-3" }, { fee: 600, businessDays: "4-5" }]);
});

test("purchase-order text is cross-checked before its price is trusted", () => {
  const po = parsePurchaseOrder(purchaseOrderText({ revision: 1, expedite: "2400", total: "6,480.00" }), "ABC-100");
  assert.equal(po.poNumber, "PO1-100");
  assert.equal(po.revision, 1);
  assert.equal(po.date, "2026-05-27");
  assert.equal(po.unitPrice, 8.5);
  assert.equal(po.quantity, 480);
  assert.equal(po.uom, "EA");
  assert.equal(po.expediteFee, 2400);
  assert.equal(po.total, 6480);
  assert.deepEqual(po.checks, { quantityTimesUnitEqualsExtended: true, quantityPresentInText: true, totalEqualsExtendedPlusExpedite: true });
  assert.equal(po.partMatch, "formatting-variant");
  assert.equal(po.revisionOfPart, "B");
  assert.equal(po.scope.oxygen, "not-for");
  assert.equal(po.scope.level, "300R4");
  assert.equal(po.customerWorkOrder, "W1-100");
  assert.equal(po.approvedBy, "Pat Buyer");
});

test("a PO whose extended price does not equal quantity x unit yields no quantity", () => {
  const po = parsePurchaseOrder(purchaseOrderText({ extended: "4,000.00", quantity: 480 }), "ABC-100");
  assert.equal(po.quantity, null);
  assert.equal(po.checks.quantityTimesUnitEqualsExtended, false);
});

test("a lot-priced PO carries its unit of measure", () => {
  assert.equal(parsePurchaseOrder(purchaseOrderText({ uom: "Lot", unit: "350.00", extended: "350.00", quantity: 1 }), "ABC-100").uom, "LOT");
});

test("customer POs, drawings, holds and unread revisions are typed", () => {
  const po = classifyMessage(message({ attachments: [{ name: "PO1-100.pdf", text: purchaseOrderText() }] }), context);
  assert.equal(po.type, "customer-po");
  assert.equal(classifyMessage(message({ body: "This order has been placed on hold and is under review" }), context).type, "customer-order-status");
  assert.equal(classifyMessage(message({ body: "see attached for PO qty has been revised", attachments: [{ name: "revised PO", text: null }] }), context).type, "customer-po-unread");
  assert.equal(classifyMessage(message({ body: "please see attached drawing", attachments: [{ name: "dwg.pdf", text: "SEAL (TABULATED) DWG. NO. 1" }] }), context).type, "customer-drawing");
  assert.equal(classifyMessage(message({ body: "Can you please provide pricing for ABC-100 Qty: 500" }), context).type, "customer-rfq");
  assert.equal(classifyMessage(message({ body: "Please quote the following:\nABC-100 Rev B  Qty 500" }), context).type, "customer-rfq");
  assert.equal(classifyMessage(message({ body: "Kindly quote the following part, drawing attached for reference." }), context).type, "customer-rfq");
  assert.equal(classifyMessage(message({ body: "Following up on the below." }), context).type, "customer-followup");
});

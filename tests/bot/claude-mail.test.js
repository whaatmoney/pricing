import assert from "node:assert/strict";
import test from "node:test";
import { caseMail, newRequests } from "../../bot/lib/claude-mail.js";

const acme = { customerRecord: { name: "Acme Precision", emailDomains: ["acme.example"] }, askedAt: "2026-09-10T15:00:00Z", reference: "Acme RFQ 4100", monitorReference: null, lines: [{ partNumber: "ABC-1000" }] };
const event = (id, at, kind, extra = {}) => ({ id, at, kind, customerDomain: "acme.example", from: "pat@shop.example", to: ["buyer@acme.example"], subject: "RE: RFQ 4100", partNumbers: ["ABC-1000"], rfqNumbers: [], link: `https://mail.example/${id}`, ...extra });

test("a quote sent to the customer's domain naming the case's part or RFQ number marks the case sent", () => {
  const events = [event("1", "2026-09-10T15:00:00Z", "rfq", { from: "buyer@acme.example" }), event("2", "2026-09-12T15:00:00Z", "quote-sent"), event("3", "2026-09-13T15:00:00Z", "followup", { from: "buyer@acme.example" })];
  const mail = caseMail(acme, events);
  assert.equal(mail.sent.id, "2");
  assert.equal(mail.latest.id, "3", "the newest related message is the latest reply");
  assert.equal(caseMail(acme, [event("9", "2026-09-12T15:00:00Z", "quote-sent", { partNumbers: ["XYZ-2"], rfqNumbers: [] })]).sent, null, "another part is another request");
  assert.equal(caseMail(acme, [event("8", "2026-09-12T15:00:00Z", "quote-sent", { customerDomain: "other.example" })]).sent, null, "another customer is another request");
  assert.equal(caseMail(acme, [event("7", "2026-09-01T15:00:00Z", "quote-sent")]).sent, null, "a quote before the request is an older one");
  assert.equal(caseMail(acme, [event("6", "2026-09-12T15:00:00Z", "quote-sent", { partNumbers: [], rfqNumbers: ["4100"] })]).sent.id, "6", "the RFQ number is enough");
});

test("new requests are the ones no page, no monitor entry and no later quote covers", () => {
  const found = newRequests([
    event("1", "2026-09-20T15:00:00Z", "rfq", { customerDomain: "beta.example", partNumbers: ["QQ-7777"], subject: "RFQ QQ-7777" }),
    event("2", "2026-09-21T15:00:00Z", "followup", { customerDomain: "beta.example", partNumbers: ["QQ-7777"], subject: "RE: RFQ QQ-7777" }),
    event("3", "2026-09-20T15:00:00Z", "rfq"),
    event("4", "2026-09-20T15:00:00Z", "rfq", { customerDomain: "gamma.example", partNumbers: ["MM-5555"], subject: "RFQ MM-5555" }),
    event("5", "2026-09-22T15:00:00Z", "quote-sent", { customerDomain: "gamma.example", partNumbers: ["MM-5555"] }),
    event("6", "2026-09-20T15:00:00Z", "rfq", { customerDomain: "delta.example", partNumbers: ["DD-4444"], subject: "RFQ DD-4444" }),
  ], [acme], [{ customer: "Delta", reference: "DD-4444 / September20" }]);
  assert.deepEqual(found.map((item) => item.id), ["2"], "Beta's chase stands for its thread; Acme has a page, Gamma was quoted, Delta is in the monitor");
});

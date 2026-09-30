import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, renderBoard } from "../../bot/lib/board.js";
import { caseMail, newRequests } from "../../bot/lib/claude-mail.js";
import { tempDir } from "./helpers.js";

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

test("a monitor entry hides a request only when the board says it covers it, and a listed one carries the entry", () => {
  const events = [
    event("1", "2026-09-30T16:00:00Z", "followup", { customerDomain: "orbit.example", partNumbers: [], rfqNumbers: ["RFQ-ZZ-9990001"], subject: "RE: RFQ-ZZ-9990001" }),
    event("2", "2026-09-30T16:00:00Z", "rfq", { customerDomain: "harbor.example", partNumbers: [], rfqNumbers: ["55120"], subject: "Harbor RFQ / 55120" }),
  ];
  const queue = [
    { customer: "Orbit Aero", reference: "RFQ-ZZ-9990001 / Bracket Kit", priority_section: 2, status: "Acknowledged; quote pending", explicit_due_date: "2026-09-30" },
    { customer: "Harbor Metals", reference: "RFQ 55120", priority_section: 1, status: "New RFQ" },
  ];
  const found = newRequests(events, [], queue, (entry) => entry.priority_section === 1);
  assert.deepEqual(found.map((item) => item.id), ["1"], "Harbor's entry is on the board; Orbit Aero's is not");
  assert.deepEqual(found[0].monitor, { reference: "RFQ-ZZ-9990001 / Bracket Kit", section: 2, status: "Acknowledged; quote pending", dueDate: "2026-09-30", lastActivityAt: null, matchedBy: "number" });
  assert.deepEqual(newRequests(events, [], queue).map((item) => item.id), [], "without a rule, any monitor entry covers its requests");
});

test("with no shared number, the customer's latest monitor entry gives context but never hides the message", () => {
  const chase = event("1", "2026-09-30T12:20:50Z", "followup", { customerDomain: "act.example", partNumbers: [], rfqNumbers: [], subject: "RE: ACT RFQ IPA" });
  const queue = [
    { customer: "ACT", reference: "Old job", priority_section: 1, status: "New RFQ", last_observed_activity_at: "2026-09-01T00:00:00Z", last_observed_actor: "ethan@act.example" },
    { customer: "ACT", reference: "IPA / 25L", priority_section: 2, status: "Customer still awaiting reorder quote", last_observed_activity_at: "2026-09-30T12:20:50Z", events: [{ actor: "ethan@act.example" }] },
    { customer: "Other", reference: "IPA / 5L", priority_section: 2, status: "Pending", last_observed_activity_at: "2026-09-30T13:00:00Z", events: [{ actor: "buyer@other.example" }] },
  ];
  const [found] = newRequests([chase], [], queue, (entry) => entry.priority_section === 1);
  assert.equal(found.id, "1", "a section 1 entry for the same customer does not hide it");
  assert.equal(found.monitor.reference, "IPA / 25L");
  assert.equal(found.monitor.matchedBy, "customer");
  assert.equal(newRequests([{ ...chase, customerDomain: "nobody.example" }], [], queue)[0].monitor, null);
});

test("the board lists mail-check requests whose monitor entry it does not show, with where they stand", () => {
  const dir = tempDir("qpc-claude-mail-");
  const monitorStatePath = path.join(dir, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-09-30T16:00:00Z", stale: false }, operational_queue: [
    { customer: "Orbit Aero", reference: "RFQ-ZZ-9990001 / Bracket Kit", priority_section: 2, status: "Customer-facing acknowledgment; quote pending", explicit_due_date: "2026-09-30", last_observed_activity_at: "2026-09-29T16:18:35Z" },
    { customer: "Harbor Metals", reference: "RFQ 55120", priority_section: 1, status: "New RFQ" },
    { customer: "Gamma", reference: "RFQ 7001", priority_section: 3, status: "Quote sent; waiting on customer", last_observed_activity_at: "2026-09-30T18:00:00Z" },
    { customer: "Delta", reference: "RFQ 8001", priority_section: 3, status: "Quote sent; waiting on customer", last_observed_activity_at: "2026-09-29T18:00:00Z" },
  ] }));
  const claudeMailPath = path.join(dir, "claude-mail.json");
  const mail = [
    event("orbit", "2026-09-30T16:34:01.000Z", "followup", { customerDomain: "orbit.example", partNumbers: [], rfqNumbers: ["RFQ-ZZ-9990001"], subject: "RE: RFQ-ZZ-9990001 (Due 09/30)" }),
    event("harbor", "2026-09-30T14:32:34.000Z", "rfq", { customerDomain: "harbor.example", partNumbers: [], rfqNumbers: ["55120"], subject: "Re: Harbor RFQ / 55120" }),
    event("gamma", "2026-09-30T15:00:00.000Z", "followup", { customerDomain: "gamma.example", partNumbers: [], rfqNumbers: ["7001"], subject: "RE: RFQ 7001" }),
    event("delta", "2026-09-30T15:00:00.000Z", "followup", { customerDomain: "delta.example", partNumbers: [], rfqNumbers: ["8001"], subject: "RE: RFQ 8001" }),
  ];
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-09-30T16:48:02Z", events: Object.fromEntries(mail.map((item) => [item.id, item])) }));
  const board = buildBoard({ outputsDir: dir, monitorStatePath, claudeMailPath, now: new Date("2026-09-30T17:00:00Z") });
  assert.deepEqual(board.mailFound.map((item) => item.id), ["orbit", "delta"], "Harbor is listed from the monitor and Gamma was quoted after its chase; Orbit Aero's entry is acknowledged only, Delta chased after its quote");
  const html = renderBoard(board);
  assert.match(html, /Customer-facing acknowledgment; quote pending/);
  assert.match(html, /Mail monitor · RFQ-ZZ-9990001 \/ Bracket Kit/);
  assert.match(html, /Due Sep 30, 2026/);
  assert.doesNotMatch(html, /not in the monitor/i);
});

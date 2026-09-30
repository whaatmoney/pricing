import assert from "node:assert/strict";
import test from "node:test";
import { companyMatches, followupThreads, matchThread, monitorFor, parsePost } from "../../bot/lib/followups.js";

const post = (id, at, text, replyTo = null) => ({ id, at, from: "Front Desk", replyTo, text });

test("a front desk post names the contact, company and request, in each wording the desk uses", () => {
  assert.deepEqual(parsePost("Pat from Acme Precision, Inc. is F/U on this request: RFQ 4100 Clean\n@Pat Reviewer"), { contact: "Pat", company: "Acme Precision, Inc", subject: "RFQ 4100 Clean" });
  assert.deepEqual(parsePost("New customer: Zeta Works Sam is F/U on this request: Quote bath cleaning"), { contact: "Sam", company: "Zeta Works", subject: "Quote bath cleaning" });
  assert.deepEqual(parsePost("Lee is F/U on this request: Omega RFQ: 7788/ Clean"), { contact: "Lee", company: "Omega", subject: "Omega RFQ: 7788/ Clean" });
  assert.equal(parsePost("Quinn from Acme called to see if this RFQ can be done today\nSubject Line: RFQ PR-1234567 CLEAN").subject, "RFQ PR-1234567 CLEAN");
  assert.equal(parsePost("send that to him"), null, "a reply that is not a follow-up is not a thread");
});

test("replies that quote a post join its thread, count up, and mark it urgent when they say so", () => {
  const threads = followupThreads([
    post("1", "2026-09-10T15:00:00Z", "Pat from Acme is F/U on this request: RFQ 4100"),
    post("2", "2026-09-12T15:00:00Z", "2nd f/u\n@Pat Reviewer", "1"),
    post("3", "2026-09-15T15:00:00Z", "3rd follow up per customer: we need this out the door", "2"),
    post("4", "2026-09-14T15:00:00Z", "Sam from Beta is F/U on this request: RFQ 9\ndue tomorrow"),
  ]);
  const [acme, beta] = threads;
  assert.deepEqual([acme.company, acme.count, acme.label, acme.lastAt, acme.urgent], ["Acme", 3, "3rd follow-up", "2026-09-15T15:00:00Z", true]);
  assert.match(acme.note, /we need this out the door/);
  assert.deepEqual([beta.company, beta.urgent, beta.soon], ["Beta", false, true]);
});

test("a follow-up joins a case only on the company and, when it names one, the request's number", () => {
  const kase = (caseId, reference, partNumber) => ({ caseId, reference, monitorReference: null, email: { subject: reference }, customerRecord: { name: "Acme Precision Corporation", aliases: ["ACME PRECISION CORP"] }, lines: [{ partNumber }] });
  const a = kase("ACME-1", "RFQ 4100", "ABC-1000"), b = kase("ACME-2", "RFQ 5200", "XYZ-2000");
  const thread = (company, subject) => ({ company, subject });
  assert.deepEqual(matchThread(thread("Acme", "RFQ 4100 clean"), [a, b]), [a]);
  assert.deepEqual(matchThread(thread("Acme", "part XYZ-2000"), [a, b]), [b]);
  assert.deepEqual(matchThread(thread("Acme", "RFQ"), [a, b]), [], "no number and two cases: not guessed");
  assert.deepEqual(matchThread(thread("Acme", "RFQ"), [a]), [a], "no number and one case: that case");
  assert.deepEqual(matchThread(thread("Acme Aerospace", "RFQ 4100"), [a, b]), [], "a word the case's names lack blocks the match");
  assert.equal(companyMatches("Acme US", a.customerRecord), true, "corporate suffixes are ignored");
});

test("an unmatched follow-up finds the monitor's entry by number, else the company's single open entry", () => {
  const entries = [{ customer: "Acme", reference: "RFQ 4100", priority_section: 3 }, { customer: "Acme", reference: "PO 55", priority_section: 2 }];
  assert.equal(monitorFor({ company: "Acme", subject: "RFQ 4100" }, entries), entries[0]);
  assert.equal(monitorFor({ company: "Acme", subject: "RFQ" }, entries), entries[1]);
  assert.equal(monitorFor({ company: "Gamma", subject: "RFQ" }, entries), null);
});

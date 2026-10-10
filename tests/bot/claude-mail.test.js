import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, renderBoard } from "../../bot/lib/board.js";
import { caseMail, itemIdFromLink, newRequests, normalizeEvent, placeMailEvents, subjectKey } from "../../bot/lib/claude-mail.js";
import { tempDir } from "./helpers.js";
import { useOrg } from "../../bot/lib/org.js";

// A made-up organisation; the real one lives in private config.
useOrg({ domain: "shop.example", mailSources: ["own", "own-sent", "desk@shop.example", "sales@shop.example"], neverRead: ["private@shop.example"] });

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
  assert.equal(caseMail(acme, [event("6", "2026-09-12T15:00:00Z", "quote-sent"), event("5", "2026-09-14T15:00:00Z", "quote-sent", { rfqNumbers: ["14100"] })]).lastSent.id, "6", "a later quote for another RFQ number is not this request's latest quote");
});

test("new requests are the ones no page, no monitor entry and no later quote covers", () => {
  const found = newRequests([
    event("1", "2026-09-20T15:00:00Z", "rfq", { customerDomain: "beta.example", partNumbers: ["QQ-7777"], subject: "RFQ QQ-7777" }),
    event("2", "2026-09-21T15:00:00Z", "followup", { customerDomain: "beta.example", partNumbers: ["QQ-7777"], subject: "RE: RFQ QQ-7777" }),
    event("3", "2026-09-20T15:00:00Z", "rfq"),
    event("4", "2026-09-20T15:00:00Z", "rfq", { customerDomain: "gamma.example", partNumbers: ["MM-5555"], subject: "RFQ MM-5555" }),
    event("5", "2026-09-22T15:00:00Z", "quote-sent", { customerDomain: "gamma.example", partNumbers: ["MM-5555"] }),
    event("6", "2026-09-20T15:00:00Z", "rfq", { customerDomain: "delta.example", partNumbers: ["DD-4444"], subject: "RFQ DD-4444" }),
  ], [acme], [{ customer: "Delta", reference: "DD-4444 / September20" }], () => true);
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
  assert.deepEqual(found[0].monitor, { customer: "Orbit Aero", reference: "RFQ-ZZ-9990001 / Bracket Kit", section: 2, status: "Acknowledged; quote pending", dueDate: "2026-09-30", lastActivityAt: null, matchedBy: "number" });
  assert.deepEqual(newRequests(events, [], queue).map((item) => item.id).sort(), ["1", "2"], "without the board's rule, no monitor entry hides anything");
});

test("with no number at all, the customer's latest monitor entry gives context but never hides the message", () => {
  const chase = event("1", "2026-09-30T11:00:00Z", "followup", { customerDomain: "lumen.example", from: "dana@lumen.example", partNumbers: [], rfqNumbers: [], subject: "RE: Lumen solvent quote" });
  const queue = [
    { customer: "Lumen Thermal", reference: "Old job", priority_section: 1, status: "New RFQ", last_observed_activity_at: "2026-09-01T00:00:00Z", last_observed_actor: "dana@lumen.example" },
    { customer: "Lumen Thermal", reference: "Solvent / 10 L", priority_section: 2, status: "Acknowledged; quote pending", last_observed_activity_at: "2026-09-30T11:00:00Z", events: [{ actor: "dana@lumen.example" }] },
    { customer: "Other", reference: "Solvent / 5 L", priority_section: 2, status: "Pending", last_observed_activity_at: "2026-09-30T13:00:00Z", events: [{ actor: "buyer@other.example" }, { actor: "pat@shop.example" }] },
  ];
  const [found] = newRequests([chase], [], queue, (entry) => entry.priority_section === 1);
  assert.equal(found.id, "1", "a section 1 entry for the same customer does not hide it");
  assert.equal(found.monitor.reference, "Solvent / 10 L");
  assert.equal(found.monitor.matchedBy, "customer");
  assert.equal(newRequests([{ ...chase, customerDomain: "nobody.example" }], [], queue)[0].monitor, null);
  assert.equal(newRequests([{ ...chase, customerDomain: "shop.example" }], [], queue)[0].monitor, null, "QPC's own domain is on every entry, so it names no customer");
  const shared = [{ customer: "Small Shop", reference: "Rinse", priority_section: 2, status: "Pending", events: [{ actor: "shop.owner@gmail.com" }] }];
  assert.equal(newRequests([{ ...chase, customerDomain: "gmail.com", from: "someone.else@gmail.com" }], [], shared)[0].monitor, null, "a shared mail domain is not one customer");
  assert.equal(newRequests([{ ...chase, customerDomain: "gmail.com", from: "Shop.Owner@gmail.com" }], [], shared)[0].monitor.reference, "Rinse", "the same sender address is");
});

test("a numbered request the monitor has no entry for says so, instead of borrowing another job's status", () => {
  const request = event("1", "2026-09-30T11:00:00Z", "rfq", { customerDomain: "orbit.example", partNumbers: [], rfqNumbers: ["RFQ-ZZ-9990077"], subject: "RFQ-ZZ-9990077" });
  const queue = [{ customer: "Orbit Aero", reference: "PO 4410 / site visit", priority_section: 3, status: "Visit confirmed", events: [{ actor: "buyer@orbit.example" }] }];
  const [found] = newRequests([request], [], queue, () => false);
  assert.equal(found.monitor, null);
  const dir = tempDir("qpc-claude-mail-");
  const monitorStatePath = path.join(dir, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-09-30T12:00:00Z", stale: false }, operational_queue: queue }));
  const claudeMailPath = path.join(dir, "claude-mail.json");
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-09-30T12:00:00Z", events: { 1: request } }));
  assert.match(renderBoard(buildBoard({ outputsDir: dir, monitorStatePath, claudeMailPath, now: new Date("2026-09-30T12:30:00Z") })), /No match in the mail monitor/);
});

test("the board lists mail-check requests whose monitor entry it does not show, with where they stand", () => {
  const dir = tempDir("qpc-claude-mail-");
  const monitorStatePath = path.join(dir, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-09-30T16:00:00Z", stale: false }, operational_queue: [
    { customer: "Orbit Aero", reference: "RFQ-ZZ-9990001 / Bracket Kit", priority_section: 2, status: "Customer-facing acknowledgment; quote pending", explicit_due_date: "2026-09-30", last_observed_activity_at: "2026-09-29T16:18:35Z" },
    { customer: "Harbor Metals", reference: "RFQ 55120", priority_section: 1, status: "New RFQ" },
    { customer: "Gamma", reference: "RFQ 7001", priority_section: 3, status: "Quote sent; waiting on customer", last_observed_activity_at: "2026-09-30T18:00:00Z", events: [{ at: "2026-09-30T18:00:00Z", actor: "pat@shop.example" }] },
    { customer: "Delta", reference: "RFQ 8001", priority_section: 3, status: "Quote sent; waiting on customer", last_observed_activity_at: "2026-09-29T18:00:00Z", events: [{ at: "2026-09-29T18:00:00Z", actor: "pat@shop.example" }] },
    { customer: "Kappa", reference: "RFQ 9001", priority_section: 3, status: "Quote sent; waiting on customer", last_observed_activity_at: "2026-09-30T16:28:00Z", events: [{ at: "2026-09-30T16:00:00.401554+00:00", actor: "pat@shop.example" }, { at: "2026-09-30T16:28:00Z", actor: "buyer@kappa.example" }] },
  ] }));
  const claudeMailPath = path.join(dir, "claude-mail.json");
  const mail = [
    event("orbit", "2026-09-30T16:34:01.000Z", "followup", { customerDomain: "orbit.example", partNumbers: [], rfqNumbers: ["RFQ-ZZ-9990001"], subject: "RE: RFQ-ZZ-9990001 (Due 09/30)" }),
    event("harbor", "2026-09-30T14:32:34.000Z", "rfq", { customerDomain: "harbor.example", partNumbers: [], rfqNumbers: ["55120"], subject: "Re: Harbor RFQ / 55120" }),
    event("gamma", "2026-09-30T15:00:00.000Z", "followup", { customerDomain: "gamma.example", partNumbers: [], rfqNumbers: ["7001"], subject: "RE: RFQ 7001" }),
    event("delta", "2026-09-30T15:00:00.000Z", "followup", { customerDomain: "delta.example", partNumbers: [], rfqNumbers: ["8001"], subject: "RE: RFQ 8001" }),
    event("kappa", "2026-09-30T16:15:00.000Z", "followup", { customerDomain: "kappa.example", partNumbers: [], rfqNumbers: ["9001"], subject: "RE: RFQ 9001 question" }),
  ];
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-09-30T16:48:02Z", events: Object.fromEntries(mail.map((item) => [item.id, item])) }));
  const board = buildBoard({ outputsDir: dir, monitorStatePath, claudeMailPath, now: new Date("2026-09-30T17:00:00Z") });
  assert.deepEqual(board.mailFound.map((item) => item.id), ["orbit", "kappa", "delta"], "Harbor is listed from the monitor and QPC wrote to Gamma after its chase; Orbit Aero's entry is acknowledged only, Delta chased after its quote, and only Kappa's own reply came after its question");
  const html = renderBoard(board);
  assert.match(html, /Customer-facing acknowledgment; quote pending/);
  assert.match(html, /Codex mail monitor · RFQ-ZZ-9990001 \/ Bracket Kit/);
  assert.match(html, /Due today/);
  assert.match(html, /1 due today/, "the header counts a request due today even with no page");
  assert.match(html, /id="due"/);
  assert.doesNotMatch(html, /not in the monitor/i);
});

const OWA = (id) => `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`;

test("every kept message has one placement, and a customer writing after a closed page is listed, not hidden", () => {
  const closed = { ...acme, caseId: "acme-1", customer: "Acme Precision", open: false, state: "Quote sent (per monitor status)", progress: [{ key: "sent", done: true, at: "2026-09-20T15:00:00Z" }] };
  const open = { ...acme, caseId: "acme-2", customer: "Acme Precision", open: true, reference: "Acme RFQ 5200", lines: [{ partNumber: "XYZ-5200" }] };
  const events = [
    event("chase-open", "2026-09-22T15:00:00Z", "followup", { from: "buyer@acme.example", partNumbers: ["XYZ-5200"], subject: "RE: RFQ 5200" }),
    event("before-close", "2026-09-19T15:00:00Z", "followup", { from: "buyer@acme.example" }),
    event("after-close", "2026-09-23T15:00:00Z", "question", { from: "buyer@acme.example", note: "asks if expedite changes the minimum" }),
    event("no-number", "2026-09-23T16:00:00Z", "question", { from: "buyer@acme.example", partNumbers: [], subject: "Expedite?" }),
    event("reply", "2026-09-23T17:00:00Z", "ack", { from: "desk@shop.example", partNumbers: [], subject: "RE: Expedite?" }),
    event("stray-quote", "2026-09-23T18:00:00Z", "quote-sent", { from: "pat@shop.example", partNumbers: ["NOPE-9999"], subject: "Quote" }),
  ];
  const placed = Object.fromEntries(placeMailEvents(events, [closed, open], []).map((item) => [item.event.id, item]));
  assert.equal(placed["chase-open"].place, "case");
  assert.equal(placed["chase-open"].caseId, "acme-2");
  assert.equal(placed["before-close"].place, "answered", "written before the quote went out");
  assert.equal(placed["after-close"].place, "found", "a question after the quote is new work");
  assert.equal(placed["after-close"].closedCase.caseId, "acme-1");
  assert.equal(placed["no-number"].place, "found", "a message with no number is never hidden by the customer's other pages");
  assert.equal(placed.reply.place, "by-design");
  assert.equal(placed["stray-quote"].place, "unattached");
  const [row] = newRequests(events.filter((item) => ["no-number", "reply"].includes(item.id)), [], []);
  assert.equal(row.reply.from, "desk@shop.example", "the front desk's later reply to the same thread is shown with the row");
});

test("the Outlook item id in a link finds the monitor entry that holds the same email", () => {
  const id = "AAMkAGZz+Ab/Cd==";
  assert.equal(itemIdFromLink(OWA(id)), "AAMkAGZz_Ab-Cd==");
  const queue = [{ customer: "Orbit Aero", reference: "Bracket kit / September30", priority_section: 2, status: "Acknowledged; quote pending", evidence_ids: ["AAMkAGZz_Ab-Cd=="] }];
  const [found] = newRequests([event("1", "2026-09-30T11:00:00Z", "followup", { customerDomain: "orbit.example", partNumbers: [], link: OWA(id), subject: "Any update?" })], [], queue);
  assert.equal(found.monitor.reference, "Bracket kit / September30");
  assert.equal(found.monitor.matchedBy, "message");
});

test("a number matches a monitor reference only as a whole number, the customer's own entry first", () => {
  const queue = [
    { customer: "Other Shop", reference: "PO184036 /WO44803WA", priority_section: 3, status: "Visit set", events: [{ actor: "buyer@other.example" }] },
    { customer: "Pad Co", reference: "Turnover176 /4803 versus4803-3", priority_section: 2, status: "Pending", events: [{ actor: "qa@pad.example" }] },
  ];
  const [found] = newRequests([event("1", "2026-09-30T11:00:00Z", "followup", { customerDomain: "pad.example", partNumbers: ["4803"], subject: "4803" })], [], queue);
  assert.equal(found.monitor.reference, "Turnover176 /4803 versus4803-3");
  const [stray] = newRequests([event("2", "2026-09-30T11:00:00Z", "followup", { customerDomain: "x.example", partNumbers: ["4803"], subject: "4803" })], [], [queue[0]]);
  assert.equal(stray.monitor, null, "4803 inside WO44803WA is part of another number");
});

test("one thread keeps one row whatever reply and external tags its subjects carry", () => {
  assert.equal(subjectKey("RE: [EXTERNAL] Re: RFQ-ZZ-1 (Due 09/30)"), subjectKey("RFQ-ZZ-1 (Due 09/30)"));
  assert.equal(subjectKey("FW: RE: Fwd: Quote"), "QUOTE");
  const rows = newRequests([
    event("1", "2026-09-30T10:00:00Z", "rfq", { customerDomain: "orbit.example", partNumbers: [], subject: "RFQ-ZZ-1 (Due 09/30)" }),
    event("2", "2026-09-30T11:00:00Z", "followup", { customerDomain: "orbit.example", partNumbers: [], subject: "RE: [EXTERNAL] Re: RFQ-ZZ-1 (Due 09/30)" }),
  ], [], []);
  assert.deepEqual(rows.map((row) => row.id), ["2"]);
});

test("the save checks catch the shapes that silently break matching", () => {
  const good = { id: "<a@b>", at: "2026-09-30T09:48:02-07:00", kind: "followup", customerDomain: "Orbit.Example", from: "Buyer@orbit.example", to: [], subject: "RE: RFQ 1", partNumbers: [], rfqNumbers: ["RFQ-1"], link: OWA("AAMk+1") };
  const ok = normalizeEvent(good);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.event.at, "2026-09-30T16:48:02.000Z", "times are stored in UTC");
  assert.equal(ok.event.customerDomain, "orbit.example");
  assert.equal(ok.event.itemId, "AAMk_1");
  const problems = (change) => normalizeEvent({ ...good, ...change }).problems.join("\n");
  assert.match(problems({ rfqNumbers: "RFQ-1" }), /rfqNumbers must be a list/);
  assert.match(problems({ customerDomain: "shop.example" }), /never shop.example/);
  assert.match(problems({ kind: "reply" }), /kind must be one of/);
  assert.match(problems({ link: "https://example.com/x" }), /Outlook web link/);
  assert.match(problems({ mailbox: "private@shop.example" }), /never read/);
  assert.match(problems({ kind: "quote-sent", from: "buyer@orbit.example" }), /from must be an @shop.example address/);
  assert.match(problems({ kind: "quote-sent", from: "pat@shop.example", to: ["desk@shop.example"] }), /customer's address in to/);
  assert.deepEqual(normalizeEvent({ ...good, kind: "quote-sent", from: "pat@shop.example", to: ["buyer@orbit.example"] }).problems, []);
  assert.equal(normalizeEvent({ ...good, from: "someone@forwarder.example" }).warnings.length, 1, "a customer message from another domain is a warning, not a stop");
});

test("the board lists owed quotes, merges a chase logged twice, and says when Claude's check is off", () => {
  const dir = tempDir("qpc-claude-mail-");
  const monitorStatePath = path.join(dir, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-09-30T16:00:00Z", stale: false }, operational_queue: [
    { customer: "Nimbus Works", reference: "RFQ 3100 / seals", priority_section: 2, status: "New RFQ acknowledged; quote pending", last_observed_activity_at: "2026-09-25T10:00:00Z", explicit_due_date: "2026-09-29" },
    { customer: "Nimbus Works", reference: "Pickup dates", priority_section: 2, status: "Customer asks for pickup time", last_observed_activity_at: "2026-09-25T10:00:00Z" },
    { customer: "Vega Labs", reference: "RFQ 3200", priority_section: 2, status: "Quote sent; waiting on customer" },
  ] }));
  const claudeMailPath = path.join(dir, "events.json");
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-09-30T20:00:00Z", events: {} }));
  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${JSON.stringify({ runStart: "2026-09-30T16:30:00Z", finishedAt: "2026-09-30T16:40:00Z", searched: [{ source: "own", ok: true }, { source: "own-sent", ok: true }, { source: "desk@shop.example", ok: false }, { source: "sales@shop.example", ok: true }], keptByKind: { rfq: 1, followup: 2 } })}\n`);
  const board = buildBoard({ outputsDir: dir, monitorStatePath, claudeMailPath, now: new Date("2026-09-30T17:00:00Z") });
  assert.deepEqual(board.monitor.owed.map((item) => item.reference), ["RFQ 3100 / seals"], "a pickup question and a sent quote are not owed prices");
  assert.equal(board.claudeMail.stale, true, "a cutoff in the future is never fresh");
  assert.deepEqual(board.claudeMail.failed, ["desk@shop.example"]);
  const html = renderBoard(board);
  assert.match(html, /Acknowledged, quote still owed/);
  assert.match(html, /1 past due/, "an owed quote past its due date reaches the header");
  assert.match(html, /could not search desk@shop.example/);
  assert.match(html, /Claude&#39;s mail check last reached/);
  const setAside = renderBoard({ ...board, triage: { "monitor|Nimbus Works|RFQ 3100 / seals": { at: "2026-09-30T16:50:00Z", reason: "status question on a job in house, not an RFQ" } } });
  assert.doesNotMatch(setAside, /Acknowledged, quote still owed/, "an owed quote set aside leaves the list");
  assert.doesNotMatch(setAside, /1 past due/, "and stops counting as past due");
  assert.match(setAside, /status question on a job in house/, "it stays listed with the reason");
});

test("the trial scorecard counts runs per shop weekday, gaps, held cutoffs and what only Claude's check found", async () => {
  const { mailScorecard } = await import("../../bot/lib/claude-mail.js");
  const runs = [
    { runStart: "2026-10-01T14:35:00Z", held: false, skipped: [{ reason: "newsletter" }] },
    { runStart: "2026-10-01T15:35:00Z", held: true },
    { runStart: "2026-10-01T19:35:00Z", held: false },
  ];
  const events = [
    event("1", "2026-10-01T15:00:00Z", "rfq", { customerDomain: "orbit.example", partNumbers: ["QX-4410"], subject: "RFQ QX-4410" }),
    event("2", "2026-10-01T15:10:00Z", "rfq", { customerDomain: "harbor.example", partNumbers: ["HB-5512"], subject: "RFQ HB-5512" }),
  ];
  const card = mailScorecard({ runs, events, queue: [{ customer: "Harbor", reference: "HB-5512 / new" }], since: "2026-10-01T07:00:00Z", until: "2026-10-04T07:00:00Z" });
  assert.deepEqual(card.perDay.map((day) => `${day.day}:${day.runs}`), ["2026-10-01:3", "2026-10-02:0"], "Saturday is not a working day");
  assert.equal(card.gaps.length, 1);
  assert.equal(card.failedRuns, 1);
  assert.deepEqual(card.claudeOnly.map((item) => item.id), ["1"]);
  assert.deepEqual(card.skippedBy, { newsletter: 1 });
});

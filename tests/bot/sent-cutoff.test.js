import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, caseGroup, renderBoard, renderSentPage, sentOnBoard, SENT_FILE, writeBoard } from "../../bot/lib/board.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { recordDecision } from "../../bot/lib/lifecycle.js";
import { buildWorld, tempDir } from "./helpers.js";

// One priced case, a monitor queue and Claude's mail check, as in sync.test.js.
function world(monitorQueue, quotes = []) {
  const built = buildWorld();
  const decision = buildDecision(built.options);
  const outputsDir = tempDir("qpc-sent-");
  fs.writeFileSync(path.join(outputsDir, `CLAUDE-DECISION-${decision.caseId}-v1.json`), JSON.stringify({ ...decision, lifecycle: { ...decision.lifecycle, recommendationVersion: 1 } }));
  const monitorStatePath = path.join(built.root, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-10-28T03:00:00Z", stale: false }, operational_queue: monitorQueue }));
  const claudeMailPath = path.join(built.root, "claude-mail.json");
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-10-28T00:00:00Z", events: Object.fromEntries(quotes.map((item) => [item.id, item])) }));
  const inputs = { outputsDir, monitorStatePath, storeDir: built.options.storeDir, claudeMailPath };
  return { decision, inputs, board: (now, extra = {}) => buildBoard({ ...inputs, ...extra, now: new Date(now) }) };
}
const quote = (id, at) => ({ id, at, kind: "quote-sent", customerDomain: "acme.example", from: "pat@shop.example", to: ["buyer@acme.example"], subject: "RE: RFQ", partNumbers: ["ABC-100"], rfqNumbers: [], link: `https://mail.example/${id}` });
const decideAll = (decision, outputsDir, decidedAt = "2026-10-20T16:00:00Z") => {
  for (const line of decision.lines) recordDecision({ outputsDir, caseId: decision.caseId, version: 1, lineId: line.lineId, choice: "alternative", unitPrice: 10, note: "test price", decidedBy: "Pat Reviewer", decidedAt, now: new Date(decidedAt) });
};
const cardIn = (html, id, caseId) => {
  const start = html.indexOf(`<section id="${id}"`);
  if (start < 0) return false;
  const end = html.indexOf("</section>", start);
  return html.slice(start, end).includes(`id="case-${caseId}"`);
};

test("a sent quote stays on the board for two business days after it went out, then only on the Sent quotes page", () => {
  const { decision, inputs, board } = world([], [quote("q1", "2026-10-26T17:00:00Z")]);
  decideAll(decision, inputs.outputsDir);
  // Sent Monday: on the board Monday, Tuesday and Wednesday; gone Thursday.
  for (const [now, shown] of [["2026-10-26T20:00:00Z", true], ["2026-10-28T20:00:00Z", true], ["2026-10-29T17:00:00Z", false], ["2026-11-02T17:00:00Z", false]]) {
    const built = board(now);
    const [kase] = built.cases;
    assert.equal(caseGroup(kase), "sent");
    assert.equal(sentOnBoard(kase, new Date(now)), shown, now);
    const html = renderBoard(built);
    assert.equal(cardIn(html, "sent", decision.caseId), shown, `board card ${now}`);
    assert.match(html, new RegExp(`<a href="${SENT_FILE}">Sent quotes page</a>, which keeps all 1\\.`), "the board always links to the full list");
    assert.ok(cardIn(renderSentPage(built), "sent", decision.caseId), `the Sent quotes page keeps it ${now}`);
  }
  // The cut-off comes from the config when set.
  const longer = board("2026-10-29T17:00:00Z", { sentOnBoardDays: 5 });
  assert.ok(cardIn(renderBoard(longer), "sent", decision.caseId));
  assert.match(renderBoard(longer), /Quotes seen sent in the last 5 business days\./);
});

test("a sent quote with no sent date stays on the board", () => {
  assert.equal(sentOnBoard({ progress: [{ key: "sent", done: true, at: null }] }, new Date("2026-12-01T17:00:00Z")), true);
  assert.equal(sentOnBoard({ progress: [] }, new Date("2026-12-01T17:00:00Z")), true);
});

test("a decided quote no mail check has seen go out gets its own visible section, chip and header count", () => {
  const { decision, inputs, board } = world([]);
  decideAll(decision, inputs.outputsDir);
  const built = board("2026-10-28T20:00:00Z");
  assert.equal(caseGroup(built.cases[0]), "decided");
  const html = renderBoard(built);
  assert.ok(cardIn(html, "unsent", decision.caseId), "in Decided, not seen sent");
  const section = html.slice(html.indexOf('<section id="unsent"'), html.indexOf("</section>", html.indexOf('<section id="unsent"')));
  assert.doesNotMatch(section, /<details/, "not folded away");
  assert.match(section, /Decided Oct 20, 2026 · not seen sent/);
  assert.match(html, /<a class="orders-now" href="#unsent">1 decided, not seen sent<\/a>/);
  assert.match(html, /<a href="#unsent">Not seen sent <small>1<\/small><\/a>/);
  assert.doesNotMatch(html, /Decided &amp; sent/);
  assert.doesNotMatch(renderSentPage(built), new RegExp(`id="case-${decision.caseId}"`), "not on the Sent quotes page");
});

test("a price question after an old quote puts the card back on the board and off the Sent quotes page", () => {
  const { decision, inputs, board } = world([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 3, status: "Customer acknowledged quote; quantity discrepancy remains", evidence_ids: ["rfq"], last_observed_activity_at: "2026-10-27T15:00:00Z" }], [quote("q1", "2026-10-01T15:00:00Z")]);
  decideAll(decision, inputs.outputsDir, "2026-09-30T16:00:00Z");
  const built = board("2026-10-28T20:00:00Z");
  const [kase] = built.cases;
  assert.equal(kase.open, true);
  const html = renderBoard(built);
  assert.ok(cardIn(html, "ready", decision.caseId) || cardIn(html, "facts", decision.caseId), "back with the open cards");
  assert.doesNotMatch(renderSentPage(built), new RegExp(`id="case-${decision.caseId}"`));
});

test("the board writes the Sent quotes page next to itself", () => {
  const { decision, inputs } = world([], [quote("q1", "2026-10-01T15:00:00Z")]);
  decideAll(decision, inputs.outputsDir, "2026-09-30T16:00:00Z");
  writeBoard({ ...inputs, now: new Date("2026-10-28T20:00:00Z") });
  const page = fs.readFileSync(path.join(inputs.outputsDir, SENT_FILE), "utf8");
  assert.match(page, /<title>Sent Quotes<\/title>/);
  assert.match(page, /<h1 class="summary">1 sent quote<\/h1>/);
  assert.match(page, /href="CLAUDE-DECISIONS-OPEN\.html"/, "links back to the board");
  assert.ok(cardIn(page, "sent", decision.caseId));
  const html = fs.readFileSync(path.join(inputs.outputsDir, "CLAUDE-DECISIONS-OPEN.html"), "utf8");
  assert.ok(!cardIn(html, "sent", decision.caseId), "a month-old quote is off the board");
  assert.match(html, /Older ones are on the <a href="CLAUDE-DECISIONS-SENT\.html">Sent quotes page<\/a>/);
});

test("sent quotes list newest first, decided-not-sent oldest decision first", () => {
  const card = (caseId, sent, decided) => ({ caseId, open: false, tone: "ok", state: sent ? "Quote sent (per mail check)" : "Decided — not sent", lastSentAt: sent, progress: [{ key: "decided", at: decided }, { key: "sent", at: sent }] });
  const { inputs } = world([]);
  const built = buildBoard({ ...inputs, now: new Date("2026-10-28T20:00:00Z") });
  const order = (cases, render) => [...render({ ...built, cases }).matchAll(/id="case-([^"]+)"/g)].map((match) => match[1]);
  const fake = [card("OLD", "2026-10-01T15:00:00Z"), card("NEW", "2026-10-20T15:00:00Z"), card("MID", "2026-10-10T15:00:00Z")].map((kase) => ({ ...built.cases[0], ...kase }));
  assert.deepEqual(order(fake, renderSentPage), ["NEW", "MID", "OLD"]);
  const unsent = [card("B", null, "2026-10-10T15:00:00Z"), card("A", null, "2026-10-01T15:00:00Z")].map((kase) => ({ ...built.cases[0], ...kase }));
  assert.deepEqual(order(unsent, renderBoard), ["A", "B"]);
});

test("a corrected quote counts from the day it went out, from Claude's mail check and from the monitor", () => {
  const mailed = world([], [quote("q1", "2026-10-01T15:00:00Z"), quote("q2", "2026-10-27T15:00:00Z")]);
  decideAll(mailed.decision, mailed.inputs.outputsDir, "2026-09-30T16:00:00Z");
  const [kase] = mailed.board("2026-10-29T17:00:00Z").cases;
  assert.equal(kase.progress.find((step) => step.key === "sent").at, "2026-10-01T15:00:00Z", "the progress step keeps the first quote");
  assert.equal(kase.lastSentAt, "2026-10-27T15:00:00Z");
  assert.equal(sentOnBoard(kase, new Date("2026-10-29T17:00:00Z")), true, "sent Tuesday, still up Thursday");
  assert.equal(sentOnBoard(kase, new Date("2026-10-30T17:00:00Z")), false);
  const monitored = world([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 3, status: "Quote sent; waiting on customer", evidence_ids: ["rfq"], events: [{ at: "2026-10-01T15:00:00Z", meaning: "Quote sent" }, { at: "2026-10-27T15:00:00Z", meaning: "Quote sent. Corrected quantity" }, { at: "2026-10-28T15:00:00Z", meaning: "Quote sent", is_draft: true }] }]);
  const [viaMonitor] = monitored.board("2026-10-29T17:00:00Z").cases;
  assert.equal(viaMonitor.state, "Quote sent (per monitor status)");
  assert.equal(viaMonitor.lastSentAt, "2026-10-27T15:00:00Z", "a draft is not a sent quote");
  assert.ok(cardIn(renderBoard(monitored.board("2026-10-29T17:00:00Z")), "sent", monitored.decision.caseId));
});

test("a front-desk chase after an old quote keeps the card on the board, first and unfolded", () => {
  const { decision, inputs, board } = world([], [quote("q1", "2026-10-01T15:00:00Z")]);
  decideAll(decision, inputs.outputsDir, "2026-09-30T16:00:00Z");
  const chat = path.join(inputs.outputsDir, "..", "chat.json");
  fs.writeFileSync(chat, JSON.stringify({ readAt: "2026-10-28T00:00:00Z", messages: { m1: { id: "m1", at: "2026-10-26T16:00:00Z", from: "Front Desk", replyTo: null, text: "Pat from Acme Precision Corp is F/U on this request: 77 / ABC-100 Rev B revised pricing" } } }));
  const built = board("2026-10-28T20:00:00Z", { quotePrepChatPath: chat });
  const [kase] = built.cases;
  assert.equal(caseGroup(kase), "sent");
  assert.ok(kase.followup, "the chat attaches the chase to the sent card");
  assert.equal(sentOnBoard(kase, new Date("2026-10-28T20:00:00Z")), true);
  const html = renderBoard(built);
  assert.ok(cardIn(html, "sent", decision.caseId));
  assert.match(html, /<section id="sent"[\s\S]*?<details class="fold" open>/, "the list opens by itself");
  assert.equal(sentOnBoard(board("2026-10-28T20:00:00Z").cases[0], new Date("2026-10-28T20:00:00Z")), false, "without the chase it is off the board");
});

test("a front-desk chase keeps the card up even after a later quote or receipt note", () => {
  const { decision, inputs, board } = world([], [quote("q1", "2026-10-01T15:00:00Z"), quote("q2", "2026-10-27T15:00:00Z")]);
  decideAll(decision, inputs.outputsDir, "2026-09-30T16:00:00Z");
  const chat = path.join(inputs.outputsDir, "..", "chat.json");
  fs.writeFileSync(chat, JSON.stringify({ readAt: "2026-11-03T00:00:00Z", messages: { m1: { id: "m1", at: "2026-10-26T16:00:00Z", from: "Front Desk", replyTo: null, text: "Pat from Acme Precision Corp is F/U on this request: 77 / ABC-100 Rev B revised pricing" } } }));
  const [kase] = board("2026-11-03T20:00:00Z", { quotePrepChatPath: chat }).cases;
  assert.equal(kase.lastSentAt, "2026-10-27T15:00:00Z");
  assert.ok(kase.followup);
  assert.equal(sentOnBoard(kase, new Date("2026-11-03T20:00:00Z")), true, "five business days after the newest quote, still up: a later quote is not taken to answer the chase");
});

test("a sent quote dated only by the monitor's last activity counts as undated and stays", () => {
  const { decision, board } = world([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 3, status: "Quote sent; waiting on customer", evidence_ids: ["rfq"], last_observed_activity_at: "2026-09-20T15:00:00Z" }]);
  const built = board("2026-10-28T20:00:00Z");
  const [kase] = built.cases;
  assert.equal(kase.progress.find((step) => step.key === "sent").at, "2026-09-20T15:00:00Z", "the progress step shows the activity date as before");
  assert.equal(kase.lastSentAt, null);
  assert.ok(cardIn(renderBoard(built), "sent", decision.caseId));
});

test("the monitor's sent events count even after its status moved on", () => {
  const { decision, inputs, board } = world([{ customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 3, status: "Customer PO received and acknowledged", evidence_ids: ["rfq"], events: [{ at: "2026-10-27T15:00:00Z", meaning: "Quote sent. Corrected quantity" }] }], [quote("q1", "2026-10-01T15:00:00Z")]);
  decideAll(decision, inputs.outputsDir, "2026-09-30T16:00:00Z");
  const [kase] = board("2026-10-28T20:00:00Z").cases;
  assert.equal(kase.state, "Quote sent (per mail check)");
  assert.equal(kase.lastSentAt, "2026-10-27T15:00:00Z");
  assert.equal(sentOnBoard(kase, new Date("2026-10-28T20:00:00Z")), true);
});

test("the Sent quotes page is strictly newest sent; on the board a chased card goes first", () => {
  const { inputs } = world([]);
  const built = buildBoard({ ...inputs, now: new Date("2026-10-28T20:00:00Z") });
  const card = (caseId, sent, followup = null) => ({ ...built.cases[0], caseId, open: false, tone: "ok", state: "Quote sent (per mail check)", lastSentAt: sent, followup, progress: [{ key: "sent", at: sent }] });
  const chase = { lastAt: "2026-10-27T16:00:00Z", contact: "Pat", company: "Acme", subject: "RFQ", label: "1st follow-up", urgent: false };
  const cases = [card("OLD-CHASED", "2026-10-01T15:00:00Z", chase), card("NEW", "2026-10-28T15:00:00Z"), card("MID", "2026-10-27T15:00:00Z")];
  const order = (html) => [...html.matchAll(/id="case-([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order(renderSentPage({ ...built, cases })), ["NEW", "MID", "OLD-CHASED"]);
  assert.deepEqual(order(renderBoard({ ...built, cases })), ["OLD-CHASED", "NEW", "MID"]);
});

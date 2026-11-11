import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, caseGroup, renderBoard, renderSentPage, writeBoard } from "../../bot/lib/board.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { recordDecision } from "../../bot/lib/lifecycle.js";
import { readSentQuoteNote, sentQuoteNote } from "../../bot/lib/sent-quote.js";
import { buildWorld, tempDir } from "./helpers.js";

// One priced case (ABC-100 x 500, ABC-100 x 5000, DEF-200 x 10, asked
// 2026-09-24), a monitor queue and Claude's mail check, as in sent-cutoff.test.js.
function world(monitorQueue = [], mail = [], change = (decision) => decision) {
  const built = buildWorld();
  const priced = change(buildDecision(built.options));
  const decision = { ...priced, lifecycle: { ...priced.lifecycle, recommendationVersion: 1 } };
  const outputsDir = tempDir("qpc-fixes-");
  fs.writeFileSync(path.join(outputsDir, `CLAUDE-DECISION-${decision.caseId}-v1.json`), JSON.stringify(decision));
  const monitorStatePath = path.join(built.root, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-10-28T03:00:00Z", stale: false }, operational_queue: monitorQueue }));
  const claudeMailPath = path.join(built.root, "claude-mail.json");
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-10-28T00:00:00Z", events: Object.fromEntries(mail.map((item) => [item.id, item])) }));
  const inputs = { outputsDir, monitorStatePath, storeDir: built.options.storeDir, claudeMailPath };
  return { decision, inputs, board: (now, extra = {}) => buildBoard({ ...inputs, ...extra, now: new Date(now) }) };
}
const mailEvent = (id, at, extra = {}) => ({ id, at, kind: "rfq", customerDomain: "acme.example", from: "buyer@acme.example", to: ["sales@shop.example"], subject: "RFQ", partNumbers: ["ABC-100"], rfqNumbers: [], link: `https://mail.example/${id}`, ...extra });
const lineIds = (decision) => decision.lines.map((line) => line.lineId);
const NOW = "2026-10-28T20:00:00Z";

// A price decided by hand (approve / answer), with whatever note was typed.
const decide = (decision, outputsDir, ids, note, decidedAt = "2026-10-20T16:00:00Z", unitPrice = 10) => {
  for (const lineId of ids) recordDecision({ outputsDir, caseId: decision.caseId, version: 1, lineId, choice: "alternative", unitPrice, note, decidedBy: "Pat Reviewer", decidedAt, now: new Date(decidedAt) });
};
// What from-sent leaves on a line: the price, dated the moment the quote went
// out, with a note naming the email and the template row that priced the line.
const quoteEmail = (sentAt, subject = "RE: Quote for ABC-100") => ({ id: "sent-1", sentAt, to: ["buyer@acme.example"], subject });
const row = (line, { quantity = line.request.quantity, price = "$10.00", extra = "" } = {}) => `P/N: ${line.request.partNumber} / Qty: ${quantity} / Unit Price: ${price}${extra}`;
const readFromQuote = (decision, outputsDir, email, words = row, lines = decision.lines) => {
  for (const line of lines) decide(decision, outputsDir, [line.lineId], sentQuoteNote(email, words(line)), email.sentAt);
};
const sectionOf = (html, id) => { const start = html.indexOf(`<section id="${id}"`); return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start)); };
const CHIP = /Price from the quote sent Oct 26, 2026 · confirm it went out/;
// The chip's date on a decided card, or null. It is only ever a wording.
const chip = (kase) => { assert.equal(caseGroup(kase), "decided"); assert.equal(kase.lastSentAt, null); return kase.quoteEmailAt; };

test("a from-sent note is read back only in the exact shape from-sent writes", () => {
  const note = sentQuoteNote(quoteEmail("2026-10-20T09:15:00-07:00", "RE: RFQ 4100"), "P/N: ABC-100 / Qty: 500 / Unit Price: $10.00");
  assert.deepEqual(readSentQuoteNote(note), { at: "2026-10-20T16:15:00.000Z", subject: "RE: RFQ 4100", words: "P/N: ABC-100 / Qty: 500 / Unit Price: $10.00" });
  assert.equal(readSentQuoteNote(sentQuoteNote(quoteEmail(null), "P/N: ABC-100 / Qty: 500 / Unit Price: $10.00")), null, "no sent time");
  assert.equal(readSentQuoteNote(sentQuoteNote({ ...quoteEmail("2026-10-20T16:15:00Z"), id: undefined }, "P/N: ABC-100 / Qty: 500 / Unit Price: $10.00")), null, "no message id");
  // A note someone typed gives nothing, however it starts.
  for (const typed of ["test price", "i sent $8", "Reviewer said: Sent quote 2026-10-20T16:15:00Z to the buyer", "Sent quote 2026-10-20 to internal review only; customer quote still owed", "Sent quote 2026-10-20T16:15:00Z to buyer@acme.example: $10", "", null]) assert.equal(readSentQuoteNote(typed), null, String(typed));
});

test("a card whose every price was read from the sent quote says so, and nothing else about it changes", () => {
  const plain = world();
  decide(plain.decision, plain.inputs.outputsDir, lineIds(plain.decision), "approved in review", "2026-10-26T17:00:00Z");
  const read = world();
  readFromQuote(read.decision, read.inputs.outputsDir, quoteEmail("2026-10-26T17:00:00Z"));
  // The day after, and five weeks on.
  for (const now of ["2026-10-27T20:00:00Z", "2026-12-01T20:00:00Z"]) {
    const [was] = plain.board(now).cases;
    const built = read.board(now);
    const [kase] = built.cases;
    assert.equal(chip(kase), "2026-10-26T17:00:00.000Z", now);
    // The same card as one decided by hand, in every way the board acts on.
    for (const field of ["state", "open", "tone", "reopened", "lastSentAt", "dueDate", "waitingBusinessDays"]) assert.deepEqual(kase[field], was[field], field);
    assert.deepEqual(kase.progress.map((step) => [step.key, step.done]), was.progress.map((step) => [step.key, step.done]));
    assert.ok(!built.history.some((item) => item.kind === "sent"));
    const html = renderBoard(built);
    const section = sectionOf(html, "unsent");
    assert.ok(section.includes(`id="case-${read.decision.caseId}"`), "in the section, as before");
    assert.doesNotMatch(section, /<details/, "not folded away");
    assert.match(section, CHIP);
    assert.doesNotMatch(section, /· not seen sent<\/span>/);
    assert.match(section, /A card that says its price came from a sent quote has likely gone out already: check, and mark it Done\./);
    assert.match(html, /<a class="orders-now" href="#unsent">1 decided, not seen sent<\/a>/, "still counted in the header");
    assert.match(html, /<a href="#unsent">Not seen sent <small>1<\/small><\/a>/, "and on the tab");
    assert.doesNotMatch(renderSentPage(built), new RegExp(`id="case-${read.decision.caseId}"`), "not on the Sent quotes page");
    // Apart from the chip's words, the card's place on the page is the same as the hand-decided one's.
    assert.match(sectionOf(renderBoard(plain.board(now)), "unsent"), /Decided Oct 26, 2026 · not seen sent/);
  }
});

test("the chip does not change the order of the section", () => {
  const first = world();
  readFromQuote(first.decision, first.inputs.outputsDir, quoteEmail("2026-10-19T17:00:00Z"));
  // A second case in the same folder, decided by hand a week later.
  const second = { ...first.decision, caseId: `${first.decision.caseId}-B` };
  fs.writeFileSync(path.join(first.inputs.outputsDir, `CLAUDE-DECISION-${second.caseId}-v1.json`), JSON.stringify(second));
  decide(second, first.inputs.outputsDir, lineIds(second), "approved in review", "2026-10-26T17:00:00Z");
  const html = renderBoard(first.board(NOW));
  const section = sectionOf(html, "unsent");
  assert.ok(section.indexOf(`id="case-${first.decision.caseId}"`) < section.indexOf(`id="case-${second.caseId}"`), "oldest decision first, chip or no chip");
  assert.match(html, /<a class="orders-now" href="#unsent">2 decided, not seen sent<\/a>/);
});

test("where the mail check saw the quote go out, the card is sent exactly as before", () => {
  const { decision, inputs, board } = world([], [mailEvent("q1", "2026-10-01T15:00:00Z", { kind: "quote-sent", from: "pat@shop.example", to: ["buyer@acme.example"] })]);
  readFromQuote(decision, inputs.outputsDir, quoteEmail("2026-10-26T17:00:00Z"));
  const built = board(NOW);
  const [kase] = built.cases;
  assert.equal(caseGroup(kase), "sent");
  assert.equal(kase.state, "Quote sent (per mail check)");
  assert.equal(kase.lastSentAt, "2026-10-01T15:00:00.000Z", "dated by the mail check alone");
  assert.doesNotMatch(renderSentPage(built), /confirm it went out/, "no chip on a sent card");
});

test("no chip unless every line's current price plainly came from the sent quote", () => {
  const email = quoteEmail("2026-10-26T17:00:00Z");
  const cases = {
    "a price typed in by hand": (d, dir) => decide(d, dir, lineIds(d), "i sent $10", email.sentAt),
    "one line decided by hand": (d, dir) => { readFromQuote(d, dir, email, row, d.lines.slice(1)); decide(d, dir, ["L1"], "approved in review", email.sentAt); },
    "a price changed by hand afterwards": (d, dir) => { readFromQuote(d, dir, email); decide(d, dir, ["L1"], "new price after a call", "2026-10-27T16:00:00Z", 12); },
    "the note copied onto another price": (d, dir) => { readFromQuote(d, dir, email); decide(d, dir, ["L1"], sentQuoteNote(email, row(d.lines[0])), email.sentAt, 12); },
    "the note copied onto another day": (d, dir) => { readFromQuote(d, dir, email); decide(d, dir, ["L1"], sentQuoteNote(email, row(d.lines[0])), "2026-10-27T16:00:00Z"); },
    "the part quoted at another quantity only": (d, dir) => readFromQuote(d, dir, email, (line) => row(line, { quantity: line.request.partNumber === "ABC-100" ? 500 : line.request.quantity })),
    "no quantity in the kept words": (d, dir) => readFromQuote(d, dir, email, (line) => `P/N: ${line.request.partNumber} / Unit Price: $10.00`),
    "a tier named only to exclude it": (d, dir) => readFromQuote(d, dir, email, (line) => row(line, { quantity: "500 only (5000 not quoted)" })),
    "a quantity hedged after a slash": (d, dir) => readFromQuote(d, dir, email, (line) => row(line, { quantity: `${line.request.quantity} / not quoted` })),
    "a stray piece among the fields": (d, dir) => readFromQuote(d, dir, email, (line) => `${row(line)} / Budgetary only, firm quote to follow.`),
    "a price with a qualifier": (d, dir) => readFromQuote(d, dir, email, (line) => row(line, { price: "$10.00 was last year's" })),
    "a second price in another field": (d, dir) => readFromQuote(d, dir, email, (line) => `P/N: ${line.request.partNumber} / Qty: ${line.request.quantity} / Unit Price: $12.00 / Unit Price: $10.00`),
    "another part's row": (d, dir) => readFromQuote(d, dir, email, (line) => `P/N: XYZ-999 / Qty: ${line.request.quantity} / Unit Price: $10.00`),
    "a longer part number": (d, dir) => readFromQuote(d, dir, email, (line) => `P/N: ${line.request.partNumber}0 / Qty: ${line.request.quantity} / Unit Price: $10.00`),
    "a correction on one line": (d, dir) => { readFromQuote(d, dir, email); recordDecision({ outputsDir: dir, caseId: d.caseId, version: 1, lineId: "L2", choice: "correction", note: "wrong quantity", decidedBy: "Pat Reviewer", decidedAt: "2026-10-27T16:00:00Z", now: new Date("2026-10-27T16:00:00Z") }); },
  };
  for (const [what, make] of Object.entries(cases)) {
    const { decision, inputs, board } = world();
    make(decision, inputs.outputsDir);
    assert.equal(board(NOW).cases[0].quoteEmailAt, null, what);
  }
  // Ordinary variations still count.
  for (const [what, words] of Object.entries({
    "a packing note": (line) => row(line, { quantity: `${line.request.quantity} (individually packed)` }),
    "a list of quantities": (line) => row(line, { quantity: line.request.partNumber === "ABC-100" ? "500 & 5,000" : "10, 20 and 30" }),
    "a process field": (line) => `${row(line)} / Process: Level 300 clean`,
    "each": (line) => row(line, { price: "$10.00 each" }),
  })) {
    const { decision, inputs, board } = world();
    readFromQuote(decision, inputs.outputsDir, email, words);
    assert.equal(chip(board(NOW).cases[0]), "2026-10-26T17:00:00.000Z", what);
  }
});

test("two quantities written with a comma are not read as one larger quantity", () => {
  const bigger = (decision) => ({ ...decision, lines: decision.lines.map((line) => (line.lineId === "L1" ? { ...line, request: { ...line.request, quantity: 1020 } } : line)) });
  const email = quoteEmail("2026-10-26T17:00:00Z");
  const listed = world([], [], bigger);
  readFromQuote(listed.decision, listed.inputs.outputsDir, email, (line) => row(line, { quantity: line.lineId === "L1" ? "10,20" : line.request.quantity }));
  assert.equal(listed.board(NOW).cases[0].quoteEmailAt, null, "10 and 20, not 1020");
  const longer = world([], [], (decision) => ({ ...decision, lines: decision.lines.map((line) => (line.lineId === "L1" ? { ...line, request: { ...line.request, quantity: 10200 } } : line)) }));
  readFromQuote(longer.decision, longer.inputs.outputsDir, email, (line) => row(line, { quantity: line.lineId === "L1" ? "10,2000" : line.request.quantity }));
  assert.equal(longer.board(NOW).cases[0].quoteEmailAt, null, "10 and 2000, not 10200");
  const grouped = world([], [], bigger);
  readFromQuote(grouped.decision, grouped.inputs.outputsDir, email, (line) => row(line, { quantity: line.lineId === "L1" ? "1,020" : line.request.quantity }));
  assert.equal(chip(grouped.board(NOW).cases[0]), "2026-10-26T17:00:00.000Z", "a thousands comma is fine");
});

test("no chip from a quote sent before the request came in", () => {
  const { decision, inputs, board } = world();
  readFromQuote(decision, inputs.outputsDir, quoteEmail(new Date(Date.parse(decision.rfq.initiatedAt) - 30 * 86400000).toISOString()));
  assert.equal(chip(board("2026-10-28T20:00:00Z").cases[0]), null);
});

test("no chip when the quote's subject names an RFQ number that is not plainly this request's", () => {
  const numbered = (reference) => (decision) => ({ ...decision, rfq: { ...decision.rfq, reference } });
  const at = "2026-10-26T17:00:00Z";
  const gives = (reference, subject) => { const { decision, inputs, board } = world([], [], reference ? numbered(reference) : undefined); readFromQuote(decision, inputs.outputsDir, quoteEmail(at, subject)); return board(NOW).cases[0].quoteEmailAt; };
  assert.equal(gives("RFQ-4100", "RE: RFQ-4200 ABC-100"), null, "another request");
  assert.equal(gives("RFQ-4100", "RFQ 4100 pending; quote for RFQ 4200"), null, "this request beside another");
  assert.equal(gives("RFQ-4100", "RE: RFQ 4100 & 4200"), null, "a list after one RFQ");
  assert.equal(gives("RFQ-4100", "RE: RFQ / 4200"), null, "a slash after RFQ");
  assert.equal(gives("RFQ-4100", "RE: RFQ (#4200)"), null, "a number after RFQ that cannot be made out");
  assert.equal(gives("RFQ 5120-5125", "RE: RFQ 5126"), null, "just outside a range");
  assert.equal(gives("RFQ-4100", "RFQ 4100 pending; quote for RFQ (#4200)"), null, "this request beside a number that cannot be made out");
  assert.equal(gives("RFQ-4100", "RFQ4100 pending; quote for RFQ (#4200)"), null, "the same, written without a space");
  assert.equal(gives("RFQ 2026-US-4100", "RE: RFQ 2026"), null, "part of a longer identifier is another number");
  assert.equal(gives("RFQ-4100", "RE: RFQ No. 4200"), null, "a number written with No.");
  assert.equal(gives("RFQ-4100", "RFQ 4100; quote for RFQ No. 4200"), null, "this request beside another written with No.");
  assert.equal(gives("RFQ-4100", "RE: RFQ ref. 4200"), null, "a number after a word this cannot read");
  assert.ok(gives("RFQ No. 4100", "RE: RFQ 4100"), "the request's own number written with No.");
  assert.ok(gives("XYZ RFQ 6100/1", "Re: RFQ XYZ 6100/1"), "a short word between RFQ and the number");
  assert.equal(gives("XYZ RFQ 6100/1", "Re: RFQ XYZ 6101/1"), null, "and another number written that way");
  assert.ok(gives("RFQ 2026-US-4100", "RE: RFQ 2026-US-4100 quote"), "the whole identifier");
  assert.equal(gives("RFQ 4100 / ABC-100", "RE: RFQ 100"), null, "a part number after the request's RFQ number is not another RFQ number");
  assert.equal(gives(null, "RE: RFQ 4100"), null, "the request names no RFQ number to compare with");
  assert.ok(gives("RFQ-4100", "RE: RFQ 4100 - ABC-100"), "this request's own number, however written");
  assert.ok(gives("RFQ 5120-5125", "RE: RFQ 5120 DUE BY 10/30"), "one end of a range the request spells out");
  assert.ok(gives("RFQ 5120-5125", "RE: RFQ 5122"), "inside the range");
  assert.ok(gives("RFQ 4100 & 4200", "RE: RFQ / 4200"), "one of a list the request spells out");
  assert.ok(gives("RFQ-4100", "RE: Quote for ABC-100"), "a subject that names no RFQ number");
});

test("a closed case's quote does not hide a message that names another RFQ number", () => {
  const numbered = (decision) => ({ ...decision, rfq: { ...decision.rfq, reference: "RFQ-4100" } });
  const asks = [
    mailEvent("other", "2026-10-19T12:00:00Z", { rfqNumbers: ["RFQ-4200"], subject: "RFQ-4200 ABC-100" }),
    mailEvent("same", "2026-10-19T13:00:00Z", { kind: "followup", rfqNumbers: ["RFQ-4100"], subject: "RFQ-4100 ABC-100" }),
    mailEvent("both", "2026-10-19T14:00:00Z", { rfqNumbers: ["RFQ-4100", "RFQ-4200"], subject: "RFQ-4100 and RFQ-4200" }),
  ];
  const places = (built) => Object.fromEntries(built.mailPlacements.map((item) => [item.event.id, item.place]));
  // The mail check saw RFQ-4100's quote go out on the 20th.
  const seen = world([], [...asks, mailEvent("q1", "2026-10-20T16:00:00Z", { kind: "quote-sent", from: "pat@shop.example", to: ["buyer@acme.example"], rfqNumbers: ["RFQ-4100"], subject: "RE: RFQ-4100 ABC-100" })], numbered);
  decide(seen.decision, seen.inputs.outputsDir, lineIds(seen.decision), "approved in review");
  const built = seen.board(NOW);
  assert.equal(caseGroup(built.cases[0]), "sent");
  assert.equal(places(built).same, "answered", "this request's own earlier chase is answered by its quote");
  assert.equal(places(built).other, "found", "the other request stays listed");
  assert.equal(places(built).both, "found", "a message about this request and another stays listed");
  // A card with the chip hides nothing at all: it is not sent.
  const read = world([], asks, numbered);
  readFromQuote(read.decision, read.inputs.outputsDir, quoteEmail("2026-10-20T16:00:00Z", "RE: RFQ-4100 ABC-100"));
  assert.ok(chip(read.board(NOW).cases[0]));
  assert.deepEqual(places(read.board(NOW)), { other: "found", same: "found", both: "found" });
});

test("a card keeps the due date the customer wrote in its emails", () => {
  const dated = world([], [mailEvent("ask", "2026-09-24T12:00:00Z", { dueDate: "2026-10-30" })]);
  const built = dated.board(NOW);
  assert.equal(built.cases[0].dueDate, "2026-10-30");
  assert.match(renderBoard(built), /Due Oct 30, 2026/);
  // The newest date wins; a chase can move it.
  const moved = world([], [mailEvent("ask", "2026-09-24T12:00:00Z", { dueDate: "2026-10-30" }), mailEvent("chase", "2026-10-27T12:00:00Z", { kind: "followup", dueDate: "2026-10-29" })]);
  assert.equal(moved.board(NOW).cases[0].dueDate, "2026-10-29");
  // Not from our own mail, an earlier request for the same part, or another customer.
  const none = world([], [
    mailEvent("ours", "2026-10-01T12:00:00Z", { kind: "quote-sent", from: "pat@shop.example", to: ["buyer@acme.example"], dueDate: "2026-10-30" }),
    mailEvent("earlier", "2026-08-01T12:00:00Z", { dueDate: "2026-08-15" }),
    mailEvent("other", "2026-09-24T12:00:00Z", { customerDomain: "other.example", from: "buyer@other.example", dueDate: "2026-10-30" }),
  ]);
  assert.equal(none.board("2026-09-30T20:00:00Z").cases[0].dueDate, null);
  // Only an open card: once it is decided or sent, none is added.
  const sent = world([], [mailEvent("ask", "2026-09-24T12:00:00Z", { dueDate: "2026-10-30" }), mailEvent("q1", "2026-10-01T15:00:00Z", { kind: "quote-sent", from: "pat@shop.example", to: ["buyer@acme.example"] })]);
  const [kase] = sent.board(NOW).cases;
  assert.equal(caseGroup(kase), "sent");
  assert.equal(kase.dueDate, null);
  const decided = world([], [mailEvent("ask", "2026-09-24T12:00:00Z", { dueDate: "2026-10-30" })]);
  decide(decided.decision, decided.inputs.outputsDir, lineIds(decided.decision), "approved in review");
  assert.equal(caseGroup(decided.board(NOW).cases[0]), "decided");
  assert.equal(decided.board(NOW).cases[0].dueDate, null);
});

test("a due date the card already has is never replaced, so a past-due flag cannot be lost", () => {
  const entry = { customer: "Acme Precision Corp", reference: "77 / ABC-100 Rev B", priority_section: 1, status: "RFQ open", evidence_ids: ["rfq"], explicit_due_date: "2026-10-16" };
  assert.equal(world([entry]).board(NOW).cases[0].dueDate, "2026-10-16");
  assert.equal(world([entry], [mailEvent("ask", "2026-09-24T12:00:00Z", { dueDate: "2026-11-05" })]).board(NOW).cases[0].dueDate, "2026-10-16");
});

test("an email about another RFQ number or a longer part number gives this card no due date", () => {
  const otherRfq = world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { rfqNumbers: ["8800"], dueDate: "2026-10-30" })]);
  assert.equal(otherRfq.board(NOW).cases[0].dueDate, null);
  const longerPart = world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { partNumbers: ["ABC-1000"], dueDate: "2026-10-30" })]);
  assert.equal(longerPart.board(NOW).cases[0].dueDate, null);
  // Nor can it replace the date this card's own email gave.
  const both = world([], [mailEvent("ask", "2026-09-24T12:00:00Z", { dueDate: "2026-10-20" }), mailEvent("later", "2026-10-27T12:00:00Z", { partNumbers: ["ABC-1000"], dueDate: "2026-11-30" })]);
  assert.equal(both.board(NOW).cases[0].dueDate, "2026-10-20");
});

test("a due date is found by the request's RFQ number however the email writes it", () => {
  const numbered = (decision) => ({ ...decision, rfq: { ...decision.rfq, reference: "RFQ-CA-4100" } });
  const mine = world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { partNumbers: [], rfqNumbers: ["RFQ-4100"], dueDate: "2026-10-30" })], numbered);
  assert.equal(mine.board(NOW).cases[0].dueDate, "2026-10-30");
  const another = world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { partNumbers: ["ABC-100"], rfqNumbers: ["RFQ-4200"], dueDate: "2026-10-30" })], numbered);
  assert.equal(another.board(NOW).cases[0].dueDate, null, "another RFQ for the same part");
  // A later message about this request and another may carry the other's date: this card's stays.
  const two = world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { rfqNumbers: ["RFQ-4100"], dueDate: "2026-11-12" }), mailEvent("later", "2026-10-27T12:00:00Z", { rfqNumbers: ["RFQ-4100", "RFQ-4200"], dueDate: "2026-11-30" })], numbered);
  assert.equal(two.board(NOW).cases[0].dueDate, "2026-11-12");
  // A reference that spells out a range or a list is matched number by number.
  for (const [reference, number, expected] of [["RFQ 5120-5125", "5120", "2026-10-30"], ["RFQ 5120-5125", "5123", "2026-10-30"], ["RFQ 5120-5125", "5126", null], ["RFQ 4100 & 4200", "4200", "2026-10-30"], ["RFQ 4100 & 4200", "4300", null],
    ["RFQ 77-79", "78", "2026-10-30"], ["RFQ 77-79", "7779", null], ["RFQ 998-1002", "1001", "2026-10-30"], ["RFQ 998-1002", "9981002", null], ["RFQ 4100 / ABC-100", "100", null], ["RFQ 4100 / ABC-100", "4100", "2026-10-30"], ["RFQ 2026-US-4100", "2026-US-4100", "2026-10-30"], ["RFQ 2026-US-4100", "2026", null], ["RFQ No. 4100", "4100", "2026-10-30"], ["RFQ No. 4100", "4200", null]]) {
    const spelled = (decision) => ({ ...decision, rfq: { ...decision.rfq, reference } });
    assert.equal(world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { partNumbers: [], rfqNumbers: [number], dueDate: "2026-10-30" })], spelled).board(NOW).cases[0].dueDate, expected, `${reference} / ${number}`);
  }
  // Short RFQ numbers match exactly too.
  for (const number of ["7", "77", "777"]) {
    const short = (decision) => ({ ...decision, rfq: { ...decision.rfq, reference: `RFQ ${number}` } });
    assert.equal(world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { rfqNumbers: [number], dueDate: "2026-10-30" })], short).board(NOW).cases[0].dueDate, "2026-10-30", `RFQ ${number}`);
    assert.equal(world([], [mailEvent("ask", "2026-09-25T12:00:00Z", { rfqNumbers: [`${number}1`], dueDate: "2026-10-30" })], short).board(NOW).cases[0].dueDate, null, `not RFQ ${number}1`);
  }
});

test("a sent quote with no price on any line says so instead of showing an endless range", () => {
  const unpriced = (decision) => ({ ...decision, lines: decision.lines.map((line) => ({ ...line, recommendation: { ...line.recommendation, preferred: null } })) });
  const { decision, board } = world([], [mailEvent("q1", "2026-10-01T15:00:00Z", { kind: "quote-sent", from: "pat@shop.example", to: ["buyer@acme.example"] })], unpriced);
  const built = board(NOW);
  assert.equal(caseGroup(built.cases[0]), "sent");
  const page = renderSentPage(built);
  assert.ok(sectionOf(page, "sent").includes(`id="case-${decision.caseId}"`));
  assert.match(page, /<span class="big">No price recorded<\/span><span class="sub">quote sent · 3 lines<\/span>/);
  assert.doesNotMatch(page, /∞|Infinity|NaN/);
});

test("the board names its own code's commit even when git is pointed at another repository", () => {
  const { inputs } = world();
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(tempDir("qpc-no-repo-"), "missing.git");
  try {
    assert.match(writeBoard({ ...inputs, now: new Date(NOW) }).board.codeVersion, /^[0-9a-f]{7,}/);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
});

test("a quote logged under one number of the request's range marks the card sent, and a price question since keeps it open", () => {
  const ranged = (decision) => ({ ...decision, rfq: { ...decision.rfq, reference: "RFQ 5120-5125" } });
  // The case has two parts (ABC-100 at two quantities, and DEF-200); the quote names both.
  const quote = mailEvent("q1", "2026-10-20T16:00:00Z", { kind: "quote-sent", from: "pat@shop.example", to: ["buyer@acme.example"], subject: "RE: RFQ 5120-5125", rfqNumbers: ["5120"], partNumbers: ["ABC-100", "DEF-200"] });
  const seen = world([], [quote], ranged);
  decide(seen.decision, seen.inputs.outputsDir, lineIds(seen.decision), "approved in review", "2026-10-19T16:00:00Z");
  const [kase] = seen.board(NOW).cases;
  assert.equal(caseGroup(kase), "sent");
  assert.equal(kase.state, "Quote sent (per mail check)");
  assert.equal(kase.lastSentAt, "2026-10-20T16:00:00.000Z");
  // A quote for another part under that reference, or for only one of this card's parts, leaves the card with the quotes still to send.
  for (const parts of [["XYZ-999"], ["ABC-100"]]) {
    const other = world([], [{ ...quote, partNumbers: parts }], ranged);
    decide(other.decision, other.inputs.outputsDir, lineIds(other.decision), "approved in review", "2026-10-19T16:00:00Z");
    assert.equal(caseGroup(other.board(NOW).cases[0]), "decided", parts.join());
  }
  // A price question the monitor recorded after the quote keeps the card open.
  const question = { customer: "Acme Precision Corp", reference: "RFQ 5120-5125 / ABC-100 Rev B", priority_section: 3, status: "Customer acknowledged quote; quantity discrepancy remains", evidence_ids: ["rfq"], last_observed_activity_at: "2026-10-27T15:00:00Z" };
  const asked = world([question], [quote], ranged);
  decide(asked.decision, asked.inputs.outputsDir, lineIds(asked.decision), "approved in review", "2026-10-19T16:00:00Z");
  const [reopened] = asked.board(NOW).cases;
  assert.ok(reopened.monitor, "the monitor entry is this request's");
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.open, true);
});

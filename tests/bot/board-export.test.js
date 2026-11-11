import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoard, caseGroup } from "../../bot/lib/board.js";
import { spawnSync } from "node:child_process";
import { END_OF_FILE, EXPORT_COLUMNS, HISTORY_EXPORT, OPEN_EXPORT, PRICE_KINDS, boardAsOf, caseRows, exportLockPath, exportRows, exportTexts, noPageRows, toCsv, writeBoardExport } from "../../bot/lib/board-export.js";
import { buildDecision } from "../../bot/lib/decision.js";
import { recordDecision } from "../../bot/lib/lifecycle.js";
import { sentQuoteNote } from "../../bot/lib/sent-quote.js";
import { runSync } from "../../bot/lib/sync.js";
import { buildWorld, tempDir } from "./helpers.js";

// Synthetic fixtures only. One priced case (ABC-100 x 500, ABC-100 x 5000,
// DEF-200 x 10 with no price, asked 2026-09-24) and Claude's mail check, as in
// board-fixes.test.js.
function world(mail = [], { mailCheck = true } = {}) {
  const built = buildWorld();
  const priced = buildDecision(built.options);
  const decision = { ...priced, lifecycle: { ...priced.lifecycle, recommendationVersion: 1 } };
  const outputsDir = tempDir("qpc-export-");
  fs.writeFileSync(path.join(outputsDir, `CLAUDE-DECISION-${decision.caseId}-v1.json`), JSON.stringify(decision));
  const monitorStatePath = path.join(built.root, "monitor.json");
  fs.writeFileSync(monitorStatePath, JSON.stringify({ freshness: { source_cutoff: "2026-10-28T03:00:00Z", stale: false }, operational_queue: [] }));
  const claudeMailPath = path.join(built.root, "claude-mail.json");
  fs.writeFileSync(claudeMailPath, JSON.stringify({ cutoff: "2026-10-28T00:00:00Z", events: Object.fromEntries(mail.map((item) => [item.id, item])) }));
  const inputs = { outputsDir, monitorStatePath, storeDir: built.options.storeDir, claudeMailPath: mailCheck ? claudeMailPath : null };
  return { built, decision, inputs, board: () => buildBoard({ ...inputs, now: new Date("2026-10-28T20:00:00Z") }) };
}
const quoteMail = (at) => ({ id: "q1", at, kind: "quote-sent", customerDomain: "acme.example", from: "pat@shop.example", to: ["buyer@acme.example"], subject: "RE: RFQ ABC-100", partNumbers: ["ABC-100"], rfqNumbers: [], link: "https://mail.example/q1" });
const decide = (decision, outputsDir, lineId, unitPrice, decidedAt = "2026-10-20T16:00:00Z", note = "approved in review") => recordDecision({ outputsDir, caseId: decision.caseId, version: 1, lineId, choice: "alternative", unitPrice, note, decidedBy: "Pat Reviewer", decidedAt, now: new Date(decidedAt) });
// What from-sent leaves on a line: the price, dated the moment the quote went out, with a note naming the email and the row that priced the line.
const readFromQuote = (decision, outputsDir, unitPrice, sentAt = "2026-10-21T01:30:00.000Z") => {
  for (const line of decision.lines) decide(decision, outputsDir, line.lineId, unitPrice, sentAt, sentQuoteNote({ id: "sent-1", sentAt, to: ["buyer@acme.example"], subject: "RE: Quote for ABC-100" }, `P/N: ${line.request.partNumber} / Qty: ${line.request.quantity} / Unit Price: $${unitPrice.toFixed(2)}`));
};
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
// A written file: its header, its rows, and the marker row that ends it (null for text with none).
const STATUS = EXPORT_COLUMNS.indexOf("status");
const parse = (text) => {
  const [head, ...lines] = text.trimEnd().split("\n");
  const last = lines.at(-1)?.split(",") || [];
  const marker = END_OF_FILE.test(last[STATUS] || "") ? { count: Number(last[STATUS].match(END_OF_FILE)[1]), copyId: last.at(-1), asOf: last[0] } : null;
  return { head, lines: marker ? lines.slice(0, -1) : lines, marker };
};

// A case as the board builds it, by hand, for the row rules.
const kase = (extra = {}) => ({
  caseId: "ACME-1", page: "CLAUDE-DECISION-ACME-1-v1.html", open: true, tone: "warn", state: "Waiting", reopened: false, customer: "Acme Precision", customerRecord: { endUser: "Orbit Co" },
  reference: "RFQ 4100", monitorReference: null, email: { from: "buyer@acme.example", fromName: null }, askedAt: "2026-10-01T16:00:00Z", chasedAt: "2026-10-01T16:00:00Z", lastSentAt: null, dueDate: null, confidence: { level: "Medium" },
  lines: [{ lineId: "L1", partNumber: "ABC-100", quantity: 10, suggested: 8.5, lotCharge: null, source: { text: "previous quote" }, decided: null, missing: null }],
  ...extra,
});
const sentCase = (extra = {}) => kase({ open: false, tone: "ok", state: "Quote sent (per mail check)", lastSentAt: "2026-10-21T01:30:00Z", ...extra });
const record = (extra = {}) => ({
  rfq: { urgency: "Needed in two weeks", initiatedAt: "2026-10-01T16:00:00Z", reference: "RFQ 4100" }, commercial: { standardLeadTime: "8-10 business days", expediteEvidence: "Expedite quoted before" }, poLotMinimum: null,
  lines: [{ lineId: "L1", request: { partNumber: "ABC-100", quantity: 10, aliases: [], revision: "B", description: "Seal", material: { value: "A286" }, process: { verbatim: "CLEAN PER SPEC" }, scope: { level: "300" } }, recommendation: { lotMinimum: { minimum: 200 } } }],
  ...extra,
});
const decided = (extra = {}) => ({ choice: "approved", unitPrice: 9, quantity: 10, extended: 90, lotCharge: null, option: null, recommended: { unitPrice: 9, label: "previous quote" }, decidedBy: "Pat Reviewer", decidedAt: "2026-10-20T16:00:00Z", note: null, ...extra });
// A price from-sent read out of the sent quote: dated the moment the email went out, with its note.
const fromQuote = (sentAt = "2026-10-21T01:30:00Z", words = "P/N: ABC-100 / Qty: 10 / Unit Price: $9.00", subject = "RE: RFQ 4100") => decided({ decidedAt: new Date(sentAt).toISOString(), note: sentQuoteNote({ id: "sent-1", sentAt, to: ["buyer@acme.example"], subject }, words) });
const withLine = (base, line) => ({ ...base, lines: [{ ...base.lines[0], ...line }] });

test("a row says what its price is: quoted, decided, only suggested, or none", () => {
  const kind = (theCase) => caseRows(theCase, record())[0];
  // Open and undecided: the board's own figure, marked as a suggestion.
  const suggested = kind(kase());
  assert.deepEqual([suggested.price_kind, suggested.unit_price, suggested.extended, suggested.priced_by, suggested.decided], [PRICE_KINDS.suggested, 8.5, 85, "", ""]);
  assert.equal(suggested.status, "open - ready for a price decision");
  // Decided, quote not seen sent: the decided price, never the suggestion.
  const waiting = kind(withLine(kase({ open: false, tone: "ok", state: "Decided" }), { decided: decided() }));
  assert.deepEqual([waiting.price_kind, waiting.unit_price, waiting.extended, waiting.priced_by, waiting.decided, waiting.sent], [PRICE_KINDS.decided, 9, 90, "Pat Reviewer", "2026-10-20", ""]);
  assert.equal(waiting.status, "decided - quote not seen sent");
  // Decided, the quote went out, and the price was read from that quote.
  const quoted = kind(withLine(sentCase(), { decided: fromQuote() }));
  assert.deepEqual([quoted.price_kind, quoted.unit_price, quoted.status, quoted.price_quote_date], [PRICE_KINDS.quoted, 9, "quote sent", "2026-10-20"]);
  // The quote went out but no price was ever recorded: the suggestion is shown and named as not the quoted price.
  assert.equal(kind(sentCase()).price_kind, PRICE_KINDS.suggestedSent);
  // Nothing priced.
  const none = kind(withLine(kase({ tone: "alert" }), { suggested: null, source: null, missing: "part size (L × W × H)" }));
  assert.deepEqual([none.price_kind, none.unit_price, none.extended, none.missing_facts, none.status], [PRICE_KINDS.none, "", "", "part size (L × W × H)", "open - needs facts"]);
  // A correction is a wrong fact, not a price: the suggestion it rejects is still only a suggestion.
  const corrected = kind(withLine(kase(), { decided: decided({ choice: "correction", unitPrice: null, extended: null, note: "wrong material" }) }));
  assert.deepEqual([corrected.price_kind, corrected.priced_by, corrected.decided], [PRICE_KINDS.suggested, "", ""]);
  assert.match(corrected.missing_facts, /correction recorded: wrong material/);
  // A price question after the quote went out: open again. The board keeps no sent date for it, so only a price read from the sent quote itself is known to be the quoted one.
  const again = kind(withLine(kase({ reopened: true }), { decided: fromQuote() }));
  assert.deepEqual([again.status, again.price_kind, again.unit_price], ["open again - price question after the quote", PRICE_KINDS.quoted, 9]);
  assert.equal(kind(withLine(kase({ reopened: true }), { decided: decided() })).price_kind, PRICE_KINDS.unconfirmed, "a price decided by hand, perhaps since it reopened");
  assert.equal(kind(kase({ reopened: true })).price_kind, PRICE_KINDS.suggestedSent);
});

test("a decided price counts as quoted only when it was read from the sent quote itself", () => {
  const kind = (theCase, line) => caseRows(withLine(theCase, line), record())[0].price_kind;
  // Read by from-sent out of the sent quote: quoted, with that quote's date, whatever date the case has.
  const read = caseRows(withLine(sentCase({ lastSentAt: null }), { decided: fromQuote() }), record())[0];
  assert.deepEqual([read.price_kind, read.price_quote_date, read.sent], [PRICE_KINDS.quoted, "2026-10-20", ""]);
  const later = caseRows(withLine(sentCase(), { decided: fromQuote("2026-10-25T17:00:00Z") }), record())[0];
  assert.deepEqual([later.price_kind, later.price_quote_date, later.sent], [PRICE_KINDS.quoted, "2026-10-25", "2026-10-20"], "a later quote than the last the mail check saw");
  // A price decided by hand is never called quoted on its date: the case's sent date may be a customer's receipt note, and a price recorded after a quote may be a revision still to send.
  for (const decidedAt of ["2026-10-20T16:00:00Z", "2026-10-21T01:30:00Z", "2026-10-22T16:00:00Z", null]) {
    const row = caseRows(withLine(sentCase(), { decided: decided({ decidedAt, note: "approved in review" }) }), record())[0];
    assert.deepEqual([row.price_kind, row.unit_price, row.status, row.price_quote_date, row.sent], [PRICE_KINDS.unconfirmed, 9, "quote sent", "", "2026-10-20"], String(decidedAt));
  }
  assert.equal(kind(sentCase({ lastSentAt: null }), { decided: decided() }), PRICE_KINDS.unconfirmed);
  // from-sent can record one quantity's price from a quote that gave another's. Its date does not make that quoted.
  for (const [words, why] of [["P/N: ABC-100 / Qty: 500 / Unit Price: $9.00", "another quantity"], ["P/N: ABC-100 / Qty: 10 / Unit Price: $8.00", "another price"], ["P/N: XYZ-999 / Qty: 10 / Unit Price: $9.00", "another part"]]) {
    const row = caseRows(withLine(sentCase(), { decided: fromQuote("2026-10-21T01:30:00Z", words) }), record())[0];
    assert.deepEqual([row.price_kind, row.price_quote_date, row.unit_price], [PRICE_KINDS.unconfirmed, "", 9], why);
  }
  assert.equal(kind(sentCase(), { decided: fromQuote("2026-10-21T01:30:00Z", undefined, "RE: RFQ 9999") }), PRICE_KINDS.unconfirmed, "another request's email");
  assert.equal(caseRows(withLine(sentCase(), { decided: fromQuote() }), null)[0].price_kind, PRICE_KINDS.unconfirmed, "no saved record to read the note against");
  // from-sent can write a note its own reader rejects (the customer only in cc, or no message id). It is still a sent-quote price, so its date proves nothing.
  for (const email of [{ id: "sent-1", to: [] }, { to: ["buyer@acme.example"] }]) {
    const note = sentQuoteNote({ sentAt: "2026-10-21T01:30:00Z", subject: "RE: RFQ 4100", ...email }, "P/N: ABC-100 / Qty: 500 / Unit Price: $9.00");
    assert.equal(kind(sentCase(), { decided: decided({ decidedAt: "2026-10-21T01:30:00.000Z", note }) }), PRICE_KINDS.unconfirmed, JSON.stringify(email));
  }
  assert.equal(kind(sentCase(), { decided: decided({ note: "Sent quote yesterday to the buyer" }) }), PRICE_KINDS.unconfirmed, "a typed note");
  // A note in that shape on a decision dated some other time is not from-sent's.
  assert.equal(kind(sentCase(), { decided: { ...fromQuote("2026-10-20T17:00:00Z"), decidedAt: "2026-10-20T18:00:00Z" } }), PRICE_KINDS.unconfirmed);
  assert.equal(kind(sentCase(), { decided: decided({ decidedAt: "2026-10-26T17:00:00Z", note: "Sent quote yesterday to the buyer" }) }), PRICE_KINDS.unconfirmed);
  assert.equal(kind(sentCase(), { decided: decided({ decidedAt: null }) }), PRICE_KINDS.unconfirmed, "an undated decision");
  // A case whose quote the board has not seen sent stays that, and still names the quote its price was read from.
  const unseen = caseRows(withLine(kase({ open: false, tone: "ok", state: "Decided" }), { decided: fromQuote() }), record())[0];
  assert.deepEqual([unseen.price_kind, unseen.price_quote_date], [PRICE_KINDS.decided, "2026-10-20"]);
});

test("the copy's age is how far mail was read, never when a sync ran", () => {
  const sync = { at: "2026-10-29T18:00:00Z" };
  assert.equal(boardAsOf({ claudeMail: { cutoff: "2026-10-28T00:00:00Z" }, monitor: null, lastSync: sync }), "2026-10-27 17:00 PT");
  assert.equal(boardAsOf({ claudeMail: null, monitor: { cutoff: "2026-10-28T03:00:00Z" }, lastSync: sync }), "2026-10-27 20:00 PT", "a monitor-only setup");
  assert.equal(boardAsOf({ claudeMail: { cutoff: "2026-10-28T00:00:00Z" }, monitor: { cutoff: "2026-10-26T03:00:00Z" }, lastSync: sync }), "2026-10-25 20:00 PT", "the source further behind");
  assert.equal(boardAsOf({ claudeMail: { cutoff: null }, monitor: { cutoff: null }, lastSync: sync }), "", "no mail time: unknown, not the sync's");
  // A source in use whose own reach is unknown makes the whole copy's age unknown, however fresh the other is.
  assert.equal(boardAsOf({ claudeMail: { cutoff: "2026-10-28T00:00:00Z" }, monitor: { cutoff: null, withoutPage: [{}] }, lastSync: sync }), "");
  assert.equal(boardAsOf({ claudeMail: { cutoff: "not a time" }, monitor: { cutoff: "2026-10-28T03:00:00Z" }, lastSync: sync }), "");
  assert.equal(boardAsOf({ lastSync: sync }), "");
  // Through a real sync with no mail check: the monitor's cutoff, days before the run.
  const { built, inputs } = world([], { mailCheck: false });
  const boardExportDir = path.join(built.root, "copy");
  const ran = runSync({ config: { routerHistoryFolder: built.options.routerFolder, storeDir: built.options.storeDir, outputsDir: inputs.outputsDir, monitorState: inputs.monitorStatePath, syncLog: path.join(built.root, "sync-log.jsonl"), boardExportDir }, trigger: "test", now: new Date("2026-10-29T18:00:00Z") });
  assert.deepEqual(ran.errors, []);
  const lines = parse(fs.readFileSync(path.join(boardExportDir, OPEN_EXPORT), "utf8")).lines;
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(line.startsWith("2026-10-27 20:00 PT,"), line.slice(0, 30));
});

test("a decided price that is not the suggestion never carries the suggestion's basis or lot charge", () => {
  const own = caseRows(withLine(sentCase(), { lotCharge: 200, decided: decided({ choice: "alternative", unitPrice: 30, extended: 300, option: null }) }), record())[0];
  assert.deepEqual([own.unit_price, own.extended, own.lot_charge, own.price_basis], [30, 300, "", "reviewer's own price"]);
  assert.equal(caseRows(withLine(sentCase(), { decided: decided({ choice: "alternative", option: "labor method" }) }), record())[0].price_basis, "reviewer's own price: labor method");
  assert.equal(caseRows(withLine(sentCase(), { decided: decided() }), record())[0].price_basis, "approved: previous quote");
  // Decided under the minimum: the decision's own lot charge.
  assert.equal(caseRows(withLine(sentCase(), { decided: decided({ lotCharge: 200 }) }), record())[0].lot_charge, 200);
  // Undecided: the suggestion's.
  assert.equal(caseRows(withLine(kase(), { lotCharge: 200 }), record())[0].lot_charge, 200);
});

test("the lot minimum is named with what it applies to", () => {
  const line = caseRows(kase(), record())[0];
  assert.deepEqual([line.lot_minimum, line.lot_minimum_applies_to], [200, "line"]);
  const order = caseRows(kase(), record({ poLotMinimum: { minimum: 250, lotCharge: 250 }, lines: [{ lineId: "L1", request: {}, recommendation: {} }] }))[0];
  assert.deepEqual([order.lot_minimum, order.lot_minimum_applies_to, order.lot_charge], [250, "order", ""]);
  const neither = caseRows(kase(), record({ lines: [{ lineId: "L1", request: {}, recommendation: {} }] }))[0];
  assert.deepEqual([neither.lot_minimum, neither.lot_minimum_applies_to], ["", ""]);
});

test("request facts come from the saved record, and a case without one still gets its row", () => {
  const row = caseRows(kase({ monitorReference: "Acme 4100 / ABC-100", email: { from: "buyer@acme.example", fromName: "Sam Buyer" }, dueDate: "2026-11-05", chasedAt: "2026-10-09T16:00:00Z" }), record(), "2026-10-27 17:00 PT")[0];
  assert.deepEqual(
    [row.board_as_of, row.rfq_id, row.customer, row.end_user, row.contact, row.rfq_reference, row.part_number, row.revision, row.description, row.quantity, row.material, row.spec_callouts, row.expedite, row.lead_time, row.customer_need, row.asked, row.due, row.last_activity, row.confidence],
    ["2026-10-27 17:00 PT", "ACME-1", "Acme Precision", "Orbit Co", "Sam Buyer <buyer@acme.example>", "RFQ 4100 [Acme 4100 / ABC-100]", "ABC-100", "B", "Seal", 10, "A286", "CLEAN PER SPEC | cleanliness level: 300", "Expedite quoted before", "8-10 business days", "Needed in two weeks", "2026-10-01", "2026-11-05", "2026-10-09", "Medium"],
  );
  assert.deepEqual(Object.keys(row), EXPORT_COLUMNS);
  // No saved record: what the board knows still goes out.
  const bare = caseRows(kase(), null)[0];
  assert.deepEqual([bare.rfq_id, bare.part_number, bare.quantity, bare.unit_price, bare.price_kind, bare.material, bare.lot_minimum], ["ACME-1", "ABC-100", 10, 8.5, PRICE_KINDS.suggested, "", ""]);
  // Nothing is cut short, however long: the reader cannot open the board for the rest.
  const callout = `CLEAN PER ${"SPEC-1234 REV C, ".repeat(40)}LEVEL 100`;
  const long = caseRows(kase({ reference: `RFQ ${"4100, ".repeat(80)}4999` }), record({ lines: [{ lineId: "L1", request: { process: { verbatim: callout }, scope: { level: "300" }, description: "D".repeat(300), material: { value: "M".repeat(200) } }, recommendation: {} }], rfq: { urgency: "U".repeat(400) } }))[0];
  assert.deepEqual([long.spec_callouts, long.description.length, long.material.length, long.customer_need.length, long.rfq_reference.length], [`${callout} | cleanliness level: 300`, 300, 200, 400, 488]);
  // The newest the board has from the customer: a later ask, a mailed chase on the card, or the front desk's.
  const activity = (extra) => caseRows(kase(extra), record())[0].last_activity;
  assert.equal(activity({}), "");
  assert.equal(activity({ mailChase: { at: "2026-10-12T16:00:00Z" } }), "2026-10-12");
  assert.equal(activity({ chasedAt: "2026-10-09T16:00:00Z", mailChase: { at: "2026-10-12T16:00:00Z" }, followup: { lastAt: "2026-10-15T16:00:00Z" } }), "2026-10-15");
  assert.equal(activity({ chasedAt: "2026-10-19T16:00:00Z", mailChase: { at: "2026-10-12T16:00:00Z" }, followup: { lastAt: "bad" } }), "2026-10-19");
  // Days are the shop's: a quote sent in the evening is not dated the next day.
  assert.equal(caseRows(sentCase(), record())[0].sent, "2026-10-20");
  assert.equal(caseRows(kase({ askedAt: "not a date" }), record())[0].asked, "");
  // The record's cleanliness level is always given, labelled: a specification number can hold the same digits.
  const levelOf = (verbatim, level) => caseRows(kase(), record({ lines: [{ lineId: "L1", request: { process: { verbatim }, scope: { level } } }] }))[0].spec_callouts;
  assert.equal(levelOf("CLEAN PER SPEC-1300", "300"), "CLEAN PER SPEC-1300 | cleanliness level: 300");
  assert.equal(levelOf("Clean per spec, level 300", "300"), "Clean per spec, level 300 | cleanliness level: 300");
  assert.equal(levelOf("Clean per spec", null), "Clean per spec");
  assert.equal(levelOf(null, "300"), "cleanliness level: 300");
});

test("the file is one line per row whatever the text holds", () => {
  const text = toCsv([{ ...caseRows(kase({ customer: 'Acme, "Precision"\nCorp', reference: "=HYPERLINK(1)" }), record())[0], part_number: "-101A", description: "@home\u2028\ttwo" }]);
  const { head, lines } = parse(text);
  assert.equal(head, EXPORT_COLUMNS.join(","));
  assert.equal(lines.length, 1);
  assert.ok(text.endsWith("\n"));
  assert.match(lines[0], /,"Acme, ""Precision"" Corp",/);
  assert.match(lines[0], /,'=HYPERLINK\(1\),/, "a formula is written as text");
  assert.match(lines[0], /,-101A,/, "a part number keeps its leading dash");
  assert.match(lines[0], /,'@home two,/);
  assert.match(lines[0], /,10,A286,/, "numbers are plain");
  assert.equal(toCsv([]), `${EXPORT_COLUMNS.join(",")}\n`);
});

test("every case on the board lands in exactly one file, and moves to the history when its quote goes out", () => {
  const open = world();
  const before = exportRows(open.board(), { outputsDir: open.inputs.outputsDir });
  assert.equal(before.history.length, 0);
  assert.deepEqual(before.open.map((row) => [row.part_number, row.quantity, row.price_kind]), [["ABC-100", 500, PRICE_KINDS.suggested], ["ABC-100", 5000, PRICE_KINDS.suggested], ["DEF-200", 10, PRICE_KINDS.none]]);
  const first = before.open[0];
  assert.deepEqual([first.customer, first.contact, first.revision, first.material, first.board_as_of, first.asked, first.lot_minimum, first.lot_minimum_applies_to], ["Acme <Precision> Corp.", "buyer@acme.example", "B", "A286", "2026-10-27 17:00 PT", "2026-09-24", 200, "order"]);
  assert.match(first.spec_callouts, /LEVEL 300R4 NOT FOR OXYGEN SERVICE/);
  assert.ok(before.open[2].missing_facts, "the unpriced line names what it is waiting on");
  assert.ok(first.unit_price > 0 && first.extended === Math.round(first.unit_price * 500 * 100) / 100);

  // The quote is seen sent, and from-sent read every line's price out of it.
  const sent = world([quoteMail("2026-10-21T01:30:00Z")]);
  readFromQuote(sent.decision, sent.inputs.outputsDir, 12);
  const board = sent.board();
  assert.equal(caseGroup(board.cases[0]), "sent");
  const after = exportRows(board, { outputsDir: sent.inputs.outputsDir });
  assert.equal(after.open.length, 0);
  assert.deepEqual(after.history.map((row) => [row.part_number, row.quantity, row.price_kind, row.unit_price, row.extended, row.priced_by, row.decided, row.sent, row.price_quote_date, row.status]), [
    ["ABC-100", 500, PRICE_KINDS.quoted, 12, 6000, "Pat Reviewer", "2026-10-20", "2026-10-20", "2026-10-20", "quote sent"],
    ["ABC-100", 5000, PRICE_KINDS.quoted, 12, 60000, "Pat Reviewer", "2026-10-20", "2026-10-20", "2026-10-20", "quote sent"],
    ["DEF-200", 10, PRICE_KINDS.quoted, 12, 120, "Pat Reviewer", "2026-10-20", "2026-10-20", "2026-10-20", "quote sent"],
  ]);
  // Every line of every case, once.
  assert.equal(after.open.length + after.history.length, board.cases.reduce((sum, item) => sum + item.lines.length, 0));

  // A replacement price recorded on one line after the quote went out: the card stays sent, and that price is not called quoted.
  decide(sent.decision, sent.inputs.outputsDir, "L1", 14, "2026-10-23T16:00:00Z");
  const revised = sent.board();
  assert.equal(caseGroup(revised.cases[0]), "sent");
  assert.deepEqual(exportRows(revised, { outputsDir: sent.inputs.outputsDir }).history.map((row) => [row.quantity, row.price_kind, row.unit_price]), [[500, PRICE_KINDS.unconfirmed, 14], [5000, PRICE_KINDS.quoted, 12], [10, PRICE_KINDS.quoted, 12]]);
});

test("what the board lists with no price page is in the open file too", () => {
  const mail = (id, kind, extra = {}) => ({ id, kind, at: "2026-10-27T16:00:00Z", customerDomain: "newco.example", from: "sam@newco.example", subject: `RFQ ${id}`, note: "Asks for a price on two seals", partNumbers: ["NEW-1", "NEW-2"], rfqNumbers: [], dueDate: null, monitor: null, ...extra });
  const entry = (customer, reference, extra = {}) => ({ customer, reference, status: "awaiting a price", lastActivityAt: "2026-10-26T16:00:00Z", dueDate: null, email: { from: "buyer@acme.example", fromName: "Sam Buyer" }, ...extra });
  const board = {
    cases: [], claudeMail: { cutoff: "2026-10-28T00:00:00Z" },
    mailFound: [
      mail("new", "rfq", { dueDate: "2026-11-05" }),
      mail("locked", "secure", { at: "2026-10-26T16:00:00Z" }),
      mail("chase", "followup", { subject: "RE: any update?", monitor: { customer: "NewCo Inc", reference: "NewCo 77", matchedBy: "reference", dueDate: "2026-11-02" } }),
      mail("ask", "question", { monitor: { customer: "NewCo Inc", reference: "NewCo 78", matchedBy: "customer", dueDate: "2026-11-03" } }),
      mail("paper", "rfq", { subject: "RE: packing slip" }),
      mail("back", "rfq", { subject: "FW: cert request", at: "2026-10-28T16:00:00Z" }),
    ],
    chasing: { unmatched: [{ id: "t1", contact: "Lee Caller", company: null, subject: "Called about the valve quote", firstAt: "2026-10-20T16:00:00Z", lastAt: "2026-10-27T18:00:00Z", note: "Wants a call back", label: "chase" }] },
    monitor: { cutoff: "2026-10-28T03:00:00Z", withoutPage: [entry("Acme Precision", "Acme 4100"), entry("Acme Precision", "Acme 4101 paperwork")], owed: [entry("Orbit Co", "Orbit 12", { dueDate: "2026-11-01" })], openAfterQuote: [entry("Orbit Co", "Orbit 9")] },
    triage: {
      "mail|newco.example|packing slip": { at: "2026-10-27T17:00:00Z", reason: "packing slip only" },
      "mail|newco.example|cert request": { at: "2026-10-27T17:00:00Z", reason: "paperwork" },
      "mail|newco.example|any update?": { at: "2026-10-27T17:00:00Z", reason: "a chase is never set aside" },
      "monitor|Acme Precision|Acme 4101 paperwork": { at: "2026-10-27T17:00:00Z", reason: "already ordered" },
    },
  };
  const rows = noPageRows(board);
  const by = Object.fromEntries(rows.map((row) => [row.rfq_reference, row]));
  assert.equal(rows.length, 11, "every listed row, set aside or not");
  for (const row of rows) assert.deepEqual([Object.keys(row), row.rfq_id, row.price_kind, row.unit_price, row.board_as_of], [EXPORT_COLUMNS, "", PRICE_KINDS.none, "", "2026-10-27 17:00 PT"]);
  // A long list of parts is kept whole.
  const parts = Array.from({ length: 30 }, (_, index) => `PART-${1000 + index}`);
  assert.equal(noPageRows({ cases: [], mailFound: [mail("many", "rfq", { partNumbers: parts })] })[0].part_number, parts.join("; "));
  const fresh = by["RFQ new"];
  assert.deepEqual([fresh.status, fresh.customer, fresh.contact, fresh.part_number, fresh.description, fresh.asked, fresh.due, fresh.last_activity], ["open - no price page yet (request)", "newco.example", "sam@newco.example", "NEW-1; NEW-2", "Asks for a price on two seals", "2026-10-27", "2026-11-05", "2026-10-27"]);
  assert.equal(by["RFQ locked"].status, "open - no price page yet (protected message)");
  // A chase: the monitor's own match names it and dates it; a same-customer guess does neither. Never set aside.
  const chase = by["RE: any update? [NewCo 77]"];
  assert.deepEqual([chase.status, chase.customer, chase.asked, chase.due, chase.last_activity], ["open - no price page yet (chase)", "NewCo Inc", "", "2026-11-02", "2026-10-27"]);
  assert.deepEqual([by["RFQ ask"].status, by["RFQ ask"].due], ["open - no price page yet (question)", ""]);
  // Set aside by triage: still listed, and marked. New activity after the check brings it back.
  assert.equal(by["RE: packing slip"].status, "set aside - Paperwork, not pricing");
  assert.equal(by["FW: cert request"].status, "open - no price page yet (request)");
  // The front desk's chase with no page.
  const call = by["Called about the valve quote"];
  assert.deepEqual([call.status, call.contact, call.description, call.asked, call.last_activity], ["open - no price page yet (front desk chase)", "Lee Caller", "Wants a call back", "2026-10-20", "2026-10-27"]);
  // A mail monitor's own lists, while one is in use.
  assert.deepEqual([by["Acme 4100"].status, by["Acme 4100"].contact, by["Acme 4100"].description], ["open - no price page yet (mail monitor)", "Sam Buyer <buyer@acme.example>", "awaiting a price"]);
  assert.equal(by["Acme 4101 paperwork"].status, "set aside - Already answered or ordered");
  assert.deepEqual([by["Orbit 12"].status, by["Orbit 12"].due], ["open - quote still owed, no price page (mail monitor)", "2026-11-01"]);
  assert.equal(by["Orbit 9"].status, "open again - price question after the quote, no price page (mail monitor)");
  // What is still to act on comes first, newest first; what was set aside last.
  assert.deepEqual(rows.map((row) => row.status.startsWith("set aside")), [false, false, false, false, false, false, false, false, false, true, true]);
  assert.equal(rows[0].rfq_reference, "FW: cert request");
  // They follow the cases in the open file, and never reach the history.
  const all = exportRows(board);
  assert.deepEqual([all.open.length, all.history.length, all.noPage], [11, 0, 11]);
  assert.deepEqual(noPageRows({ cases: [] }), []);

  // Through the real board: a request the mail check found from a customer with no page.
  const real = world([{ id: "n1", at: "2026-10-27T16:00:00Z", kind: "rfq", customerDomain: "newco.example", from: "sam@newco.example", to: ["sales@shop.example"], subject: "RFQ for seals", partNumbers: ["NEW-1"], rfqNumbers: [], link: "https://mail.example/n1" }]);
  const built = real.board();
  assert.equal(built.mailFound.length, 1);
  const open = exportRows(built, { outputsDir: real.inputs.outputsDir }).open;
  assert.deepEqual(open.map((row) => [row.status, row.part_number, row.contact]), [
    ["open - needs facts", "ABC-100", "buyer@acme.example"], ["open - needs facts", "ABC-100", "buyer@acme.example"], ["open - needs facts", "DEF-200", "buyer@acme.example"],
    ["open - no price page yet (request)", "NEW-1", "sam@newco.example"],
  ]);
});

test("writing the export changes nothing it reads, and rewrites a file only when its text changes", () => {
  const { decision, inputs, board } = world();
  const exportDir = path.join(tempDir("qpc-export-out-"), "copy");
  const records = snapshot(inputs.outputsDir);
  const { copyId, ...first } = writeBoardExport({ outputsDir: inputs.outputsDir, exportDir, board: board() });
  assert.deepEqual(first, { written: [OPEN_EXPORT, HISTORY_EXPORT], rows: { open: 3, history: 0 }, cases: 1, noPage: 0 });
  assert.match(copyId, /^[0-9a-f]{10}$/);
  assert.deepEqual(fs.readdirSync(exportDir).sort(), [HISTORY_EXPORT, OPEN_EXPORT].sort());
  assert.deepEqual(snapshot(inputs.outputsDir), records, "no record, decision or page is touched");
  assert.equal(parse(fs.readFileSync(path.join(exportDir, OPEN_EXPORT), "utf8")).lines.length, 3);
  // A file with no request still says it is whole and which copy it belongs to.
  const empty = parse(fs.readFileSync(path.join(exportDir, HISTORY_EXPORT), "utf8"));
  assert.deepEqual([empty.head, empty.lines, empty.marker], [EXPORT_COLUMNS.join(","), [], { count: 0, copyId, asOf: "2026-10-27 17:00 PT" }]);
  // The same board again: nothing is rewritten.
  const stamp = new Date("2026-01-01T00:00:00Z");
  for (const name of [OPEN_EXPORT, HISTORY_EXPORT]) fs.utimesSync(path.join(exportDir, name), stamp, stamp);
  assert.deepEqual(writeBoardExport({ outputsDir: inputs.outputsDir, exportDir, board: board() }).written, []);
  assert.equal(fs.statSync(path.join(exportDir, OPEN_EXPORT)).mtimeMs, stamp.getTime());
  // A decision changes the open file's rows, so both files are written: they carry one copy id between them.
  decide(decision, inputs.outputsDir, "L1", 12);
  const next = writeBoardExport({ outputsDir: inputs.outputsDir, exportDir, board: board() });
  assert.deepEqual(next.written, [OPEN_EXPORT, HISTORY_EXPORT]);
  assert.notEqual(next.copyId, copyId);
  assert.match(fs.readFileSync(path.join(exportDir, OPEN_EXPORT), "utf8"), /,decided - quote not seen sent,/);
});

test("the two files say they are one copy, and each says it is whole", () => {
  const { inputs, board } = world([{ id: "n1", at: "2026-10-27T16:00:00Z", kind: "rfq", customerDomain: "newco.example", from: "sam@newco.example", to: ["sales@shop.example"], subject: "RFQ for seals", partNumbers: ["NEW-1"], rfqNumbers: [], link: "https://mail.example/n1" }]);
  const texts = exportTexts(board(), { outputsDir: inputs.outputsDir });
  const [open, history] = [parse(texts.open), parse(texts.history)];
  assert.deepEqual([open.lines.length, open.marker, history.lines.length, history.marker], [4, { count: 4, copyId: texts.copyId, asOf: "2026-10-27 17:00 PT" }, 0, { count: 0, copyId: texts.copyId, asOf: "2026-10-27 17:00 PT" }]);
  // Every row of both files carries the copy's id, in the last cell.
  for (const line of open.lines) assert.ok(line.endsWith(`,${texts.copyId}`), line.slice(-30));
  // The marker is one more line of the same shape and is no request: no id, no part, no price.
  const marker = texts.open.trimEnd().split("\n").at(-1).split(",");
  assert.equal(marker.length, EXPORT_COLUMNS.length);
  assert.deepEqual(marker.filter(Boolean), ["2026-10-27 17:00 PT", "END OF FILE - 4 rows above - not a request", texts.copyId]);
  // The same board gives the same id; any change to either file's rows gives another.
  assert.equal(exportTexts(board(), { outputsDir: inputs.outputsDir }).copyId, texts.copyId);
  const changed = { ...board(), mailFound: [] };
  assert.notEqual(exportTexts(changed, { outputsDir: inputs.outputsDir }).copyId, texts.copyId);
  assert.equal(parse(toCsv([{ status: "END OF FILE - 1 row above - not a request" }])).marker.count, 1);
});

test("while the files are being written, no request is ever in neither of them", () => {
  // Boards by hand: A and B each one line, in whichever file their state puts them.
  const one = (caseId, sent) => (sent ? sentCase : kase)({ caseId, page: `CLAUDE-DECISION-${caseId}-v1.html` });
  const boardOf = (states) => ({ cases: Object.entries(states).map(([caseId, sent]) => one(caseId, sent)), claudeMail: { cutoff: "2026-10-28T00:00:00Z" } });
  const outputsDir = tempDir("qpc-export-none-");
  // The ids in a written file, each as the file writes it (quoted when it holds a comma or a quote).
  const written = (caseId) => (/[",]/.test(caseId) ? `"${caseId.replace(/"/g, '""')}"` : caseId);
  const idsOf = (text) => ({ includes: (caseId) => parse(text).lines.some((line) => line.startsWith(`2026-10-27 17:00 PT,${written(caseId)},`)), sort: () => parse(text).lines.map((line) => line.slice("2026-10-27 17:00 PT,".length).split(/,(?:open|quote)/)[0]).sort() });
  const move = (from, to) => {
    const exportDir = tempDir("qpc-export-move-");
    writeBoardExport({ outputsDir, exportDir, board: boardOf(from) });
    const seen = [];
    const result = writeBoardExport({ outputsDir, exportDir, board: boardOf(to), write: (file, text) => {
      fs.writeFileSync(file, text);
      const now = snapshot(exportDir);
      // What a reader opening both files at this moment finds.
      for (const caseId of Object.keys(to)) assert.ok(idsOf(now[OPEN_EXPORT]).includes(caseId) || idsOf(now[HISTORY_EXPORT]).includes(caseId), `${caseId} in neither file after writing ${path.basename(file)} (step ${seen.length + 1})`);
      seen.push(path.basename(file));
    } });
    const after = snapshot(exportDir);
    // And at the end each is where it belongs, once, under one copy id.
    assert.deepEqual([idsOf(after[OPEN_EXPORT]).sort(), idsOf(after[HISTORY_EXPORT]).sort()], [Object.keys(to).filter((id) => !to[id]).map(written).sort(), Object.keys(to).filter((id) => to[id]).map(written).sort()]);
    assert.deepEqual([parse(after[OPEN_EXPORT]).marker.copyId, parse(after[HISTORY_EXPORT]).marker.copyId], [result.copyId, result.copyId]);
    return seen;
  };
  // A quote goes out: the history takes the request before the open file lets it go.
  assert.deepEqual(move({ A: false, B: false }, { A: true, B: false }), [HISTORY_EXPORT, OPEN_EXPORT]);
  // A sent request reopens: the open file takes it before the history lets it go.
  assert.deepEqual(move({ A: true, B: true }, { A: false, B: true }), [OPEN_EXPORT, HISTORY_EXPORT]);
  // Both at once: the history first keeps what it is about to lose, then the open file, then the history as it should be.
  assert.deepEqual(move({ A: true, B: false }, { A: false, B: true }), [HISTORY_EXPORT, OPEN_EXPORT, HISTORY_EXPORT]);
  // An id that needs quoting in the file is followed all the same.
  assert.deepEqual(move({ "A, \"x\"": true, B: false }, { "A, \"x\"": false, B: true }).length, 3);
});

test("a write that fails part-way leaves the last whole copy, never a request in neither file", { skip: process.getuid?.() === 0 }, () => {
  const exportDir = tempDir("qpc-export-pair-");
  const openWorld = world();
  writeBoardExport({ outputsDir: openWorld.inputs.outputsDir, exportDir, board: openWorld.board() });
  const before = snapshot(exportDir);
  assert.equal(parse(before[OPEN_EXPORT]).lines.length, 3);
  // The quote goes out: the case leaves the open file for the history. The history takes it, then the open file cannot be written.
  const sent = world([quoteMail("2026-10-21T01:30:00Z")]);
  for (const line of sent.decision.lines) decide(sent.decision, sent.inputs.outputsDir, line.lineId, 12);
  fs.chmodSync(path.join(exportDir, OPEN_EXPORT), 0o444);
  assert.throws(() => writeBoardExport({ outputsDir: sent.inputs.outputsDir, exportDir, board: sent.board() }));
  assert.deepEqual(snapshot(exportDir), before, "both files as they were: the case is still in the open one");
  // Once it can be written, the move goes through whole.
  fs.chmodSync(path.join(exportDir, OPEN_EXPORT), 0o644);
  assert.deepEqual(writeBoardExport({ outputsDir: sent.inputs.outputsDir, exportDir, board: sent.board() }).written, [OPEN_EXPORT, HISTORY_EXPORT]);
  const after = snapshot(exportDir);
  assert.deepEqual([parse(after[OPEN_EXPORT]).lines.length, parse(after[HISTORY_EXPORT]).lines.length], [0, 3]);
  // A first run that fails leaves no half of a pair behind.
  const fresh = path.join(tempDir("qpc-export-pair-"), "copy");
  fs.mkdirSync(path.join(fresh, OPEN_EXPORT), { recursive: true });
  assert.throws(() => writeBoardExport({ outputsDir: sent.inputs.outputsDir, exportDir: fresh, board: sent.board() }));
  assert.equal(fs.existsSync(path.join(fresh, HISTORY_EXPORT)), false);
});

test("a write that empties its file and then fails is put back too", () => {
  const exportDir = tempDir("qpc-export-short-");
  const openWorld = world();
  writeBoardExport({ outputsDir: openWorld.inputs.outputsDir, exportDir, board: openWorld.board() });
  const before = snapshot(exportDir);
  const sent = world([quoteMail("2026-10-21T01:30:00Z")]);
  for (const line of sent.decision.lines) decide(sent.decision, sent.inputs.outputsDir, line.lineId, 12);
  // The history is written; the open file's write leaves it empty and throws (a full disk).
  const failing = (file, text) => { if (path.basename(file) === OPEN_EXPORT) { fs.writeFileSync(file, ""); throw new Error("no space left"); } fs.writeFileSync(file, text); };
  assert.throws(() => writeBoardExport({ outputsDir: sent.inputs.outputsDir, exportDir, board: sent.board(), write: failing }), /no space left$/);
  assert.deepEqual(snapshot(exportDir), before, "the emptied open file and the written history are both as they were");
  // The very first write failing the same way leaves no file behind.
  const fresh = path.join(tempDir("qpc-export-short-"), "copy");
  assert.throws(() => writeBoardExport({ outputsDir: sent.inputs.outputsDir, exportDir: fresh, board: sent.board(), write: (file) => { fs.writeFileSync(file, ""); throw new Error("no space left"); } }));
  assert.deepEqual(fs.readdirSync(fresh), []);
  assert.equal(fs.existsSync(exportLockPath(exportDir)), false, "the lock is released after a failure");
});

test("two writers never interleave: the second waits its turn or writes nothing", () => {
  const exportDir = tempDir("qpc-export-lock-");
  const older = world();
  const newer = world([quoteMail("2026-10-21T01:30:00Z")]);
  for (const line of newer.decision.lines) decide(newer.decision, newer.inputs.outputsDir, line.lineId, 12);
  const write = (who) => writeBoardExport({ outputsDir: who.inputs.outputsDir, exportDir, board: who.board(), lock: { waitMs: 150 } });
  write(older);
  // The newer board (the case now sent) is half-way through its write when a writer holding the older board (the case still open) comes in.
  let stepped = 0;
  const during = (file, text) => {
    fs.writeFileSync(file, text);
    if (stepped++ === 0) assert.throws(() => write(older), /another board export is writing to this folder; nothing written/);
  };
  writeBoardExport({ outputsDir: newer.inputs.outputsDir, exportDir, board: newer.board(), write: during });
  assert.equal(stepped, 2);
  const rowsIn = (name) => parse(snapshot(exportDir)[name]).lines.length;
  assert.deepEqual([rowsIn(OPEN_EXPORT), rowsIn(HISTORY_EXPORT)], [0, 3], "the newer copy went through whole");
  // The older writer, on its own turn, writes its whole copy: stale until the next rebuild, and the case is still there.
  write(older);
  assert.deepEqual([rowsIn(OPEN_EXPORT), rowsIn(HISTORY_EXPORT)], [3, 0]);
  // A lock left by a writer that died is taken over; one held by a live process is not, however old it is.
  const lock = exportLockPath(exportDir);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(lock, `${gone}:left-behind`);
  assert.deepEqual(write(newer).written, [OPEN_EXPORT, HISTORY_EXPORT]);
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, `${process.ppid}:someone-else`);
  const longAgo = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(lock, longAgo, longAgo);
  assert.throws(() => write(older), /another board export/);
  assert.deepEqual([rowsIn(OPEN_EXPORT), rowsIn(HISTORY_EXPORT)], [0, 3]);
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.ppid}:someone-else`, "another writer's lock is never removed");
  fs.unlinkSync(lock);
  // The folder reached through a symlink is the same folder, and the same lock.
  const link = path.join(tempDir("qpc-export-link-"), "copy");
  fs.symlinkSync(exportDir, link);
  assert.equal(exportLockPath(link), lock);
  let linked = 0;
  writeBoardExport({ outputsDir: older.inputs.outputsDir, exportDir, board: older.board(), write: (file, text) => {
    fs.writeFileSync(file, text);
    if (linked++ === 0) assert.throws(() => writeBoardExport({ outputsDir: newer.inputs.outputsDir, exportDir: link, board: newer.board(), lock: { waitMs: 150 } }), /another board export/);
  } });
  assert.deepEqual([linked, rowsIn(OPEN_EXPORT), rowsIn(HISTORY_EXPORT)], [2, 3, 0]);
  // A lock that cannot be read is an error at once, not a wait without end.
  fs.mkdirSync(lock);
  const started = Date.now();
  assert.throws(() => writeBoardExport({ outputsDir: newer.inputs.outputsDir, exportDir, board: newer.board() }), /EISDIR|EPERM|EACCES/);
  assert.ok(Date.now() - started < 5000);
  fs.rmdirSync(lock);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((name) => name.startsWith(path.basename(lock))), [], "no lock or lock scrap is left behind");
});

test("a sync writes the export only where the config names a folder", () => {
  const { built, inputs } = world();
  const config = { routerHistoryFolder: built.options.routerFolder, storeDir: built.options.storeDir, outputsDir: inputs.outputsDir, monitorState: inputs.monitorStatePath, claudeMail: inputs.claudeMailPath, syncLog: path.join(built.root, "sync-log.jsonl") };
  const without = runSync({ config, trigger: "test" });
  assert.deepEqual(without.errors, []);
  assert.equal(without.export, undefined);
  const boardExportDir = path.join(built.root, "copy");
  assert.equal(fs.existsSync(boardExportDir), false);
  const withFolder = runSync({ config: { ...config, boardExportDir }, trigger: "test" });
  assert.deepEqual(withFolder.errors, []);
  assert.deepEqual(withFolder.export, { open: 3, history: 0, noPage: 0, written: [OPEN_EXPORT, HISTORY_EXPORT] });
  assert.deepEqual(fs.readdirSync(boardExportDir).sort(), [HISTORY_EXPORT, OPEN_EXPORT].sort());
  // A folder that cannot be written is reported and the board still stands.
  const blocked = path.join(built.root, "blocked");
  fs.writeFileSync(blocked, "a file where the folder should be");
  const failed = runSync({ config: { ...config, boardExportDir: blocked }, trigger: "test" });
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /^export: /);
  assert.ok(failed.board);
});

test("every command that rewrites the board writes the export too", () => {
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "bot", "cli.js");
  for (const command of ["board", "mail-placement", "export"]) {
    const { built, inputs } = world();
    const boardExportDir = path.join(built.root, "copy");
    const configFile = path.join(built.root, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ routerHistoryFolder: built.options.routerFolder, storeDir: built.options.storeDir, outputsDir: inputs.outputsDir, monitorState: inputs.monitorStatePath, claudeMail: inputs.claudeMailPath, syncLog: path.join(built.root, "sync-log.jsonl"), boardExportDir }));
    const run = spawnSync(process.execPath, [cli, command], { env: { ...process.env, QPC_BOT_CONFIG: configFile }, encoding: "utf8" });
    assert.equal(run.status, 0, `${command}: ${run.stderr}`);
    assert.match(run.stdout, /[Ee]xport in .*: 3 open and 0 sent rows from 1 requests with a price page and 0 listed without one/, command);
    assert.deepEqual(fs.readdirSync(boardExportDir).sort(), [HISTORY_EXPORT, OPEN_EXPORT].sort(), command);
  }
  // With no folder in the config, nothing is written and the board command says nothing of it.
  const { built, inputs } = world();
  const configFile = path.join(built.root, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ routerHistoryFolder: built.options.routerFolder, storeDir: built.options.storeDir, outputsDir: inputs.outputsDir, monitorState: inputs.monitorStatePath, claudeMail: inputs.claudeMailPath, syncLog: path.join(built.root, "sync-log.jsonl") }));
  const run = spawnSync(process.execPath, [cli, "board"], { env: { ...process.env, QPC_BOT_CONFIG: configFile }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /export in|EXPORT FAILED/i);
  assert.equal(spawnSync(process.execPath, [cli, "export"], { env: { ...process.env, QPC_BOT_CONFIG: configFile }, encoding: "utf8" }).status, 1, "export with nowhere to write");
});

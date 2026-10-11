import assert from "node:assert/strict";
import test from "node:test";
import { runShadow, scrub } from "../../bot/lib/shadow.js";
import { cacheKey, judgeAll, topLevel } from "../../bot/lib/typesafe.js";

// A stand-in for TypeSafe: answers from keywords, records what was sent.
function fakeTypeSafe() {
  const sent = [];
  const ask = async ({ state, questions }) => {
    sent.push(state);
    const answers = {};
    const text = JSON.stringify(state).toLowerCase();
    if (questions.sent) answers.sent = { type: "noul", noul: /quoted per ledger|draft/.test(text) ? 0.05 : /sent|receipt/.test(text) ? 0.95 : 0.04 };
    if (questions.pricing) answers.pricing = { type: "noul", noul: /pric|quote request/.test(text) ? 0.96 : 0.03 };
    if (questions.urgency) {
      const level = /due today|asap/.test(text) ? "2" : "0";
      answers.urgency = { type: "score", score: Number(level), confidence: 0.9, probabilities: { 0: level === "0" ? 1 : 0, 1: 0, 2: level === "2" ? 1 : 0 } };
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 100 } };
  };
  return { ask, sent };
}

const entry = (customer, reference, status, priority_section) => ({ customer, reference, status, priority_section });
const post = (id, at, text, replyTo = null) => ({ id, at, from: "Front Desk", replyTo, text });

test("only disagreements with the board's rules are reported, and each says what it would change", async () => {
  const { ask } = fakeTypeSafe();
  const queue = [
    entry("Acme Precision", "RFQ 4100", "Quote sent 9/29", 3),
    entry("Beta Works", "RFQ 9", "Customer has the quote; sent by email Monday", 3),
    entry("Gamma Tools", "Pricing for 40 pcs", "Customer asked for pricing on 40 pcs", 2),
    entry("Delta Labs", "RFQ 77 bath clean", "Waiting on drawing", 2),
    entry("Omega Corp", "RFQ 5", "New RFQ", 1),
  ];
  const report = await runShadow({ queue, chatMessages: [], cache: {}, ask });
  assert.equal(report.monitor.judged, 4, "sections 2 and 3 only");
  const rows = report.monitor.rows.map((row) => `${row.check}|${row.reference}`);
  assert.deepEqual(rows.sort(), ["price request|RFQ 77 bath clean", "quote sent|RFQ 9"]);
  const missed = report.monitor.rows.find((row) => row.reference === "RFQ 9");
  assert.equal(missed.rule, false);
  assert.match(missed.effect, /rule missed/);
  const fromReference = report.monitor.rows.find((row) => row.reference === "RFQ 77 bath clean");
  assert.equal(fromReference.ruleFromReferenceOnly, true, "the rule matched the reference, which is never sent");
});

test("names, references and @-mentions are not sent; answers are reused from the cache", async () => {
  const { ask, sent } = fakeTypeSafe();
  const queue = [entry("Acme Precision", "RFQ 4100 part ABC-1000", "Acme confirmed quote receipt", 3)];
  const chatMessages = [
    post("1", "2026-10-01T15:00:00Z", "Pat from Acme is F/U on this request: RFQ 4100\n@Sam Reviewer"),
    post("2", "2026-10-02T15:00:00Z", "2nd f/u, due today", "1"),
  ];
  const cache = {};
  const first = await runShadow({ queue, chatMessages, cache, ask });
  const text = JSON.stringify(sent);
  assert.doesNotMatch(text, /Acme|Pat\b|Sam Reviewer|ABC-1000/);
  assert.match(text, /the customer confirmed quote receipt/);
  assert.equal(first.tokens, 200);
  const calls = sent.length;
  const again = await runShadow({ queue, chatMessages, cache, ask });
  assert.equal(sent.length, calls, "nothing resent");
  assert.equal(again.tokens, 0);
});

test("staff, contacts, other companies, numbers, subjects and quoted email never leave QPC", async () => {
  const { ask, sent } = fakeTypeSafe();
  const queue = [
    { ...entry("Acme Precision", "RFQ 4100", "Quote sent by Pat to Sam; Zorvex end user", 3), last_observed_actor: "pat.lee@shop.example", events: [{ actor: "sam@acme.example" }] },
    entry("Beta Works", "RFQ 4200", "Al quoted $12 each; pricing not involved", 2),
  ];
  const chatMessages = [
    post("1", "2026-10-01T15:00:00Z", "Al from Beta is F/U on this request: RFQ 4200\nSubject Line: RE: Beta RFQ 4200 cleaning\nneeds it by Friday\n-----Original Message-----\nFrom: buyer@beta.example\nPlease quote 40 pcs"),
    { ...post("2", "2026-10-02T15:00:00Z", "@al.smith 2nd f/u, due today", "1"), from: "Pat Lee" },
  ];
  await runShadow({ queue, chatMessages, cache: {}, ask });
  const text = JSON.stringify(sent);
  assert.doesNotMatch(text, /Pat|Sam|Lee|\bAl\b|al\.smith|Acme|Beta|4100|4200|Subject Line|cleaning|Original Message|buyer@|Please quote/);
  assert.match(text, /Quote sent by someone to someone/);
  assert.match(text, /needs it by Friday/, "the poster's own deadline stays");
  assert.match(text, /pricing not involved/);
  assert.doesNotMatch(text, /Zorvex/, "a capitalised word never written in lower case is a name");
});

test("status headers, quoted text, accented and all-caps names stay home; a leading word keeps its meaning", async () => {
  const { ask, sent } = fakeTypeSafe();
  const queue = [entry("Acme", "RFQ 4100", "Quote pending\nSubject: confidential process\n> please quote 40 pcs", 2), entry("Beta", "RFQ 4200", "Quote sent by Élodie; ZORVEX end user", 3), entry("Gamma", "RFQ 4300", "Not quoted", 3), entry("Delta", "RFQ 4400", "customer wrote: \"please quote 40 pcs\"", 2)];
  await runShadow({ queue, chatMessages: [{ ...post("1", "2026-10-01T15:00:00Z", "status?"), from: "Élodie Brun" }], cache: {}, ask });
  const text = JSON.stringify(sent);
  assert.doesNotMatch(text, /confidential|please quote|Élodie|ZORVEX/);
  assert.match(text, /Not quoted/);
});

test("the price-request check compares with the board's whole Quote owed test", async () => {
  const { ask } = fakeTypeSafe();
  const report = await runShadow({ queue: [entry("Acme", "RFQ 4300", "Quote sent; pricing question answered", 2)], chatMessages: [], cache: {}, ask });
  assert.equal(report.monitor.rows.filter((row) => row.check === "price request" && row.rule === true).length, 0, "a sent quote is not owed by the board's rule either");
});

test("chase urgency compares the words only, and the rule's keyword is shown", async () => {
  const { ask } = fakeTypeSafe();
  const chatMessages = [
    post("1", "2026-10-01T15:00:00Z", "Pat from Acme is F/U on this request: RFQ 4100"),
    post("2", "2026-10-02T15:00:00Z", "they need it in a month", "1"),
    post("3", "2026-10-03T15:00:00Z", "Sam from Beta is F/U on this request: RFQ 9\ndue today asap"),
  ];
  const report = await runShadow({ queue: [], chatMessages, cache: {}, ask });
  assert.equal(report.chases.judged, 2);
  assert.deepEqual(report.chases.rows.map((row) => [row.company, row.rule, row.typesafe, row.ruleWord]), [["Acme", "urgent", "routine", "in a month"]]);
});

test("a failed call is reported, not cached, and does not stop the others", async () => {
  let calls = 0;
  const ask = async () => {
    calls++;
    if (calls === 1) throw new Error("TypeSafe 503: busy");
    return { model: "jev-1.13.0", answers: { sent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 50 } };
  };
  const cache = {};
  const { results } = await judgeAll({ states: [{ status: "a" }, { status: "b" }], questions: { sent: {} }, cache, ask, concurrency: 1 });
  assert.equal(results[0].error, "TypeSafe 503: busy");
  assert.equal(results[1].answers.sent.noul, 0.9);
  assert.equal(Object.keys(cache).length, 1);
  assert.notEqual(cacheKey({ state: "a", questions: {} }), cacheKey({ state: "a", questions: {}, model: "jev-2" }), "a new model is a new answer");
});

test("helpers: the top Score level and name scrubbing", () => {
  assert.equal(topLevel({ probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 } }), 1);
  assert.equal(topLevel({}), null);
  assert.equal(scrub("Acme Precision says Acme will wait", ["Acme Precision"], "the customer"), "the customer says the customer will wait");
  assert.equal(scrub("No change", ["", "Al"], "x"), "No change", "short or empty names are left alone");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildDecision } from "../../bot/lib/decision.js";
import { otherCustomerPrice } from "../../bot/lib/other-customer.js";
import { recommend } from "../../bot/lib/recommend.js";
import { priceSource } from "../../bot/lib/review-card.js";
import { RULINGS } from "../../bot/lib/rulings.js";
import { buildWorld } from "./helpers.js";

// Synthetic data only: ruling other-customer-hold-v1.
const match = (customer, received, unitPrice, extra = {}) => ({ bucket: "other-customer", category: "ordinary", differences: [], record: { customer, received, unitPrice, wo: `${received.slice(5, 7)}01WA` }, ...extra });
const line = { lineId: "L1", partNumber: "ABC-100", quantity: 40 };

test("the newest priced match within 365 days is used; $0, old and non-ordinary lines are skipped with a reason", () => {
  const result = otherCustomerPrice({
    line,
    requestDate: "2026-09-24",
    chainPrice: 9.75,
    dbMatches: [
      match("BETA CORP", "2024-06-05", 8),
      match("GAMMA LLC", "2026-08-01", 0),
      match("DELTA INC", "2026-07-01", 7, { category: "returned-not-cleaned" }),
      match("EPSILON CO", "2026-03-01", 8),
      { bucket: "same-customer-exact", category: "ordinary", differences: [], record: { customer: "ACME", received: "2026-09-01", unitPrice: 12, wo: "1" } },
    ],
  });
  assert.equal(result.latest.customer, "EPSILON CO");
  assert.equal(result.latest.unitPrice, 8);
  assert.equal(result.all.length, 4);
  assert.deepEqual(result.all.filter((item) => !item.eligible).map((item) => item.why).sort(), ["no unit price (lot-priced or $0)", "not an ordinary line (returned-not-cleaned)", "older than 365 days"]);
});

test("a different level is labelled, not dropped; large lots and prices far under the calculator are flagged", () => {
  const scoped = otherCustomerPrice({ line, requestDate: "2026-09-24", chainPrice: 9.75, dbMatches: [match("BETA CORP", "2026-05-01", 8, { differences: ["level 100R1 vs VC"] })] });
  assert.deepEqual(scoped.latest.flags, ["different scope: level 100R1 vs VC"]);
  const cheap = otherCustomerPrice({ line, requestDate: "2026-09-24", chainPrice: 9.75, dbMatches: [match("BETA CORP", "2026-05-01", 3.5)] });
  assert.match(cheap.latest.flags[0], /well under the calculator/);
  const bigLot = otherCustomerPrice({ line, requestDate: "2026-09-24", chainPrice: 9.75, quotes: [{ date: "2026-04-15", customer: "beta.example", unitPrice: 4, quantity: 500, evidence: "sales@qpc.example → buyer@beta.example", differences: [] }] });
  assert.match(bigLot.latest.flags[0], /large-lot price: 500 pcs vs 40 requested/);
});

test("on the same day a work order leads a quote", () => {
  const result = otherCustomerPrice({ line, requestDate: "2026-09-24", dbMatches: [match("BETA CORP", "2026-05-01", 8)], quotes: [{ date: "2026-05-01", customer: "gamma.example", unitPrice: 9, quantity: 40, evidence: "q", differences: [] }] });
  assert.equal(result.latest.source, "work order");
});

test("another customer's price leads the calculator only when this customer has no PO or quote", () => {
  const otherCustomer = otherCustomerPrice({ line, requestDate: "2026-09-24", chainPrice: 9.75, dbMatches: [match("BETA CORP", "2026-05-01", 8)] });
  const chain = { settled: 9.75 };
  const led = recommend({ policyId: "repeat-accepted-hold-v0", line, requestDate: "2026-09-24", purchaseOrders: [], sentQuotes: [], chain, otherCustomer });
  assert.equal(led.preferred.unitPrice, 8);
  assert.match(led.preferred.basis, /^OTHER-CUSTOMER: BETA CORP; work order WO 0501WA; 2026-05-01;/);
  assert.equal(led.alternatives[0].unitPrice, 9.75);
  const quote = { date: "2026-09-01", unitPrice: 11, quantity: 40, evidence: "q", status: "comparable", differences: [] };
  const quoted = recommend({ policyId: "repeat-accepted-hold-v0", line, requestDate: "2026-09-24", purchaseOrders: [], sentQuotes: [quote], chain, otherCustomer });
  assert.equal(quoted.preferred.unitPrice, 11);
  assert.ok(quoted.alternatives.some((item) => item.basis.startsWith("OTHER-CUSTOMER")));
  const chainOnly = recommend({ policyId: "chain-only-v0", line, requestDate: "2026-09-24", purchaseOrders: [], sentQuotes: [], chain, otherCustomer });
  assert.equal(chainOnly.preferred.unitPrice, 9.75);
});

test("the board caption names the other customer and the date", () => {
  const source = priceSource({ basis: "OTHER-CUSTOMER: BETA CORP; work order WO 0501WA; 2026-05-01; quantity not recorded at $8.00; rule other-customer-hold-v1" });
  assert.equal(source.kind, "other");
  assert.equal(source.text, "BETA CORP work order of May 1, 2026 · other customer");
});

test("a decision lists other customers' work orders and QPC quotes to other customers for the part", () => {
  const world = buildWorld();
  const file = path.join(world.evidence, "messages.json");
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  evidence.messages.push({ id: "other-quote", from: "sales@qpc.example", to: ["buyer@beta.example"], cc: [], subject: "Quote", receivedAt: "2026-08-20T12:00:00Z", webLink: "https://mail.example/other", mailbox: "sales@qpc.example", bodyFormat: "text", attachments: [], body: "Thank you for your RFQ. Please see your estimated pricing below:\n\nP/N: ABC-100\nQty: 600\nUnit Price: $6.50\n\nLEVEL 300R4 NOT FOR OXYGEN SERVICE" });
  fs.writeFileSync(file, JSON.stringify(evidence));
  const decision = buildDecision(world.options);
  const l1 = decision.lines.find((item) => item.lineId === "L1");
  const candidates = l1.recommendation.otherCustomerCandidates;
  assert.ok(candidates.some((item) => item.source === "work order" && item.customer === "OTHER AEROSPACE INC" && item.unitPrice === 5 && item.eligible));
  assert.ok(candidates.some((item) => item.source === "QPC quote" && item.customer === "beta.example" && item.unitPrice === 6.5));
  assert.ok(l1.recommendation.preferred.basis.startsWith("REPEAT-ACCEPTED"), "this customer's own PO still leads");
  assert.ok(l1.recommendation.alternatives.some((item) => item.basis.startsWith("OTHER-CUSTOMER")));
  assert.ok(!l1.history.timeline.some((entry) => /OTHER AEROSPACE|beta\.example/.test(entry.evidence)), "other customers stay out of this customer's history");
  assert.ok(RULINGS.some((ruling) => ruling.id === "other-customer-hold-v1"));
});

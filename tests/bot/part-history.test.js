import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecord, compareScope, customerKey, isSameCustomer, matchLineHistory, partNumberMatch, revisionNear, scopeFlags, summarizeMatches } from "../../bot/lib/part-history.js";

test("part numbers match as whole tokens, formatting variants, aliases or partial tokens", () => {
  assert.equal(partNumberMatch("P/N: ABC-100 REV. B", "ABC-100").kind, "exact");
  assert.equal(partNumberMatch("Part Number : ABC - 100 Rev. B", "ABC-100").kind, "formatting-variant");
  assert.equal(partNumberMatch("RFQ-ABC100 Rev. B", "ABC-100").kind, "formatting-variant");
  assert.equal(partNumberMatch("RFQ ABC-1O0", "ABC-100", [{ value: "ABC-1O0", reason: "typo" }]).kind, "known-alias");
  assert.equal(partNumberMatch("P/N: ABC-100X", "ABC-100"), null);
  assert.equal(partNumberMatch("P/N: ABC100X", "ABC-100").kind, "partial-token");
  assert.equal(partNumberMatch("P/N: ABC-101", "ABC-100"), null);
});

test("revision is read next to the part number", () => {
  assert.equal(revisionNear("P/N: ABC-100 REV. B\nSEAL", "ABC-100"), "B");
  assert.equal(revisionNear("ABC-100 Rev.C qty 5", "ABC-100"), "C");
  assert.equal(revisionNear("Part Number : ABC - 100 Rev.   B", "ABC-100"), "B");
  assert.equal(revisionNear("ABC-100 qty 5", "ABC-100"), null);
});

test("oxygen-service wording is read with its negation", () => {
  assert.equal(scopeFlags("CLEAN PER CC1246 LEVEL 300R4 NOT FOR OXYGEN SERVICE").oxygen, "not-for");
  assert.equal(scopeFlags("CLEAN ... FOR OXYGEN SERVICE").oxygen, "for");
  assert.equal(scopeFlags("Without Oxygen Service and Aclar packaging").oxygen, "not-for");
  assert.equal(scopeFlags("the quote excluding oxygen service doesn't include aclar").oxygen, "not-for");
  assert.equal(scopeFlags("NOT FOR OXYGEN SERVICE; LOX line").oxygen, "conflict");
  assert.equal(scopeFlags("Without Oxygen Service and Aclar packaging").aclar, "excluded");
  assert.equal(scopeFlags("They need ACLAR packaging").aclar, "mentioned");
  assert.equal(scopeFlags("LEVEL 300 R 4").level, "300R4");
  assert.equal(scopeFlags("Level 100A").level, "100A");
  assert.equal(scopeFlags("LEVEL 300 NOT FOR OXYGEN SERVICE").level, "300");
});

test("returned, zero, blank and duplicate lines never count as ordinary prices", () => {
  const base = { duplicateMarked: false, priceStatus: "positive" };
  assert.equal(classifyRecord(base, scopeFlags("P/N: ABC-100\n**RETURN TO CUSTOMER**")).category, "returned-not-cleaned");
  assert.equal(classifyRecord(base, scopeFlags("P/N: ABC-100\nNOT CLEANED/RETURNED TO ACME")).category, "returned-not-cleaned");
  assert.equal(classifyRecord({ ...base, priceStatus: "zero" }, scopeFlags("")).category, "zero-price");
  assert.equal(classifyRecord({ ...base, priceStatus: "blank" }, scopeFlags("")).category, "blank-price");
  assert.equal(classifyRecord({ ...base, duplicateMarked: true }, scopeFlags("")).category, "duplicate-marked");
  assert.equal(classifyRecord(base, scopeFlags("P/N: ABC-100")).category, "ordinary");
});

test("customer identity ignores legal suffixes and punctuation only", () => {
  assert.equal(customerKey("Acme Precision Corp."), customerKey("ACME PRECISION CORP"));
  assert.ok(isSameCustomer("ACME PRECISION CORP", { name: "Acme Precision Corp.", aliases: [] }));
  assert.ok(!isSameCustomer("ACME PRECISION WEST", { name: "Acme Precision Corp.", aliases: [] }));
});

test("scope comparison separates stated differences from facts not stated", () => {
  const line = { revision: "B", scope: { oxygen: "not-for", level: "300R4" } };
  assert.deepEqual(compareScope(scopeFlags("LEVEL 300R4 NOT FOR OXYGEN SERVICE"), "B", line), { comparable: true, differences: [], unknown: [] });
  assert.equal(compareScope(scopeFlags("LEVEL 300R4 FOR OXYGEN SERVICE"), "B", line).comparable, false);
  assert.deepEqual(compareScope(scopeFlags("LEVEL 100 NOT FOR OXYGEN SERVICE"), "B", line).differences, ["level 100 vs 300R4"]);
  assert.deepEqual(compareScope(scopeFlags("LEVEL 300R4 NOT FOR OXYGEN SERVICE"), "C", line).differences, ["revision C vs B"]);
  assert.deepEqual(compareScope(scopeFlags("LEVEL 300R4"), null, line).unknown, ["revision not stated", "oxygen service not stated"]);
});

test("another customer's record for the same P/N is kept apart", () => {
  const record = (customer, description, special = "NOT FOR OXYGEN SERVICE") => ({ customer, description, process: "LEVEL 300R4", special, priceStatus: "positive", duplicateMarked: false });
  const records = [
    record("ACME PRECISION CORP", "P/N: ABC-100 REV. B"),
    record("OTHER AEROSPACE INC", "P/N: ABC-100 REV. B"),
    record("ACME PRECISION CORP", "P/N: ABC100X REV. B"),
    record("ACME PRECISION CORP", "P/N: ABC-100 REV. B", "FOR OXYGEN SERVICE"),
  ];
  const matches = matchLineHistory(records, { partNumber: "ABC-100", revision: "B", scope: { oxygen: "not-for", level: "300R4" } }, { name: "Acme Precision Corp.", aliases: [] });
  assert.deepEqual(matches.map((match) => match.bucket), ["same-customer-exact", "other-customer", "partial-token", "same-customer-exact"]);
  assert.deepEqual(matches.map((match) => match.comparable), [true, false, false, false]);
  assert.equal(summarizeMatches(matches).comparable, 1);
});

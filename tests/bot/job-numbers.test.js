import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadMessages } from "../../bot/lib/decision.js";
import { customerJobNumber, customerJobs, mentionsJob } from "../../bot/lib/job-numbers.js";
import { loadSnapshotRecords, normalizeRow } from "../../bot/lib/router-snapshot.js";
import { buildWorld, routerRow } from "./helpers.js";

test("customer job numbers are read in both forms the export uses", () => {
  assert.equal(customerJobNumber("P/N: ABC-100 REV. B\nWO NO: W1- 100"), "W1-100");
  assert.equal(customerJobNumber("P/N: ABC-100 REV. 02\nMANIFOLD\nJOB NO: 2786-1"), "2786-1");
  assert.equal(customerJobNumber("P/N: ABC-100 REV. 02\nJOB #: 12 - 3\n**RETURN**"), "12-3");
  assert.equal(customerJobNumber("P/N: ABC-100 REV. B"), null);
});

test("a job number is found through spaced hyphens but never inside a longer number", () => {
  assert.ok(mentionsJob("WO Number :W1- 100  CLEAN PER SPEC", "W1-100"));
  assert.ok(mentionsJob("PO1- 7 _ W1-100 _ QPC", "w1-100"));
  assert.ok(!mentionsJob("W1-1000 and W1-1001", "W1-100"));
  assert.ok(!mentionsJob("JOB NO: 12786-1", "2786-1"));
  assert.ok(!mentionsJob("JOB NO: 2786-10", "2786-1"));
});

test("each exact-part job is listed once per part, and jobs no saved message mentions are the next searches", () => {
  const world = buildWorld();
  const kase = JSON.parse(fs.readFileSync(world.casePath, "utf8"));
  const records = loadSnapshotRecords(world.store).records;
  const messages = loadMessages(`${world.evidence}/messages.json`);
  const parts = customerJobs({ records, lines: kase.lines, customer: kase.customer, messages });
  assert.deepEqual(parts.map((part) => part.lineIds), [["L1", "L2"], ["L3"]]);
  const [abc, def] = parts;
  assert.deepEqual(abc.jobs.map((job) => job.job), ["W1-100", "W1-080", "W1-070", "W1-090", "W1-060"]);
  const job100 = abc.jobs[0];
  assert.deepEqual(job100.workOrders.map((order) => order.category).sort(), ["ordinary", "returned-not-cleaned"]);
  assert.deepEqual(job100.mentionedIn.map((message) => message.id), ["po"]);
  assert.deepEqual(abc.searchNext, ["W1-080", "W1-070", "W1-090", "W1-060"]);
  assert.equal(def.jobs.length, 0);
  assert.deepEqual(def.searchNext, []);
});

test("another customer's jobs never appear and exact-part records without a job number are counted", () => {
  const customer = { name: "Acme Precision Corp", aliases: [] };
  const line = { lineId: "L1", partNumber: "ABC-100", aliases: [], scope: {} };
  const records = [
    routerRow({ wo: "1WA", description: "P/N: ABC-100 REV. B\nJOB NO: 55-1" }),
    routerRow({ wo: "2WA", description: "P/N: ABC-100 REV. B" }),
    routerRow({ wo: "3WA", customer: "OTHER AEROSPACE INC", description: "P/N: ABC-100 REV. B\nJOB NO: 77-1" }),
  ].map((row, index) => normalizeRow(row, index + 2));
  const [result] = customerJobs({ records, lines: [line], customer });
  assert.deepEqual(result.jobs.map((job) => job.job), ["55-1"]);
  assert.equal(result.recordsWithoutJobNumber, 1);
  assert.deepEqual(result.searchNext, ["55-1"]);
});

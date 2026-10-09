import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { monitorCovers, monitorLink, triageGroup } from "../../bot/lib/board.js";
import { buildDecision, GAPS_NOT_RECORDED } from "../../bot/lib/decision.js";
import { refreshPages } from "../../bot/lib/pages.js";
import { renderHtml, renderMarkdown } from "../../bot/lib/render.js";
import { buildWorld, tempDir } from "./helpers.js";

test("a record saved without email gaps still renders, and says the gaps were not recorded", () => {
  const decision = buildDecision(buildWorld().options);
  delete decision.freshness.email.gaps;
  assert.ok(renderMarkdown(decision).includes(GAPS_NOT_RECORDED));
  assert.ok(renderHtml(decision).includes(GAPS_NOT_RECORDED));
});

test("one page that cannot render is reported and skipped; the rest still refresh", () => {
  const world = buildWorld();
  const outputsDir = tempDir();
  const good = buildDecision(world.options);
  fs.writeFileSync(path.join(outputsDir, `CLAUDE-DECISION-${good.caseId}-v1.json`), JSON.stringify(good));
  fs.writeFileSync(path.join(outputsDir, "CLAUDE-DECISION-BROKEN-v1.json"), JSON.stringify({ caseId: "BROKEN" }));
  const failures = [];
  const board = { cases: [{ caseId: "BROKEN", version: 1, page: "broken" }, { caseId: good.caseId, version: 1, page: "good" }] };
  const updated = refreshPages({ outputsDir, board, failures });
  assert.deepEqual(updated, ["good"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].caseId, "BROKEN");
});

test("a stale monitor entry does not hide a newer mail-check message", () => {
  const entry = { priority_section: 1, last_observed_activity_at: "2026-10-08T19:54:07Z" };
  assert.equal(monitorCovers(entry, { at: "2026-10-08T19:00:00Z" }), true, "a message the monitor has seen is covered");
  assert.equal(monitorCovers(entry, { at: "2026-10-08T22:33:47Z" }), false, "a reply after the monitor's last look is not");
  assert.equal(monitorCovers({ priority_section: 1 }, { at: "2026-10-08T22:33:47Z" }), true, "an entry with no activity time keeps the old rule");
});

test("a case naming an email subject as its monitor reference still links by part and source email", () => {
  const decision = { customer: { name: "Acme Corporation", aliases: ["ACME"] }, rfq: { reference: "Request for quote", monitorReference: "Request for quote", sourceMessageIds: ["<abc@mail.example>"] }, lines: [{ request: { partNumber: "ABC-100", aliases: [] } }] };
  const entry = { customer: "Acme", reference: "October9 RFQ / ABC-100", evidence_ids: ["AAMk_item1"] };
  assert.equal(monitorLink(decision, [entry]).entry, null, "without the id map the emails do not agree");
  assert.equal(monitorLink(decision, [entry], new Map([["<abc@mail.example>", "AAMk_item1"]])).entry, entry, "the mail check's item id joins the two");
  assert.equal(monitorLink(decision, [entry], new Map([["<abc@mail.example>", "AAMk+item1"]])).entry, entry, "the monitor's id spelling is accepted");
});

test("a price request blocked on a missing fact is not filed as paperwork", () => {
  assert.equal(triageGroup("price request for 003-236-3746 but quantity is in an unreadable .xls; Tyler to open the sheet (2026-10-09)"), "Price request, needs facts");
  assert.equal(triageGroup("details behind Silkline portal, unreadable; needs facts (2026-10-08)"), "Price request, needs facts");
  assert.equal(triageGroup("shipping/FedEx account confirmation on a PO, not a price request (2026-10-09)"), "Paperwork, not pricing");
});

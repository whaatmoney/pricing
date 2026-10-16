import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildDecision } from "../../bot/lib/decision.js";
import { refreshPages, writePage } from "../../bot/lib/pages.js";
import { renderHtml, renderMarkdown } from "../../bot/lib/render.js";
import { buildWorld, tempDir } from "./helpers.js";

// The search log is hand-written by a pricing helper. On 2026-10-15 three logs
// left out `gaps`; the records were written and then every page render, and so
// every board rebuild, died on `gaps.map`. These tests keep that from coming back.

const world = buildWorld();

function decisionWithSearchLog(searchLog) {
  fs.writeFileSync(path.join(world.evidence, "search-log.json"), JSON.stringify(searchLog));
  const decision = buildDecision(world.options);
  decision.lifecycle.recommendationVersion = 1;
  return decision;
}

test("a search log without gaps, with bare search entries, still builds and renders", () => {
  const decision = decisionWithSearchLog({ searchedAt: "2026-10-15T23:30:00Z", searches: [{ mailbox: "sales@qpc.example", query: "ABC-100", results: 2, complete: true }, { results: 0 }] });
  assert.deepEqual(decision.freshness.email.gaps, []);
  assert.equal(decision.freshness.email.searches.length, 2);
  const html = renderHtml(decision);
  assert.match(html, /None recorded in the search log/);
  assert.match(html, /sales@qpc\.example “ABC-100” 2; 0 \(partial\)\./);
  assert.ok(!html.includes("undefined"));
  const markdown = renderMarkdown(decision);
  assert.match(markdown, /- None recorded in the search log\./);
  assert.ok(!markdown.includes("undefined"));
});

test("a search log with no searches list at all still builds and says so", () => {
  const decision = decisionWithSearchLog({ gaps: ["jaydino@qpc.example not searched"] });
  assert.deepEqual(decision.freshness.email.searches, []);
  assert.equal(decision.freshness.email.searchedAt, null);
  const html = renderHtml(decision);
  assert.match(html, /\(time not recorded\): no searches recorded\./);
  assert.match(html, /jaydino@qpc\.example not searched/);
});

test("a record already saved without gaps renders rather than failing the page", () => {
  const decision = decisionWithSearchLog({ searchedAt: "2026-10-15T23:30:00Z", searches: [], gaps: ["x"] });
  delete decision.freshness.email.gaps;
  delete decision.freshness.email.searches;
  assert.match(renderHtml(decision), /None recorded in the search log/);
  assert.match(renderMarkdown(decision), /no searches recorded/);
});

test("one record that will not render is reported and the other pages still refresh", () => {
  const outputsDir = tempDir("qpc-pages-");
  const good = decisionWithSearchLog({ searchedAt: "2026-10-15T23:30:00Z", searches: [], gaps: [] });
  fs.writeFileSync(path.join(outputsDir, "CLAUDE-DECISION-TEST-ABC-100-v1.json"), JSON.stringify(good));
  fs.writeFileSync(path.join(outputsDir, "CLAUDE-DECISION-BROKEN-1-v1.json"), JSON.stringify({ caseId: "BROKEN-1", lines: null }));
  const board = { cases: [
    { caseId: "BROKEN-1", version: 1, page: "CLAUDE-DECISION-BROKEN-1-v1.html" },
    { caseId: "TEST-ABC-100", version: 1, page: "CLAUDE-DECISION-TEST-ABC-100-v1.html" },
  ] };
  const result = refreshPages({ outputsDir, board });
  assert.deepEqual(result.updated, ["CLAUDE-DECISION-TEST-ABC-100-v1.html"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].caseId, "BROKEN-1");
  assert.ok(result.failed[0].message);
  assert.ok(fs.existsSync(path.join(outputsDir, "CLAUDE-DECISION-TEST-ABC-100-v1.html")));
  assert.ok(!fs.existsSync(path.join(outputsDir, "CLAUDE-DECISION-BROKEN-1-v1.html")));
  // A second pass changes nothing and still reports the same failure.
  const again = refreshPages({ outputsDir, board });
  assert.deepEqual(again.updated, []);
  assert.equal(again.failed.length, 1);
  assert.equal(writePage({ outputsDir, caseId: "TEST-ABC-100", version: 1, markdown: false }).changed, false);
});

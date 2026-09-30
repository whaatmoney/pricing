#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyAnswer } from "./lib/answer.js";
import { boardInputs, mirrorPages, writeBoard } from "./lib/board.js";
import { readLastSync, runSync, startPublish } from "./lib/sync.js";
import { buildDecision, loadMessages } from "./lib/decision.js";
import { customerJobs } from "./lib/job-numbers.js";
import { lifecyclePath, lifecycleView, readLifecycle, recordDecision } from "./lib/lifecycle.js";
import { readSentQuote, sentQuoteNote } from "./lib/sent-quote.js";
import { refreshPages, writePage } from "./lib/pages.js";
import { DEFAULT_LIMITS, importSnapshot, listExports, loadSnapshotRecords, snapshotStatus } from "./lib/router-snapshot.js";
import { nextVersion, versionsOf } from "./lib/versioning.js";

// QPC first-pass pricing bot. Paths come from a private config file so no
// company location, export or evidence is committed with the code:
//   QPC_BOT_CONFIG=/path/config.json node bot/cli.js <command>
// or bot/config.local.json (git-ignored). See bot/README.md.

const USAGE = `Usage:
  node bot/cli.js status                 Router History snapshot age and unimported exports
  node bot/cli.js import [file.xlsx]     Validate and import the newest (or given) weekly export
  node bot/cli.js import-all             Import every export in the folder, oldest first
  node bot/cli.js from-sent CASE --email sent.json [--dry-run]
                                         Record the reviewer's sent quote email as their decision
  node bot/cli.js mail-scorecard [--since ISO] [--until ISO]
                                         The Claude-alongside-Codex mail check trial in numbers
  node bot/cli.js mail-placement [--since ISO] [--ids a,b]
                                         Where each message Claude's mail check kept lands on the board
  node bot/cli.js decide <case.json>     Build the decision record (JSON, Markdown, HTML)
  node bot/cli.js approve <case.json|case id> --version N [--line L1]
        --choice approved|alternative|correction [--price 8.50] --by NAME
        [--at ISO-TIME] [--note TEXT] [--rule approved|rejected]
                                         Record a person's decision as a separate lifecycle
                                         entry and re-render that version's page
  node bot/cli.js answer --by NAME "<answer line>"
                                         Record a reviewer's pasted answer line exactly as given
                                         (see bot/lib/answer.js for the forms it accepts)
  node bot/cli.js render <case.json|case id> [--version N]
                                         Redraw a saved version's page (the record is not rebuilt)
  node bot/cli.js sync [--trigger NAME]  Import any new Router History export and rebuild the board
                                         (what the background job runs; safe to repeat)
  node bot/cli.js board                  Rewrite the open-decisions page
  node bot/cli.js jobs <case.json>       The customer's job numbers for each line, from Router
                                         History, and which ones the saved evidence mentions`;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function loadConfig() {
  const candidates = [process.env.QPC_BOT_CONFIG, new URL("./config.local.json", import.meta.url).pathname].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error("No config found. Set QPC_BOT_CONFIG or create bot/config.local.json (see bot/README.md).");
  return readJson(file);
}

function printImport(result) {
  const line = `${result.outcome.padEnd(15)} ${result.fileName}  sha256 ${result.sha256.slice(0, 12)}`;
  console.log(line);
  for (const failure of result.failures || []) console.log(`  ✗ ${failure.code}: ${typeof failure.detail === "string" ? failure.detail : JSON.stringify(failure.detail)}`);
  for (const warning of result.warnings || []) console.log(`  ! ${warning.code}: ${warning.detail}`);
  if (result.summary) console.log(`  rows ${result.summary.rows}, received ${result.summary.receivedMin}…${result.summary.receivedMax}, blank dates ${result.summary.blankDates}, repeated occurrences ${result.summary.repeatedSharedOccurrences}`);
}

// The quote text follows the reviewer's own RFQ response template, kept in
// private config (config.quoteTemplate) because it carries company terms.
const readQuoteTemplate = (config) => (config.quoteTemplate ? fs.readFileSync(config.quoteTemplate, "utf8") : null);
function renderVersion(config, caseId, version) {
  return writePage({ outputsDir: config.outputsDir, caseId, version, quoteTemplate: readQuoteTemplate(config) }).base;
}

function refreshBoard(config) {
  const { file, board } = writeBoard({ ...boardInputs(config), lastSync: readLastSync(config) });
  refreshPages({ outputsDir: config.outputsDir, board, quoteTemplate: readQuoteTemplate(config) });
  let mirrored = "";
  if (config.pagesMirror) {
    try {
      const mirror = mirrorPages({ outputsDir: config.outputsDir, mirrorDir: config.pagesMirror, board });
      mirrored = `; copy in ${config.pagesMirror}: ${mirror.copied.length} updated, ${mirror.removed.length} removed${startPublish(config) ? "; publishing online in the background" : ""}`;
    } catch (error) {
      mirrored = `; COPY FAILED (${error.message}), the board itself is fine`;
    }
  }
  return `${file} (${board.cases.filter((kase) => kase.open).length} waiting)${mirrored}`;
}

const cents = (value) => Math.round(Number(value) * 100);
const money = (value) => `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  const config = loadConfig();
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };

  if (command === "status") {
    console.log(JSON.stringify(snapshotStatus(config.storeDir, { folder: config.routerHistoryFolder, limits }), null, 2));
    return;
  }
  if (command === "import") {
    const file = argument || listExports(config.routerHistoryFolder).pop()?.path;
    if (!file) throw new Error(`No LineItems_with_RouterHistory export found in ${config.routerHistoryFolder}`);
    printImport(importSnapshot(file, { storeDir: config.storeDir, limits }));
    return;
  }
  if (command === "import-all") {
    for (const item of listExports(config.routerHistoryFolder)) printImport(importSnapshot(item.path, { storeDir: config.storeDir, limits }));
    return;
  }
  if (command === "decide") {
    if (!argument) throw new Error("decide needs a case file path");
    const decision = buildDecision({
      casePath: path.resolve(argument),
      storeDir: config.storeDir,
      routerFolder: config.routerHistoryFolder,
      salesExportPath: config.salesExport,
      priceLabDir: config.priceLabDir,
      calculatorHtml: config.calculatorHtml,
      monitorStatePath: config.monitorState,
    });
    const stem = `CLAUDE-DECISION-${decision.caseId}`;
    const { version, reused, supersedes } = nextVersion(config.outputsDir, stem, decision.inputsFingerprint);
    decision.lifecycle.recommendationVersion = version;
    decision.lifecycle.supersedes = supersedes;
    const base = path.join(config.outputsDir, `${stem}-v${version}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(decision, null, 2));
    renderVersion(config, decision.caseId, version);
    console.log(`${reused ? "Rewrote" : "Wrote"} recommendation v${version}${supersedes ? ` (supersedes v${supersedes})` : ""}:\n  ${base}.json\n  ${base}.md\n  ${base}.html\nBoard: ${refreshBoard(config)}`);
    for (const line of decision.lines) {
      const preferred = line.recommendation.preferred;
      console.log(`  ${line.lineId} ${line.request.partNumber} x ${line.request.quantity}: ${preferred ? `$${preferred.unitPrice.toFixed(2)} (${preferred.label})` : "uncalculated"}`);
    }
    return;
  }
  if (command === "approve") {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(3),
      allowPositionals: true,
      options: { version: { type: "string" }, line: { type: "string" }, choice: { type: "string" }, price: { type: "string" }, by: { type: "string" }, at: { type: "string" }, note: { type: "string" }, rule: { type: "string" } },
    });
    const target = positionals[0];
    if (!target) throw new Error("approve needs the case file or case id");
    const caseId = target.endsWith(".json") ? readJson(path.resolve(target)).caseId : target;
    const version = Number(values.version);
    if (!Number.isInteger(version) || version < 1) throw new Error("approve needs --version N: the recommendation version the person reviewed");
    const { entry, file, notices } = recordDecision({
      outputsDir: config.outputsDir,
      caseId,
      version,
      lineId: values.line,
      choice: values.choice,
      unitPrice: values.price == null ? null : Number(values.price.replace(/^\$/, "")),
      decidedBy: values.by,
      decidedAt: values.at,
      note: values.note,
      policyRuling: values.rule,
      approvers: config.approvers,
    });
    const base = renderVersion(config, caseId, version);
    console.log(`Recorded decision #${entry.id} on ${caseId} v${entry.version} ${entry.lineId}: ${entry.choice}${entry.unitPrice != null ? ` ${money(entry.unitPrice)}/ea (${money(entry.extended)} for ${entry.quantity})` : ""} by ${entry.decidedBy}.`);
    for (const notice of notices) console.log(`  ! ${notice}`);
    console.log(`  ${file}\nRe-rendered:\n  ${base}.md\n  ${base}.html\nBoard: ${refreshBoard(config)}`);
    return;
  }
  if (command === "from-sent") {
    // The reviewer's sent quote email is the decision (see lib/sent-quote.js).
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: { email: { type: "string" }, "dry-run": { type: "boolean" } } });
    const target = positionals[0];
    if (!target || !values.email) throw new Error("from-sent needs the case file or case id and --email sent-quote.json");
    const caseId = target.endsWith(".json") ? readJson(path.resolve(target)).caseId : target;
    const version = versionsOf(config.outputsDir, `CLAUDE-DECISION-${caseId}`)[0];
    if (!version) throw new Error(`No recommendation for ${caseId} in ${config.outputsDir}`);
    const decision = readJson(path.join(config.outputsDir, `CLAUDE-DECISION-${caseId}-v${version}.json`));
    const email = readJson(path.resolve(values.email));
    const read = readSentQuote({ decision, email, approverAddresses: config.approverAddresses || {} });
    if (!read.ok) throw new Error(`Not recorded: ${read.problems.join("; ")}.`);
    const view = lifecycleView(decision, readLifecycle(lifecyclePath(config.outputsDir, caseId), caseId));
    let recorded = 0;
    for (const line of read.lines) {
      if (!line.found) { console.log(`  ${line.lineId} ${line.partNumber} x ${line.quantity}: left open (${line.reason})`); continue; }
      const current = view.current.get(line.lineId);
      if (current && current.choice !== "correction" && cents(current.unitPrice) === cents(line.unitPrice)) { console.log(`  ${line.lineId}: already recorded at ${money(line.unitPrice)}`); continue; }
      const { entry, notices } = recordDecision({
        outputsDir: config.outputsDir, caseId, version, lineId: line.lineId, choice: line.choice, unitPrice: line.unitPrice,
        decidedBy: read.decidedBy, decidedAt: read.decidedAt, note: sentQuoteNote(email, line.words), approvers: config.approvers, dryRun: Boolean(values["dry-run"]),
      });
      recorded += 1;
      console.log(`  ${line.lineId} ${line.partNumber} x ${line.quantity}: ${entry.choice} ${money(entry.unitPrice)} by ${entry.decidedBy}${values["dry-run"] ? " (dry run, not written)" : ` (#${entry.id})`}`);
      for (const notice of notices) console.log(`    ! ${notice}`);
    }
    if (recorded && !values["dry-run"]) console.log(`Re-rendered: ${renderVersion(config, caseId, version)}.html\nBoard: ${refreshBoard(config)}`);
    return;
  }
  if (command === "answer") {
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: { by: { type: "string" }, at: { type: "string" } } });
    const text = positionals.join(" ").trim();
    if (!text) throw new Error("answer needs the reviewer's answer line in quotes");
    const { answer, results } = applyAnswer({ text, outputsDir: config.outputsDir, decidedBy: values.by, decidedAt: values.at, approvers: config.approvers });
    for (const { entry, notices } of results) {
      const what = entry.type === "method-review"
        ? `method ${entry.verdict}${entry.field ? ` (${entry.field})` : ""}`
        : `${entry.choice}${entry.unitPrice != null ? ` ${money(entry.unitPrice)}/ea (${money(entry.extended)} for ${entry.quantity})` : ""}`;
      console.log(`Recorded #${entry.id} ${entry.lineId} v${entry.version}: ${what} by ${entry.decidedBy}.`);
      for (const notice of notices) console.log(`  ! ${notice}`);
    }
    console.log(`Re-rendered: ${renderVersion(config, answer.caseId, answer.version)}.html\nBoard: ${refreshBoard(config)}`);
    return;
  }
  if (command === "render") {
    const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: { version: { type: "string" } } });
    const target = positionals[0];
    if (!target) throw new Error("render needs the case file or case id");
    const caseId = target.endsWith(".json") ? readJson(path.resolve(target)).caseId : target;
    const version = values.version ? Number(values.version) : versionsOf(config.outputsDir, `CLAUDE-DECISION-${caseId}`)[0];
    if (!version) throw new Error(`No recommendation for ${caseId} in ${config.outputsDir}`);
    console.log(`Re-rendered v${version} (record unchanged): ${renderVersion(config, caseId, version)}.html\nBoard: ${refreshBoard(config)}`);
    return;
  }
  if (command === "sync") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { trigger: { type: "string" } } });
    const record = runSync({ config, limits, trigger: values.trigger || "manual" });
    console.log(`${record.at} sync (${record.trigger}): ${record.imports.length ? record.imports.map((item) => `${item.fileName} ${item.outcome}${item.failures.length ? ` [${item.failures.join(", ")}]` : ""}`).join("; ") : "no new Router History export"}; board ${record.board ? `${record.board.waiting} waiting, ${record.board.withoutPage ?? "?"} unanswered RFQs without a page, mail checked ${record.board.monitorCutoff} (Codex) / ${record.board.claudeCutoff ?? "none"} (Claude), ${record.board.mailFound} found by Claude's check` : "not written"}${record.errors.length ? `; ERRORS: ${record.errors.join("; ")}` : ""}`);
    if (record.errors.length) process.exitCode = 1;
    return;
  }
  if (command === "board") {
    console.log(`Board: ${refreshBoard(config)}`);
    return;
  }
  if (command === "mail-scorecard") {
    // The Claude-alongside-Codex trial in numbers (review date 2026-10-07). Read-only.
    const { values } = parseArgs({ args: process.argv.slice(3), options: { since: { type: "string" }, until: { type: "string" } } });
    const { readClaudeMail, mailScorecard } = await import("./lib/claude-mail.js");
    const mail = readClaudeMail(config.claudeMail);
    if (!mail) throw new Error("config.claudeMail is not set or has no store yet");
    const queue = fs.existsSync(config.monitorState) ? JSON.parse(fs.readFileSync(config.monitorState, "utf8")).operational_queue || [] : [];
    const card = mailScorecard({ runs: mail.runs, events: mail.events, queue, since: values.since || "2026-09-30T07:00:00Z", until: values.until || new Date().toISOString() });
    console.log(`Claude mail check, ${card.since.slice(0, 10)} to ${card.until.slice(0, 10)}`);
    console.log(`Runs logged: ${card.runs}. Per weekday: ${card.perDay.map((day) => `${day.day} ${day.runs}/${day.expected}`).join(", ") || "none"}.`);
    console.log(`Gaps over 2 hours within a day: ${card.gaps.length ? card.gaps.map((gap) => `${gap.from.slice(0, 16)} to ${gap.to.slice(0, 16)} (${gap.minutes} min)`).join("; ") : "none"}.`);
    console.log(`Runs with a failed source (cutoff held): ${card.failedRuns}.`);
    console.log(`Messages kept: ${card.kept}. Requests, chases and quotes the Codex monitor had no entry for: ${card.claudeOnly.length}.`);
    for (const event of card.claudeOnly) console.log(`  - ${event.at.slice(0, 16)} ${event.kind} ${event.customerDomain}: ${event.subject}`);
    console.log(`Outside mail skipped: ${card.skipped}${card.skipped ? ` (${Object.entries(card.skippedBy).map(([reason, n]) => `${n} ${reason}`).join(", ")})` : ""}. Sample some to check nothing was missed.`);
    console.log("Cost per run is not logged here: see each run's session usage.");
    return;
  }
  if (command === "mail-placement") {
    // Where each message Claude's mail check kept lands on the board. Run
    // after a mail check: any "NOT SHOWN" line is a message nobody will see.
    const { values } = parseArgs({ args: process.argv.slice(3), options: { since: { type: "string" }, ids: { type: "string" } } });
    const { board } = writeBoard({ ...boardInputs(config), lastSync: readLastSync(config) });
    const ids = values.ids ? new Set(values.ids.split(",")) : null;
    const since = values.since ? Date.parse(values.since) : null;
    const shown = new Set(["case", "listed", "answered", "found", "sent-mark", "by-design", "old"]);
    const rows = (board.mailPlacements || []).filter(({ event }) => (!ids || ids.has(event.id)) && (!since || Date.parse(event.at) >= since));
    for (const { event, place, detail } of rows.sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at))) {
      const flag = place === "unattached" ? "NOTE" : !shown.has(place) ? "NOT SHOWN" : "ok";
      console.log(`${flag.padEnd(9)} ${event.at.slice(0, 16)} ${event.kind.padEnd(10)} ${String(event.customerDomain || "-").padEnd(26)} ${place}: ${detail}  | ${event.subject}`);
    }
    const missing = rows.filter(({ place }) => !shown.has(place) && place !== "unattached").length;
    console.log(`${rows.length} message(s); ${missing ? `${missing} NOT SHOWN` : "every request and chase is on the board"}.`);
    if (missing) process.exitCode = 1;
    return;
  }
  if (command === "jobs") {
    if (!argument) throw new Error("jobs needs a case file path");
    const casePath = path.resolve(argument);
    const kase = readJson(casePath);
    const messagesPath = path.resolve(path.dirname(casePath), kase.evidence.messages);
    const messages = fs.existsSync(messagesPath) ? loadMessages(messagesPath) : [];
    const snapshot = loadSnapshotRecords(config.storeDir);
    console.log(`Router History ${snapshot.meta.fileName}; ${messages.length} saved evidence messages${fs.existsSync(messagesPath) ? "" : " (no evidence file yet)"}.`);
    for (const part of customerJobs({ records: snapshot.records, lines: kase.lines, customer: kase.customer, messages })) {
      console.log(`\n${part.lineIds.join(", ")} ${part.partNumber}: ${part.jobs.length} customer job number(s)${part.recordsWithoutJobNumber ? `; ${part.recordsWithoutJobNumber} exact-part record(s) carry none` : ""}`);
      for (const job of part.jobs) {
        const orders = job.workOrders.map((order) => `WO ${order.wo} ${order.unitPrice == null ? "no price" : money(order.unitPrice)}${order.category !== "ordinary" ? ` (${order.category})` : ""}`).join(", ");
        const evidence = job.mentionedIn.length ? `in evidence: ${job.mentionedIn.map((message) => `${message.receivedAt?.slice(0, 10)} "${message.subject}"`).join("; ")}` : "NOT IN EVIDENCE";
        console.log(`  ${job.job.padEnd(10)} ${job.firstReceived || "no date   "}  ${orders}  ${evidence}`);
      }
      if (!part.jobs.length) console.log("  No work order for this customer and part carries a job number; search by part number only.");
      else console.log(part.searchNext.length ? `  Search next, in every mailbox the case covers: ${part.searchNext.map((job) => `"${job}"`).join(", ")}` : "  Every job number is already mentioned in the saved evidence.");
    }
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

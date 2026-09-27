#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildDecision } from "./lib/decision.js";
import { renderHtml, renderMarkdown } from "./lib/render.js";
import { DEFAULT_LIMITS, importSnapshot, listExports, snapshotStatus } from "./lib/router-snapshot.js";
import { nextVersion } from "./lib/versioning.js";

// QPC first-pass pricing bot. Paths come from a private config file so no
// company location, export or evidence is committed with the code:
//   QPC_BOT_CONFIG=/path/config.json node bot/cli.js <command>
// or bot/config.local.json (git-ignored). See bot/README.md.

const USAGE = `Usage:
  node bot/cli.js status                 Router History snapshot age and unimported exports
  node bot/cli.js import [file.xlsx]     Validate and import the newest (or given) weekly export
  node bot/cli.js import-all             Import every export in the folder, oldest first
  node bot/cli.js decide <case.json>     Build the decision record (JSON, Markdown, HTML)`;

function loadConfig() {
  const candidates = [process.env.QPC_BOT_CONFIG, new URL("./config.local.json", import.meta.url).pathname].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error("No config found. Set QPC_BOT_CONFIG or create bot/config.local.json (see bot/README.md).");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function printImport(result) {
  const line = `${result.outcome.padEnd(15)} ${result.fileName}  sha256 ${result.sha256.slice(0, 12)}`;
  console.log(line);
  for (const failure of result.failures || []) console.log(`  ✗ ${failure.code}: ${typeof failure.detail === "string" ? failure.detail : JSON.stringify(failure.detail)}`);
  for (const warning of result.warnings || []) console.log(`  ! ${warning.code}: ${warning.detail}`);
  if (result.summary) console.log(`  rows ${result.summary.rows}, received ${result.summary.receivedMin}…${result.summary.receivedMax}, blank dates ${result.summary.blankDates}, repeated occurrences ${result.summary.repeatedSharedOccurrences}`);
}

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
    fs.writeFileSync(`${base}.md`, renderMarkdown(decision));
    fs.writeFileSync(`${base}.html`, renderHtml(decision));
    console.log(`${reused ? "Rewrote" : "Wrote"} recommendation v${version}${supersedes ? ` (supersedes v${supersedes})` : ""}:\n  ${base}.json\n  ${base}.md\n  ${base}.html`);
    for (const line of decision.lines) {
      const preferred = line.recommendation.preferred;
      console.log(`  ${line.lineId} ${line.request.partNumber} x ${line.request.quantity}: ${preferred ? `$${preferred.unitPrice.toFixed(2)} (${preferred.label})` : "uncalculated"}`);
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

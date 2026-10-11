import fs from "node:fs";
import path from "node:path";
import { lifecyclePath, readLifecycle } from "./lifecycle.js";
import { readNotes } from "./notes.js";
import { renderHtml, renderMarkdown } from "./render.js";

// Pages are rendered from the saved record plus its lifecycle file, so a
// recorded decision shows without rebuilding (or changing) the record itself.
// `mail` carries the board's links to the RFQ email and the newest message in
// its thread, `progress` the board's RFQ in -> Priced -> Decided -> Sent steps,
// and `feedback` (config.feedback) the notes file and the address notes go to; the HTML is rewritten only when its text actually changes.
export function writePage({ outputsDir, caseId, version, quoteTemplate = null, mail = null, progress = null, feedback = null, now = new Date(), markdown = true }) {
  const base = path.join(outputsDir, `CLAUDE-DECISION-${caseId}-v${version}`);
  const decision = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
  const lifecycle = readLifecycle(lifecyclePath(outputsDir, caseId), caseId);
  if (markdown) fs.writeFileSync(`${base}.md`, renderMarkdown(decision, { lifecycle, quoteTemplate }));
  const html = renderHtml(decision, { lifecycle, quoteTemplate, mail, progress, now, feedback, notes: readNotes(feedback?.file, caseId) });
  const file = `${base}.html`;
  const changed = !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== html;
  if (changed) fs.writeFileSync(file, html);
  return { base, changed };
}

// Redraws every page on the board with its current email links, so "Latest
// reply" follows the monitor. Never touches a record or its version.
export function refreshPages({ outputsDir, board, quoteTemplate = null, feedback = null, now = new Date() }) {
  const updated = [];
  for (const kase of board.cases) {
    const { changed } = writePage({ outputsDir, caseId: kase.caseId, version: kase.version, quoteTemplate, mail: { rfq: kase.rfqLink || null, rfqOwner: kase.rfqOwner || null, latest: kase.latestLink || null, files: kase.files || null }, progress: kase.progress, feedback, now, markdown: false });
    if (changed) updated.push(kase.page);
  }
  return updated;
}

import fs from "node:fs";
import path from "node:path";
import { lifecyclePath, readLifecycle } from "./lifecycle.js";
import { renderHtml, renderMarkdown } from "./render.js";

// Pages are rendered from the saved record plus its lifecycle file, so a
// recorded decision shows without rebuilding (or changing) the record itself.
// `mail` carries the board's links to the RFQ email and the newest message in
// its thread, and `progress` the board's RFQ in -> Priced -> Decided -> Sent steps; the HTML is rewritten only when its text actually changes.
export function writePage({ outputsDir, caseId, version, quoteTemplate = null, mail = null, progress = null, now = new Date(), markdown = true }) {
  const base = path.join(outputsDir, `CLAUDE-DECISION-${caseId}-v${version}`);
  const decision = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
  const lifecycle = readLifecycle(lifecyclePath(outputsDir, caseId), caseId);
  if (markdown) fs.writeFileSync(`${base}.md`, renderMarkdown(decision, { lifecycle, quoteTemplate }));
  const html = renderHtml(decision, { lifecycle, quoteTemplate, mail, progress, now });
  const file = `${base}.html`;
  const changed = !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== html;
  if (changed) fs.writeFileSync(file, html);
  return { base, changed };
}

// Redraws every page on the board with its current email links, so "Latest
// reply" follows the monitor. Never touches a record or its version. One page
// that will not render is reported in `failed` and the rest still refresh: a
// bad record must not stop the board (the 2026-10-15 run left three records
// without a gaps list and every board rebuild died until they were fixed).
export function refreshPages({ outputsDir, board, quoteTemplate = null, now = new Date() }) {
  const updated = [];
  const failed = [];
  for (const kase of board.cases) {
    try {
      const { changed } = writePage({ outputsDir, caseId: kase.caseId, version: kase.version, quoteTemplate, mail: { rfq: kase.rfqLink || null, rfqOwner: kase.rfqOwner || null, latest: kase.latestLink || null, files: kase.files || null }, progress: kase.progress, now, markdown: false });
      if (changed) updated.push(kase.page);
    } catch (error) {
      failed.push({ caseId: kase.caseId, version: kase.version, page: kase.page, message: error.message });
    }
  }
  return { updated, failed };
}

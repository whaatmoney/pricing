import fs from "node:fs";
import path from "node:path";
import { caseConfidence, reasonsText } from "./confidence.js";
import { lifecyclePath, lifecycleView, readLifecycle } from "./lifecycle.js";
import { isSameCustomer, partNumberMatch } from "./part-history.js";
import { copyButton, ICON, SCRIPT, STYLE } from "./design.js";
import { displayStatus, escapeHtml } from "./render.js";
import { readManifest } from "./router-snapshot.js";
import { priceSource } from "./review-card.js";

// The pricing front door. One page joins the mail monitor's view of every RFQ
// with the pricing side's work on it: which RFQs have a decision page, what
// was decided, whether the monitor has since seen the quote go out, how long
// customers have waited, method feedback, and every unanswered RFQ still
// without a page. Reads only; the monitor state belongs to its own scheduler
// and is never written.

export const BOARD_FILE = "CLAUDE-DECISIONS-OPEN.html";
// Matches the monitor's own stale threshold. Past this, mail data on the
// board is marked STALE whatever the monitor's file says, because a stopped
// monitor never updates its own stale flag.
export const MONITOR_STALE_MINUTES = 120;
// The page also checks its own age when opened: a board not rebuilt within
// this window means the sync (or the machine running it) has stopped.
export const BOARD_STALE_MINUTES = 120;

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
// Date-only values ("2026-09-23") are shown as written; timestamps in local time.
const day = (iso) => {
  if (!iso) return "—";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Date(dateOnly ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
};
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "—");

// Weekdays after `fromIso` up to and including `now`, both taken as dates in
// the machine's local time zone (the shop's), not UTC.
const localDate = (date) => date.toLocaleDateString("en-CA");
export function businessDaysSince(fromIso, now) {
  if (!fromIso) return null;
  const start = new Date(`${localDate(new Date(fromIso))}T12:00:00Z`);
  const end = new Date(`${localDate(now)}T12:00:00Z`);
  let days = 0;
  for (let cursor = new Date(start); cursor < end;) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

export function latestDecisions(outputsDir) {
  const latest = new Map();
  for (const name of fs.readdirSync(outputsDir)) {
    const match = name.match(/^CLAUDE-DECISION-(.+)-v(\d+)\.json$/);
    if (!match) continue;
    const version = Number(match[2]);
    if (!latest.has(match[1]) || latest.get(match[1]).version < version) latest.set(match[1], { caseId: match[1], version, file: name });
  }
  return [...latest.values()].map((item) => ({ ...item, decision: JSON.parse(fs.readFileSync(path.join(outputsDir, item.file), "utf8")) }));
}

// The customer's RFQ number as the case states it ("ACME RFQ #4100" -> 4100).
function rfqNumbers(text) {
  return [...String(text || "").matchAll(/\bRFQ\s*#?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/gi)].map((match) => match[1].toUpperCase());
}

// Links a case to the monitor's queue entry under the monitor's own contract
// (outputs/RFQ-PRICING-INTEGRATION.md). The customer must match, and then
// either the case's exact rfq.monitorReference matches, or all of these hold:
// a full part number (not a longer part) appears in the reference, any
// revision stated there agrees, any RFQ number the case states appears there,
// and the two sides share a source email (required whenever the case lists
// its source emails; otherwise the stated RFQ number must agree). More than
// one candidate is left unresolved rather than guessed.
export function monitorLink(decision, queue) {
  const sameCustomer = queue.filter((item) => isSameCustomer(item.customer, decision.customer));
  const explicit = decision.rfq.monitorReference;
  let candidates;
  if (explicit) {
    candidates = sameCustomer.filter((item) => item.reference === explicit);
  } else {
    const caseRfqs = rfqNumbers(decision.rfq.reference);
    const caseMessages = new Set((decision.rfq.sourceMessageIds || []).flatMap((id) => [id, id.replace(/_/g, "+")]));
    candidates = sameCustomer.filter((item) => {
      const reference = item.reference || "";
      const partAndRevision = decision.lines.some((line) => {
        const match = partNumberMatch(reference, line.request.partNumber, line.request.aliases || []);
        if (!match || match.kind === "partial-token") return false;
        const stated = reference.match(/\brev\.?\s*([A-Z0-9]+)/i)?.[1];
        return !stated || !line.request.revision || stated.toUpperCase() === String(line.request.revision).toUpperCase();
      });
      if (!partAndRevision) return false;
      const tokens = new Set(reference.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean));
      const rfqAgrees = caseRfqs.some((number) => tokens.has(number));
      if (caseRfqs.length && !rfqAgrees) return false;
      const messages = [...(item.evidence_ids || []), ...(item.events || []).map((event) => event.message_id)].filter(Boolean);
      return caseMessages.size ? messages.some((id) => caseMessages.has(id)) : rfqAgrees;
    });
  }
  if (candidates.length === 1) return { entry: candidates[0], ambiguous: [] };
  return { entry: null, ambiguous: candidates.map((item) => item.reference) };
}

// Section 3 also holds PO, readiness and shipment activity, so a case counts
// as sent only when a clause of the monitor's status says a quote went out
// and neither that clause nor a bare qualifier doubts it ("not quoted",
// "quoted per ledger; unverified").
const SENT_CLAUSE = /\bquote\s+(?:\w+\s+){0,2}sent\b|\bsent\s+(?:an?\s+|the\s+)?(?:\w+\s+)?quote\b|\bquoted\b/i;
const DOUBT = /\b(?:not|no|never|unverified|unconfirmed|provisional|pending|draft|per ledger|will|shall|would|to be|going to|plan|plans|planned|scheduled|tomorrow|later|awaiting)\b/i;
const BARE_DOUBT = /^(?:still\s+)?(?:unverified|unconfirmed|provisional|not verified|not confirmed)\.?$/i;
export function quoteSentStatus(status) {
  const clauses = String(status || "").split(/\s*[;/]\s*/).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.some((clause) => BARE_DOUBT.test(clause))) return false;
  return clauses.some((clause) => SENT_CLAUSE.test(clause) && !DOUBT.test(clause));
}
// Section 1 also holds acknowledgment, timing and technical follow-ups.
export const PRICING_REQUEST = /\bRFQ\b|\bquot|\bpric|\bestimat|\bbudgetary\b|\binquir/i;

const SECTION = { 1: "no customer-facing reply found", 2: "acknowledged, no quote found", 3: "quote or later activity" };

// The plan and the log of rulings, builds and commits live in a private
// tracker file (config.trackerFile), kept by the Claude session; the board
// adds what it can see itself: pages built, recorded decisions, quotes sent.
// Outlook-on-the-web link for a Graph message id (URL-safe base64 → standard).
export function owaLink(messageId) {
  if (!messageId) return null;
  return `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId.replace(/_/g, "+").replace(/-/g, "/"))}&exvsurl=1&viewmodel=ReadMessageItem`;
}

// Sender and subject of the monitor's RFQ messages, looked up read-only by the
// Claude session (config.rfqMailCache); the board has no mail access itself.
function readMailCache(mailCachePath) {
  if (!mailCachePath || !fs.existsSync(mailCachePath)) return {};
  return JSON.parse(fs.readFileSync(mailCachePath, "utf8")).messages || {};
}

// The original RFQ email among a set of message ids: the earliest one we know.
function originalEmail(ids, known) {
  return (ids || []).map((id) => known(id)).filter(Boolean).sort((a, b) => (a.receivedAt || "").localeCompare(b.receivedAt || ""))[0] || null;
}

function readTracker(trackerPath) {
  if (!trackerPath || !fs.existsSync(trackerPath)) return { workingTowards: [], history: [] };
  const tracker = JSON.parse(fs.readFileSync(trackerPath, "utf8"));
  return { workingTowards: tracker.workingTowards || [], history: tracker.history || [] };
}

function caseEvents({ caseId, version, decision, lifecycle, monitor, sent }) {
  const name = `${decision.customer.name.replace(/\.$/, "")} ${decision.rfq.reference || caseId}`;
  const events = [{ at: decision.generatedAt, kind: "priced", text: `${name}: price page v${version} built`, caseId }];
  for (const entry of lifecycle.entries) {
    if (entry.type === "method-review") events.push({ at: entry.decidedAt, kind: "review", text: `${name} ${entry.lineId}: method ${entry.verdict}${entry.note ? ` (“${entry.note}”)` : ""} — ${entry.decidedBy}`, caseId });
    else if (entry.type === "decision") {
      const price = entry.unitPrice != null ? ` $${Number(entry.unitPrice).toFixed(2)}` : "";
      const words = entry.reply || entry.note;
      events.push({ at: entry.decidedAt, kind: entry.choice === "correction" ? "correction" : "decision", text: `${name} ${entry.lineId} v${entry.version}: ${entry.choice}${price} — ${entry.decidedBy}${words ? ` (“${words}”)` : ""}`, caseId });
    }
  }
  if (sent) events.push({ at: monitor.last_observed_activity_at || null, kind: "sent", text: `${name}: quote seen sent by the mail monitor (“${monitor.status}”)`, caseId });
  return events;
}

export function buildBoard({ outputsDir, monitorStatePath, storeDir = null, lastSync = null, trackerPath = null, mailCachePath = null, now = new Date() }) {
  const mailCache = readMailCache(mailCachePath);
  const state = monitorStatePath && fs.existsSync(monitorStatePath) ? JSON.parse(fs.readFileSync(monitorStatePath, "utf8")) : null;
  const queue = state?.operational_queue || [];
  const currentSnapshot = storeDir ? readManifest(storeDir).current : null;

  const cases = latestDecisions(outputsDir).map(({ caseId, version, file, decision }) => {
    const lifecycle = readLifecycle(lifecyclePath(outputsDir, caseId), caseId);
    const view = lifecycleView(decision, lifecycle);
    const status = displayStatus(decision, view);
    const partNumbers = [...new Set(decision.lines.map((line) => line.request.partNumber))];
    const link = monitorLink(decision, queue);
    const monitor = link.entry;
    const sent = monitor?.priority_section === 3 && quoteSentStatus(monitor.status);
    const priceSnapshot = decision.lines[0]?.history.database.snapshot;
    let label = status.text.startsWith("PARTLY") ? "Partly decided" : { warn: "Waiting on you", ok: "Decided — not sent", alert: "Correction requested" }[status.tone];
    let tone = status.tone;
    if (sent) {
      label = "Quote sent (per monitor status)";
      tone = "ok";
    }
    return {
      caseId,
      version,
      page: file.replace(/\.json$/, ".html"),
      customer: decision.customer.name,
      reference: decision.rfq.reference || null,
      askedAt: decision.rfq.initiatedAt,
      chasedAt: decision.rfq.latestAskAt,
      waitingBusinessDays: businessDaysSince(decision.rfq.initiatedAt, now),
      tone,
      state: label,
      open: !sent && status.tone !== "ok",
      monitor: monitor ? { reference: monitor.reference, section: monitor.priority_section, status: monitor.status, lastActivityAt: monitor.last_observed_activity_at || null } : null,
      monitorAmbiguous: link.ambiguous,
      staleSnapshot: Boolean(currentSnapshot && priceSnapshot && priceSnapshot.id !== currentSnapshot),
      priceSnapshot: priceSnapshot?.fileName || null,
      lines: decision.lines.map((line) => ({
        lineId: line.lineId,
        partNumber: line.request.partNumber,
        quantity: line.request.quantity,
        suggested: line.recommendation.preferred?.unitPrice ?? null,
        lotCharge: line.recommendation.preferred?.lotCharge ?? null,
        source: priceSource(line.recommendation.preferred),
        decided: view.current.get(line.lineId) || null,
      })),
      partNumbers,
      confidence: (() => { const grade = caseConfidence(decision.lines, view); return { level: grade.level, reasons: reasonsText(grade.weakest) }; })(),
      feedback: lifecycle.entries.filter((entry) => entry.type === "method-review" || entry.choice === "correction").map((entry) => ({ ...entry, caseId })),
      events: caseEvents({ caseId, version, decision, lifecycle, monitor, sent }),
      rfqLink: monitor?.evidence_links?.[0] || owaLink(decision.rfq.sourceMessageIds?.[0]),
      email: (() => {
        const evidence = new Map(decision.lines.flatMap((line) => line.history?.email?.evidence || []).map((item) => [item.id, item]));
        const found = originalEmail(decision.rfq.sourceMessageIds, (id) => evidence.get(id) || mailCache[id]);
        return { from: found?.from || decision.rfq.initiatedBy || null, fromName: found?.fromName || null, subject: found?.subject || null };
      })(),
    };
  });
  cases.sort((a, b) => Number(b.open) - Number(a.open) || (a.askedAt || "").localeCompare(b.askedAt || ""));

  let monitor = null;
  if (state) {
    const covered = new Set(cases.map((kase) => kase.monitor?.reference).filter(Boolean));
    const waiting = queue.filter((item) => item.priority_section === 1);
    const cutoff = state.freshness?.source_cutoff || null;
    const ageMinutes = cutoff ? (now.getTime() - Date.parse(cutoff)) / 60000 : null;
    monitor = {
      cutoff,
      ageMinutes,
      stale: Boolean(state.freshness?.stale) || ageMinutes == null || ageMinutes > MONITOR_STALE_MINUTES,
      report: state.last_check_report ? path.basename(state.last_check_report) : null,
      sections: { 1: waiting.length, 2: queue.filter((item) => item.priority_section === 2).length, 3: queue.filter((item) => item.priority_section === 3).length },
      waiting: waiting.length,
      withoutPage: waiting.filter((item) => !covered.has(item.reference)).map((item) => ({
        customer: item.customer,
        reference: item.reference,
        status: item.status,
        pricing: PRICING_REQUEST.test(`${item.reference} ${item.status}`),
        lastActivityAt: item.last_observed_activity_at || null,
        dueDate: item.explicit_due_date || null,
        dueBasis: item.due_basis || item.due_date_basis || null,
        ask: `Price RFQ: ${item.customer} ${item.reference}`,
        rfqLink: item.evidence_links?.[0] || owaLink(item.evidence_ids?.[0]),
        email: (() => {
          const found = originalEmail(item.evidence_ids, (id) => mailCache[id]);
          const firstActor = [...(item.events || [])].sort((a, b) => (a.at || "").localeCompare(b.at || ""))[0]?.actor || null;
          return { from: found?.from || firstActor, fromName: found?.fromName || null, subject: found?.subject || null };
        })(),
      })).sort((a, b) => (a.lastActivityAt ? 0 : 1) - (b.lastActivityAt ? 0 : 1) || (a.lastActivityAt || "").localeCompare(b.lastActivityAt || "")),
    };
  }
  const tracker = readTracker(trackerPath);
  const history = [...tracker.history.map((item) => ({ ...item, source: "log" })), ...cases.flatMap((kase) => kase.events)]
    .filter((item) => item.at)
    .sort((a, b) => b.at.localeCompare(a.at));
  return { generatedAt: now.toISOString(), cases, monitor, lastSync, plan: tracker.workingTowards, history };
}

const esc = (value) => escapeHtml(value);

function linesHtml(kase) {
  return kase.lines.map((line) => {
    const decided = line.decided && line.decided.choice !== "correction" ? line.decided : null;
    const unit = decided ? decided.unitPrice : line.suggested;
    const total = line.lotCharge != null && (!decided || decided.unitPrice === line.suggested) ? line.lotCharge : unit == null ? null : Math.round(unit * line.quantity * 100) / 100;
    const source = line.source && (!decided || decided.unitPrice === line.suggested) ? `<span class="note source${line.source.kind === "method" ? "" : " dated"}">${esc(line.source.text)}</span>` : "";
    return `<tr><td class="num">${line.quantity}</td><td class="num">${usd(unit)}${source}</td><td class="num strong">${usd(total)}${line.lotCharge != null ? '<span class="note">lot minimum</span>' : ""}</td><td>${decided ? `<span class="chip ok">${ICON.check}${esc(decided.choice)}</span>` : '<span class="chip warn">open</span>'}</td></tr>`;
  }).join("");
}

function caseCard(kase) {
  const monitor = kase.monitor
    ? `Monitor section ${kase.monitor.section} (${esc(SECTION[kase.monitor.section] || "unknown")}): “${esc(kase.monitor.status)}”`
    : kase.monitorAmbiguous.length
      ? `Monitor link unresolved: ${kase.monitorAmbiguous.length} entries match (${esc(kase.monitorAmbiguous.join("; "))})`
      : "No monitor entry verified (customer, part, revision and a shared email or RFQ number)";
  const late = kase.open && kase.waitingBusinessDays >= 2;
  return `<article class="case ${kase.tone}">
    <div class="case-head">
      <div class="case-title"><a class="case-link" href="${esc(kase.page)}">${esc(kase.customer)}</a><span class="muted small">${esc(kase.reference || kase.caseId)} · v${kase.version}</span></div>
      <div class="case-pills"><span class="chip ${{ High: "ok", Medium: "warn", Low: "alert" }[kase.confidence.level]}" title="${esc(kase.confidence.reasons.join(" "))}">Confidence: ${esc(kase.confidence.level)}</span><span class="pill ${kase.tone}">${esc(kase.state)}</span></div>
    </div>
    <ul class="meta">
      <li class="strong-chip">${esc(kase.partNumbers.join(", "))}</li>
      <li>Asked ${day(kase.askedAt)}</li>
      ${kase.chasedAt && kase.chasedAt !== kase.askedAt ? `<li>Chased ${day(kase.chasedAt)}</li>` : ""}
      ${kase.open && kase.waitingBusinessDays != null ? `<li class="${late ? "late" : ""}">${kase.waitingBusinessDays} business day${kase.waitingBusinessDays === 1 ? "" : "s"} waiting</li>` : ""}
    </ul>
    <p class="small case-email"><span class="muted">From</span> ${kase.email.fromName ? `${esc(kase.email.fromName)} &lt;${esc(kase.email.from)}&gt;` : esc(kase.email.from || "unknown")}${kase.email.subject ? ` · <span class="muted">Subject</span> “${esc(kase.email.subject)}”` : ""}</p>
    <div class="scroll"><table class="tiers compact"><thead><tr><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th><th>Decision</th></tr></thead><tbody>${linesHtml(kase)}</tbody></table></div>
    ${kase.open && kase.confidence.level !== "High" && kase.confidence.reasons.length ? `<p class="small">${ICON.alert} ${esc(kase.confidence.reasons[0])}</p>` : ""}
    <p class="muted small">${monitor}</p>
    ${kase.open && kase.staleSnapshot ? `<p class="hint">${ICON.alert}<span>Priced on ${esc(kase.priceSnapshot)}; newer Router History is in. Ask to rebuild.</span></p>` : ""}
    <div class="case-actions">${kase.rfqLink ? `<a class="btn ghost" href="${esc(kase.rfqLink)}" target="_blank" rel="noopener">Open RFQ email</a>` : ""}<a class="btn ghost" href="${esc(kase.page)}">Open decision page ${ICON.chevron}</a></div>
  </article>`;
}

const senderHtml = (email) => (email?.from ? `${email.fromName ? `<span class="strong">${esc(email.fromName)}</span><div class="why-not">${esc(email.from)}</div>` : esc(email.from)}` : '<span class="muted">not looked up</span>');
const subjectHtml = (email) => (email?.subject ? esc(email.subject) : '<span class="muted">not looked up</span>');

function monitorTable(items, title, open) {
  if (!items.length) return "";
  const rows = items.map((item) => `<tr><td><span class="strong">${esc(item.customer)}</span><div class="why-not">${esc(item.reference)}</div></td><td>${senderHtml(item.email)}</td><td>${subjectHtml(item.email)}${item.rfqLink ? `<div><a class="small" href="${esc(item.rfqLink)}" target="_blank" rel="noopener">Open RFQ email</a></div>` : ""}</td><td>${esc(item.status)}</td><td class="date">${item.lastActivityAt ? day(item.lastActivityAt) : "unknown"}</td><td class="date">${item.dueDate ? `${day(item.dueDate)}<div class="why-not">${esc(item.dueBasis ?? "basis not stated")}</div>` : '<span class="muted">none stated</span>'}</td></tr>`).join("");
  return `<details class="fold"${open ? " open" : ""}><summary>${ICON.chevron}<h3>${esc(title)} <small>${items.length}</small></h3></summary><div class="scroll"><table><thead><tr><th>Company · reference</th><th>Sender</th><th>Email subject</th><th>Monitor status</th><th>Last activity</th><th>Due</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

const PLAN_GROUPS = [["now", "Working on now"], ["waiting on you", "Waiting on you"], ["next", "Next"], ["blocked", "Blocked"], ["done", "Done recently"]];

function planPanel(plan) {
  if (!plan.length) return "";
  const groups = PLAN_GROUPS.map(([status, title]) => [title, plan.filter((item) => item.status === status)]).filter(([, items]) => items.length);
  return `<section id="plan" class="panel" aria-labelledby="plan-title">
    <div class="panel-head"><h2 id="plan-title">Working towards</h2><span class="count">${plan.filter((item) => item.status !== "done").length}</span></div>
    ${groups.map(([title, items]) => `<h3 class="plan-group">${esc(title)}</h3><ul class="plan">${items.map((item) => `<li><span class="strong">${esc(item.title)}</span>${item.since ? ` <span class="muted small">since ${day(item.since)}</span>` : ""}${item.detail ? `<p>${esc(item.detail)}</p>` : ""}</li>`).join("")}</ul>`).join("")}
  </section>`;
}

const KIND_TONE = { ruling: "warn", decision: "ok", sent: "ok", correction: "alert", priced: "muted", commit: "muted", build: "muted", review: "muted", note: "muted" };

function historyPanel(history) {
  if (!history.length) return "";
  const row = (item) => `<tr><td class="nowrap">${day(item.at)}</td><td><span class="chip ${KIND_TONE[item.kind] || "muted"}">${esc(item.kind)}</span></td><td>${esc(item.text)}</td></tr>`;
  const head = "<thead><tr><th>Date</th><th>Kind</th><th>What happened</th></tr></thead>";
  const recent = history.slice(0, 25);
  const older = history.slice(25);
  return `<section id="history" class="panel" aria-labelledby="history-title">
    <div class="panel-head"><h2 id="history-title">History</h2><span class="count">${history.length}</span></div>
    <p class="muted small">Newest first. Rulings, builds and commits come from the session log; decisions, price pages and sends come from the records and the mail monitor.</p>
    <div class="scroll"><table>${head}<tbody>${recent.map(row).join("")}</tbody></table></div>
    ${older.length ? `<details class="fold"><summary>${ICON.chevron}<h3>Older <small>${older.length}</small></h3></summary><div class="scroll"><table>${head}<tbody>${older.map(row).join("")}</tbody></table></div></details>` : ""}
  </section>`;
}

export function renderBoard(board) {
  const open = board.cases.filter((kase) => kase.open);
  const done = board.cases.filter((kase) => !kase.open);
  const feedback = board.cases.flatMap((kase) => kase.feedback);
  const monitor = board.monitor;
  const sync = board.lastSync;
  const rejected = (sync?.imports || []).filter((item) => item.outcome !== "accepted" && item.outcome !== "replay-noop" && item.outcome !== "archived-older");
  const alerts = [
    ...(monitor?.stale ? [`Mail data is STALE: the monitor's last successful check was ${monitor.cutoff ? when(monitor.cutoff) : "never recorded"}. The monitor may have stopped; "no reply found" rows may be out of date.`] : []),
    ...rejected.map((item) => item.outcome === "not-downloaded"
      ? `Router History export ${item.fileName} is in OneDrive but not downloaded to this Mac, so the background sync can't read it. Open the ROUTER HISTORY folder in Finder (or set it to "Always Keep on This Device"), or ask Claude to import it. Prices still use the last good snapshot.`
      : `Router History export ${item.fileName} was ${item.outcome}${item.failures.length ? ` (${item.failures.join(", ")})` : ""}. Prices still use the last good snapshot.`),
    ...(sync?.errors || []).map((error) => `Sync error: ${error}`),
  ];
  const pill = alerts.length ? ["alert", "Needs attention"] : open.length ? ["warn", `${open.length} waiting on you`] : ["ok", "Nothing waiting"];
  const unpriced = monitor ? monitor.withoutPage : [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RFQ Pricing Board</title>
<style>
${STYLE}
${BOARD_STYLE}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="who"><span class="customer">RFQ pricing</span><span class="sep">·</span><span>QPC</span></div>
    <span class="pill ${pill[0]}">${esc(pill[1])}</span>
  </div>
  <nav class="tabs" aria-label="Sections"><a href="#waiting">Waiting</a>${board.plan.length ? '<a href="#plan">Working towards</a>' : ""}${monitor ? '<a href="#unpriced">Unpriced RFQs</a>' : ""}${done.length ? '<a href="#decided">Decided</a>' : ""}<a href="#feedback">Feedback</a><a href="#history">History</a></nav>
</header>
<main>
  <div class="intro">
    <div id="board-stale" class="status alert" hidden></div>
    ${alerts.map((alert) => `<div class="status alert">${esc(alert)}</div>`).join("")}
    <p class="eyebrow">Private working file · keep inside QPC</p>
    <h1>RFQ pricing</h1>
    <p class="subtitle">${open.length} waiting on you · ${done.length} decided or sent${monitor ? ` · ${unpriced.length} unanswered RFQs without a price page` : ""}</p>
    <ul class="meta">
      ${monitor ? `<li class="${monitor.stale ? "stale" : ""}">Mail checked ${when(monitor.cutoff)}</li><li>${monitor.sections[1]} no reply</li><li>${monitor.sections[2]} acknowledged only</li><li>${monitor.sections[3]} in section 3 (quote or later activity)</li>${monitor.report ? `<li><a href="${esc(monitor.report)}">Latest check</a></li>` : ""}` : ""}
      <li>${sync ? `Last sync ${when(sync.at)} (${esc(sync.trigger)})${sync.imports.length ? `: imported ${sync.imports.map((item) => `${esc(item.fileName)} ${esc(item.outcome)}`).join(", ")}` : ""}` : "No sync has run yet"}</li>
    </ul>
  </div>

  <section id="waiting" class="panel" aria-labelledby="waiting-title">
    <div class="panel-head"><h2 id="waiting-title">Waiting on you</h2><span class="count">${open.length}</span></div>
    ${open.length ? `<div class="cases">${open.map(caseCard).join("")}</div>` : `<p class="empty">${ICON.check}<span>Nothing waiting. Every priced RFQ has a decision.</span></p>`}
  </section>

  ${planPanel(board.plan)}

  ${monitor ? `<section id="unpriced" class="panel" aria-labelledby="unpriced-title">
    <div class="panel-head"><h2 id="unpriced-title">Unanswered RFQs without a price page</h2><span class="count">${unpriced.length} of ${monitor.waiting}</span></div>
    <p class="muted">From the monitor's section 1 (no customer-facing reply found). It also holds acknowledgment, timing and technical follow-ups, and the split below reads only the monitor's wording, so check both groups. Copy a line and paste it to Claude to get a decision page built.</p>
    ${monitorTable(unpriced.filter((item) => item.pricing), "Status mentions a quote, RFQ or inquiry", true)}
    ${monitorTable(unpriced.filter((item) => !item.pricing), "Status doesn't say (may be a follow-up or an RFQ)", false)}
  </section>` : ""}

  ${done.length ? `<section id="decided" class="panel" aria-labelledby="decided-title">
    <div class="panel-head"><h2 id="decided-title">Decided or sent</h2><span class="count">${done.length}</span></div>
    <div class="cases">${done.map(caseCard).join("")}</div>
  </section>` : ""}

  <section id="feedback" class="panel" aria-labelledby="feedback-title">
    <div class="panel-head"><h2 id="feedback-title">Method feedback</h2><span class="count">${feedback.length}</span></div>
    ${feedback.length ? `<ul class="feedback">${feedback.map((entry) => {
      const verdict = entry.type === "method-review" ? entry.verdict : "correction";
      return `<li><span class="chip ${verdict === "ok" ? "ok" : "alert"}">${verdict === "ok" ? `${ICON.check}method ok` : verdict === "wrong" ? "method wrong" : "correction"}</span><div><span class="strong">${esc(entry.caseId)} ${esc(entry.lineId)}</span> <span class="muted small">v${entry.version}${entry.field ? ` · ${esc(entry.field)}` : ""} · ${esc(entry.decidedBy)}, ${day(entry.decidedAt)}</span>${entry.note ? `<p>${esc(entry.note)}</p>` : ""}</div></li>`;
    }).join("")}</ul>` : `<p class="muted">No method reviews recorded yet. Add <code>; method ok</code> or <code>; method wrong why: …</code> to an answer.</p>`}
  </section>

  ${historyPanel(board.history)}
</main>
<div class="toast" role="status" aria-live="polite">${ICON.check}<span>Copied to clipboard</span></div>
<script>
// Checked when the page is opened, so a board nothing has rebuilt still says so.
(() => {
  const generated = Date.parse(${JSON.stringify(board.generatedAt)});
  const minutes = (Date.now() - generated) / 60000;
  if (minutes > ${BOARD_STALE_MINUTES}) {
    const banner = document.getElementById("board-stale");
    banner.textContent = "This board has not refreshed for " + Math.round(minutes / 60) + " hours (built " + new Date(generated).toLocaleString() + "). The pricing sync or this Mac may have stopped; do not rely on it until it refreshes.";
    banner.hidden = false;
  }
})();
${SCRIPT}
</script>
</body>
</html>`;
}

const BOARD_STYLE = `
.plan-group { margin:var(--s4) 0 var(--s2); font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-3); }
.plan { list-style:none; margin:0; padding:0; display:grid; gap:var(--s2); }
.plan li { padding:var(--s3) var(--s4); border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
.plan li p { margin:var(--s1) 0 0; color:var(--ink-2); }
td.nowrap { white-space:nowrap; }
.panel-head { display:flex; align-items:center; gap:var(--s3); }
.panel-head .count { margin-left:0; }
.cases { display:grid; gap:var(--s3); }
.case { border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:var(--radius-sm); padding:var(--s4); display:grid; gap:var(--s3); background:var(--surface); transition:border-color .15s, box-shadow .15s; }
.case:hover { border-color:var(--line-2); box-shadow:var(--shadow-hover); }
.case.ok { border-left-color:var(--ok); } .case.alert { border-left-color:var(--alert); }
.case-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s3); }
.case-pills { display:flex; gap:var(--s2); align-items:center; flex-wrap:wrap; justify-content:flex-end; }
.case-title { display:grid; gap:2px; min-width:0; }
.case-link { font-size:17px; font-weight:650; color:var(--ink); text-decoration:none; letter-spacing:-.01em; }
.case-link:hover { text-decoration:underline; }
.meta li.strong-chip { font-weight:650; color:var(--ink); }
.meta li.stale { color:var(--alert); background:var(--alert-bg); font-weight:600; }
.tiers.compact td { padding-top:var(--s2); padding-bottom:var(--s2); font-size:14px; }
.case-actions { display:flex; justify-content:flex-end; gap:var(--s2); flex-wrap:wrap; }
.case-actions .btn .chevron { order:2; }
a.btn { text-decoration:none; }
td.date { white-space:nowrap; } td.date .why-not { white-space:normal; }
.empty { display:flex; gap:var(--s2); align-items:center; color:var(--ok); font-weight:550; }
.fold > summary h3 { display:inline; font-size:14px; } .fold > summary h3 small { color:var(--ink-3); font-weight:600; margin-left:var(--s1); }
.feedback { list-style:none; margin:0; padding:0; display:grid; gap:var(--s3); }
.feedback li { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--s3); align-items:start; }
.feedback p { margin-top:var(--s1); font-size:14px; color:var(--ink-2); }
.intro .status.alert { color:var(--alert); background:var(--alert-bg); border-left:3px solid var(--alert); border-radius:var(--radius-sm); padding:var(--s2) var(--s3); font-weight:550; }
@media (max-width:640px) { .case-head { flex-direction:column; } .case-actions { justify-content:stretch; } .case-actions .btn { width:100%; justify-content:center; } }
`;

export function writeBoard({ outputsDir, monitorStatePath, storeDir, lastSync, trackerPath = null, mailCachePath = null, now }) {
  const file = path.join(outputsDir, BOARD_FILE);
  const board = buildBoard({ outputsDir, monitorStatePath, storeDir, lastSync, trackerPath, mailCachePath, now });
  fs.writeFileSync(file, renderBoard(board));
  return { file, board };
}

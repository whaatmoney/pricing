import { businessDaysSince } from "./board.js";
import { lifecycleView } from "./lifecycle.js";
import { describeDecision, describeReview, displayStatus, escapeHtml, sizeText, STATUS_LABEL, summarizeLine, whyNot } from "./render.js";
import { answerLines, approveAllLine, assumptions, methodPath, poTotal, quoteSummary, reviewCard } from "./review-card.js";
import { caseConfidence, reasonsText } from "./confidence.js";
import { copyButton, ICON, SCRIPT as PAGE_SCRIPT, STYLE as PAGE_STYLE } from "./design.js";

// The decision page, laid out in the order a reviewer works: what is being
// asked and where it stands, the quote ready to paste with the checks to do
// before sending, the reasoning in plain words, the decision, and the full
// evidence folded away at the end. Everything shown comes from the saved
// record and its lifecycle file; nothing here prices anything.

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const day = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const isBlocked = (result) => Boolean(result?.blocked?.length);
const esc = (value) => escapeHtml(value);



// Method notation stays in the evidence; decisions read in plain words.
const plain = (text) => String(text).replace(/ \(Price Lab chain \(SQ5, SQ6 pending\)\)/g, " (method price)").replace(/Price Lab chain \(SQ5, SQ6 pending\)/g, "method price");


// Lines that describe the same part, revision and process (quantity tiers)
// share one story; only what differs per quantity is shown per line.
function groupLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    const key = [line.request.partNumber, line.request.revision, line.request.process.verbatim].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  return [...groups.values()];
}

function stateOf(decision, view) {
  const status = displayStatus(decision, view);
  if (status.tone === "ok") {
    const entries = [...view.current.values()];
    const names = [...new Set(entries.map((entry) => entry.decidedBy))].join(" and ");
    const when = entries.map((entry) => entry.decidedAt).sort().at(-1);
    const local = new Date(when).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    status.text = `DECIDED on v${decision.lifecycle.recommendationVersion} by ${names}, ${local}. Not sent yet; the quote goes out from your mailbox.`;
  }
  if (status.tone === "alert") return { tone: "alert", label: "Correction requested", status };
  if (status.tone === "ok") return { tone: "ok", label: "Approved · not sent", status };
  if (status.text.startsWith("PARTLY")) return { tone: "warn", label: "Partly decided", status };
  return { tone: "warn", label: "Waiting on you", status };
}

// The reasoning in plain words, one short sentence per step. The method's own
// notation stays in "Show the math".
const num4 = (value) => Number(value).toFixed(2);

function story(group, decision) {
  const first = group[0];
  const { recommendation: rec, calculations: calc } = first;
  const steps = [];
  const customer = decision.customer.name.replace(/\.$/, "");
  const orders = [...new Set(rec.repeatCandidates.map((po) => po.poNumber))];
  if (orders.length) {
    const po = rec.repeatCandidates[0];
    steps.push(["History", `${customer} accepted ${usd(po.unitPrice)} on ${orders.length === 1 ? "a PO" : `${orders.length} POs`} in the last 12 months for this exact part, revision and scope (newest ${po.poNumber}, ${po.quantity} pcs, ${day(po.date)}).`]);
  } else {
    steps.push(["History", "No accepted price for this part from this customer in the last 12 months."]);
  }
  if (isBlocked(calc.sq2)) {
    steps.push(["Size", `Can't price by size yet: ${calc.sq2.blocked[0]}`]);
  } else if (calc.sq2.source === "calculator") {
    const c = calc.sq2.components;
    const complexity = c.complexityKey !== "Standard" ? `, ${c.complexityKey.toLowerCase()} complexity${c.complexityReason ? ` (${c.complexityReason})` : ""}` : "";
    steps.push(["Size", `By size the calculator prices it at ${usd(calc.sq2.price)}: ${num4(c.volume)} in³ with the 1.1 buffer${complexity}. Holes and bores count only through complexity.`]);
  } else {
    const c = calc.sq2.components;
    const geometry = c.geometry.multiplier !== 1 ? `, ${String(c.geometry.class).toLowerCase()} internal geometry` : "";
    steps.push(["Size", `By size the part prices at ${usd(calc.sq2.price)}: the ${c.bracket.min}–${c.bracket.max} in³ bracket with level ${c.cleanliness.level} cleaning${geometry}.`]);
  }
  if (!isBlocked(calc.sq3)) {
    const handsOn = calc.sq3.handsOnPrice ?? calc.sq3.price;
    const below = !isBlocked(calc.sq2) && handsOn < calc.sq2.price;
    steps.push(["Labor", `Hands-on labor is ${usd(handsOn)} a part${below ? ", under the size price, so it doesn't raise it" : ""}.${calc.sq3.handsOnPrice != null ? " Setup time is covered by the lot minimum." : ""}`]);
  }
  if (!isBlocked(calc.sq5) && !isBlocked(calc.sq2) && calc.sq5.settled !== calc.sq2.price) steps.push(["Balance", `Weighing size against labor settles at ${usd(calc.sq5.settled)}.`]);
  if (rec.preferred?.basis.startsWith("REPEAT-ACCEPTED")) steps.push(["Pick", `Hold the price ${customer} already accepted, ${usd(rec.preferred.unitPrice)}. The method alone gives ${usd(calc.sq5.settled)}.`]);
  const results = group.map((line) => {
    const p = line.recommendation.preferred;
    if (!p) return `${line.request.quantity} ${line.request.uom}: no price — ${line.recommendation.uncalculated}`;
    return p.lotCharge != null
      ? `${line.request.quantity} ${line.request.uom}: ${usd(p.unitPrice)} × ${line.request.quantity} = ${usd(p.extended)}, under the ${usd(p.lotCharge)} lot minimum, so ${usd(p.lotCharge)} total.`
      : `${line.request.quantity} ${line.request.uom}: ${usd(p.unitPrice)} each, ${usd(p.extended)} total.`;
  });
  steps.push(["Result", results]);
  return steps;
}

function quoteSection(decision, view, groups, quote, state) {
  const byLine = new Map(quote.entries.map((entry) => [entry.lineId, entry]));
  const po = poTotal(decision, view);
  const blocks = groups.map((group) => {
    const request = group[0].request;
    const rows = group.map((line) => {
      const entry = byLine.get(line.lineId);
      const recorded = view.current.get(line.lineId);
      const decided = recorded && recorded.choice !== "correction" ? recorded : null;
      const unit = decided ? decided.unitPrice : line.recommendation.preferred?.unitPrice ?? null;
      const extended = unit == null ? null : Math.round(unit * line.request.quantity * 100) / 100;
      const minimum = line.recommendation.lotMinimum?.minimum ?? null;
      const lot = extended != null && minimum != null && extended < minimum;
      const chip = `<span class="chip ${entry.approved ? "ok" : "warn"}">${entry.approved ? `${ICON.check}approved` : "not approved"}</span>`;
      return `<tr><td class="num">${line.request.quantity} <span class="unit">${esc(line.request.uom)}</span></td><td class="num">${usd(unit)}</td><td class="num strong">${usd(lot ? minimum : extended)}${lot ? `<span class="note">lot minimum</span>` : ""}<span class="state-inline">${chip}</span></td><td class="col-state">${chip}</td></tr>`;
    }).join("");
    return `<div class="quote-part">
      <dl class="facts">
        <div><dt>P/N</dt><dd class="strong">${esc(request.partNumber)}${request.revision && request.revision !== "-" ? ` Rev. ${esc(request.revision)}` : ""}</dd></div>
        <div><dt>Process</dt><dd>${esc(request.process.verbatim)}</dd></div>
      </dl>
      <div class="scroll"><table class="tiers"><thead><tr><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th><th class="col-state">State</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  }).join("");

  const seen = new Set();
  const checks = decision.lines.flatMap((line) => summarizeLine(line, decision).checks)
    .filter((item) => !/^(Labor|Lot minimum):/.test(item))
    .filter((item) => (seen.has(item) ? false : seen.add(item)));
  const checklist = checks.length ? `<div class="checklist" data-key="${esc(`${decision.caseId}:v${decision.lifecycle.recommendationVersion}`)}">
      <div class="checklist-head"><h3>Before you send</h3><span class="progress" aria-live="polite"><span data-done>0</span> of ${checks.length} checked</span></div>
      ${checks.map((item, index) => {
        const [label, ...rest] = item.split(": ");
        return `<label class="check"><input type="checkbox" data-index="${index}"><span class="box">${ICON.check}</span><span class="check-text"><b>${esc(label)}</b><span>${esc(rest.join(": "))}</span></span></label>`;
      }).join("")}
    </div>` : "";

  const confidence = caseConfidence(decision.lines, view);
  const reasons = reasonsText(confidence.weakest);
  const tone = { High: "ok", Medium: "warn", Low: "alert" }[confidence.level];
  return `<section id="quote" class="hero${quote.allApproved ? " approved" : ""}" aria-labelledby="quote-title">
    <div class="hero-head">
      <div><p class="eyebrow">${quote.allApproved ? "Ready to send" : "Suggested quote"}</p><h2 id="quote-title">Quote</h2></div>
      ${copyButton(quote.text, "Copy quote", "primary")}
    </div>
    <div class="confidence ${tone}">
      <span class="chip ${tone}">Confidence: ${confidence.level}</span>
      ${reasons.length ? `<ul>${reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>` : ""}
      ${confidence.lines.length > 1 && new Set(confidence.lines.map((item) => item.level)).size > 1 ? `<p class="muted small">Weakest line: ${esc(confidence.weakest.lineId)}.</p>` : ""}
    </div>
    ${quote.allApproved ? "" : `<p class="hint">${ICON.alert}<span>${state.tone === "alert" ? "A fact is being corrected. Don't send this version." : "Not approved yet. Copy only after you decide below."}</span></p>`}
    ${blocks}
    ${po ? `<p class="po-total${po.below ? " below" : ""}"><b>${usd(po.charge)}</b> ${esc(po.text)} The lot minimum is for the entire PO, not per line.</p>` : ""}
    ${checklist}
  </section>`;
}

function whySection(decision, groups) {
  return `<section id="why" class="panel" aria-labelledby="why-title">
    <h2 id="why-title">How we got this price</h2>
    ${groups.map((group) => {
      const first = group[0];
      const flags = summarizeLine(first, decision).flags;
      const card = reviewCard(first, decision).filter((row) => !row.steps).map((row) => `<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}${row.source ? `<span class="source">${esc(row.source)}</span>` : ""}</dd></div>`).join("");
      const checks = assumptions(first);
      return `<div class="why-group">
        ${groups.length > 1 ? `<h3>${esc(first.request.partNumber)}${first.request.revision && first.request.revision !== "-" ? ` Rev. ${esc(first.request.revision)}` : ""}</h3>` : ""}
        <ol class="story">${story(group, decision).map(([tag, text]) => `<li><span class="tag">${esc(tag)}</span><span>${Array.isArray(text) ? text.map((item) => `<span class="result">${esc(item)}</span>`).join("") : esc(text)}</span></li>`).join("")}</ol>
        ${flags.length ? `<div class="callout warn">${ICON.alert}<div><b>Worth knowing</b><ul>${flags.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></div>` : ""}
        <details class="fold"><summary>${ICON.chevron}Facts and the math behind it</summary>
          <dl class="card facts">${card}</dl>
          ${group.map((line) => `<h4>${esc(line.lineId)} · ${line.request.quantity} ${esc(line.request.uom)}</h4><ol class="math">${methodPath(line).map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`).join("")}
          ${checks.length ? `<p class="muted small">Assumptions in the method: ${esc(checks.join("; "))}</p>` : ""}
        </details>
      </div>`;
    }).join("")}
  </section>`;
}

function decisionSection(decision, view) {
  const approveAll = [...view.current.values()].some((entry) => entry.choice !== "correction") ? null : approveAllLine(decision);
  const rows = decision.lines.map((line) => {
    const recorded = view.current.get(line.lineId);
    const decided = recorded && recorded.choice !== "correction";
    const { decisionNeeded, flatExtended } = summarizeLine(line, decision);
    const reviews = view.reviews.filter((item) => item.lineId === line.lineId).map((item) => `<p class="review ${item.verdict}">${item.verdict === "ok" ? ICON.check : ICON.alert}<span>${esc(describeReview(item))}</span></p>`).join("");
    const earlier = view.earlier.filter((entry) => entry.lineId === line.lineId).map((entry) => `<p class="earlier">Earlier: ${esc(plain(describeDecision(entry)))} It does not apply to this version.</p>`).join("");
    const replies = answerLines(line, decision, { flatExtended }).map((item) => `<div class="reply"><span class="reply-label">${esc(item.label)}</span><code>${esc(item.text)}</code>${copyButton(item.text, "Copy")}</div>`).join("");
    const answers = `<div class="answers">${replies}</div>`;
    return `<div class="decision-row">
      <div class="decision-line"><span class="line-id">${esc(line.lineId)}</span><span>${line.request.quantity} ${esc(line.request.uom)}</span></div>
      <div class="decision-body">
        ${recorded ? `<div class="recorded ${decided ? "ok" : "alert"}">${decided ? ICON.check : ICON.alert}<p>${esc(plain(describeDecision(recorded, line.recommendation.lotMinimum?.minimum)))}</p></div>` : `<p class="ask">${esc(decisionNeeded)}</p>`}
        ${reviews}${earlier}
        ${decided ? `<details class="fold"><summary>${ICON.chevron}Change the answer</summary>${answers}</details>` : answers}
      </div>
    </div>`;
  }).join("");
  return `<section id="decision" class="panel" aria-labelledby="decision-title">
    <h2 id="decision-title">Decision</h2>
    <p class="muted">Copy a line, edit it if needed, and paste it back to Claude. Add <code>; method ok</code> or <code>; method wrong why: …</code> to rate how the price was reached.</p>
    ${approveAll ? `<div class="reply all"><span class="reply-label">Approve every line at its suggested price</span><code>${esc(approveAll)}</code>${copyButton(approveAll, "Copy", "primary")}</div>` : ""}
    ${rows}
  </section>`;
}

function historyTable(line) {
  const rows = line.history.timeline.map((entry) => {
    const evidence = entry.link ? `<a href="${esc(entry.link)}" target="_blank" rel="noopener">${esc(entry.evidence)}</a>` : esc(entry.evidence);
    const reason = whyNot(entry);
    return `<tr class="${entry.status}"><td>${esc(entry.date || "—")}</td><td>${esc(entry.source)}</td><td>${evidence}</td><td class="num">${entry.quantity ?? "—"}</td><td class="num">${usd(entry.unitPrice)}</td><td>${esc(entry.scope)}</td><td><span class="chip ${entry.status === "comparable" ? "ok" : entry.status === "unverified" ? "warn" : "muted"}">${STATUS_LABEL[entry.status]}</span>${reason ? `<div class="why-not">${esc(reason)}</div>` : ""}${entry.notes.length ? `<div class="why-not">${esc(entry.notes.join("; "))}</div>` : ""}</td></tr>`;
  }).join("");
  return rows ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Source</th><th>Evidence</th><th class="num">Qty</th><th class="num">Unit</th><th>Scope</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">No price history for this part and customer in the checked sources.</p>`;
}

function calcBlock(line) {
  const calc = line.calculations;
  const rec = line.recommendation;
  const online = calc.onlineCalculator;
  const list = (items) => items.map((item) => `<li>${esc(item)}</li>`).join("");
  const sensitivity = (items) => items.map((item) => `${esc(item.label)} <b>${item.blocked ? "blocked" : usd(item.price)}</b>`).join(" · ");
  const options = [rec.preferred, ...rec.alternatives].filter(Boolean)
    .map((option, index) => `<tr${index === 0 ? " class=\"pick\"" : ""}><td>${esc(option.label)}${index === 0 ? ' <span class="chip ok">recommended</span>' : ""}</td><td class="num">${usd(option.unitPrice)}</td><td class="num">${usd(option.lotCharge ?? option.extended)}${option.lotCharge != null ? '<span class="note">lot minimum</span>' : ""}</td><td>${esc(option.basis)}</td></tr>`)
    .concat(calc.sq2.source === "calculator"
      ? (calc.masterSq2 && !isBlocked(calc.masterSq2) ? [`<tr><td>PriceGPT master SQ2 (reference only)</td><td class="num">${usd(calc.masterSq2.price)}</td><td class="num">${usd(calc.masterSq2.price * line.request.quantity)}</td><td>per-cavity charges; not used (ruling calculator-volume-v1)</td></tr>`] : [])
      : isBlocked(online) ? [] : [`<tr><td>Online calculator (reference)</td><td class="num">${usd(online.price)}</td><td class="num">${usd(online.price * line.request.quantity)}</td><td>${esc(online.method)}; no commercial rounding</td></tr>`]).join("");
  const steps = calc.sq3.steps.map((step) => `<tr><td>${esc(step.step)}</td><td>${esc(step.router)}</td><td>${esc(step.class)}</td><td class="num">${step.minutes}</td><td>${esc(step.basis)}</td></tr>`).join("");
  return `<h4>${esc(line.lineId)} · ${line.request.quantity} ${esc(line.request.uom)}</h4>
    <div class="scroll"><table><thead><tr><th>Option</th><th class="num">Unit</th><th class="num">Total</th><th>Basis</th></tr></thead><tbody>${options}</tbody></table></div>
    <p class="calc-title">Volume · ${esc(calc.sq2.method)} — <b>${isBlocked(calc.sq2) ? "blocked" : usd(calc.sq2.price)}</b></p><ul class="trace">${list(calc.sq2.trace?.length ? calc.sq2.trace : calc.sq2.blocked)}</ul><p class="muted small">${esc((calc.sq2.flags || []).join(" · "))}</p>${calc.sq2Sensitivity.length ? `<p class="small">Sensitivity: ${sensitivity(calc.sq2Sensitivity)}</p>` : ""}
    <p class="calc-title">Labor · ${esc(calc.sq3.method)} — <b>${isBlocked(calc.sq3) ? "blocked" : usd(calc.sq3.price)}</b>${calc.sq3.handsOnPrice != null ? ` · hands-on <b>${usd(calc.sq3.handsOnPrice)}</b>` : ""} <span class="chip muted">estimate · confidence ${esc(calc.sq3.confidence || "—")}</span></p>
    <p class="small">Batch ${calc.sq3.batch.size} (${esc(calc.sq3.batch.basis)}): ${esc(calc.sq3.batch.reason)}</p>
    <div class="scroll"><table><thead><tr><th>Step</th><th>Router</th><th>Class</th><th class="num">Min</th><th>Basis</th></tr></thead><tbody>${steps}</tbody></table></div>
    <ul class="trace">${list(calc.sq3.trace || [])}</ul>${calc.sq3Sensitivity.length ? `<p class="small">Sensitivity: ${sensitivity(calc.sq3Sensitivity)}</p>` : ""}
    <p class="calc-title">Settle · SQ5 — <b>${isBlocked(calc.sq5) ? "blocked" : usd(calc.sq5.settled)}</b></p><p class="small">${isBlocked(calc.sq5) ? esc(calc.sq5.blocked.join(" ")) : `${esc(calc.sq5.rule)}; divergence ${pct(calc.sq5.divergence ?? 0)}; anchor ${esc(calc.sq5.anchor?.choice || "—")}`}</p>
    ${isBlocked(calc.sq4) ? "" : `<p class="small">Negotiation band (context only): ${usd(calc.sq4.low)} · ${usd(calc.sq4.mid)} · ${usd(calc.sq4.high)}</p>`}
    <p class="calc-title">Online calculator — <b>${isBlocked(online) ? "blocked" : usd(online.price)}</b></p><ul class="trace">${list(online.trace || online.blocked || [])}</ul>`;
}

function evidenceSection(decision, groups) {
  const fresh = decision.freshness;
  const db = fresh.database.current;
  const fold = (title, count, body) => `<details class="fold"><summary>${ICON.chevron}${esc(title)}${count != null ? ` <span class="count">${count}</span>` : ""}</summary>${body}</details>`;
  const perGroup = groups.map((group) => {
    const first = group[0];
    const request = first.request;
    const jobs = first.history.jobs.map((job) => `<tr class="${job.agree ? "" : "alert"}"><td>${esc(job.job)}</td><td>${esc(job.date)}</td><td>${job.sources.map((source) => `${esc(source.source.split(" (")[0])} ${esc(source.evidence.split(",")[0])} <b>${usd(source.unitPrice)}</b>${source.status === "excluded" ? ' <span class="chip muted">excluded</span>' : ""}`).join("<br>")}</td><td>${job.agree ? '<span class="chip ok">agree</span>' : '<span class="chip alert">disagree</span>'}</td></tr>`).join("");
    const emails = first.history.email.evidence.map((email) => `<li><a href="${esc(email.webLink)}" target="_blank" rel="noopener">${esc(email.receivedAt.slice(0, 10))} · ${esc(email.type)}</a> — ${esc(email.from)}: ${esc(email.typeReason)}</li>`).join("");
    return `${groups.length > 1 ? `<h3>${esc(request.partNumber)}</h3>` : ""}
      ${fold("Price history", first.history.timeline.length, historyTable(first))}
      ${jobs ? fold("Job cross-check", first.history.jobs.length, `<div class="scroll"><table><thead><tr><th>Job</th><th>First date</th><th>Sources</th><th>Prices</th></tr></thead><tbody>${jobs}</tbody></table></div>`) : ""}
      ${fold("Calculations and options", group.length, group.map(calcBlock).join(""))}
      ${fold("Request facts", null, `<ul class="plain"><li>Drawing ${esc(request.drawing.number)} Rev. ${esc(request.drawing.revision)} ${esc(request.drawing.title)}. ${esc(request.drawing.caveat)}</li><li>Size: ${esc(sizeText(request.drawing.dimensions))} (${esc(request.drawing.dimensions.source)})</li><li>Material: ${esc(request.material.value)} — ${esc(request.material.source)}</li><li>Packaging: ${esc(request.packaging.requirement)}</li></ul>`)}
      ${fold("Emails considered", first.history.email.evidence.length, `<ul class="plain">${emails}</ul>`)}`;
  }).join("");
  const freshness = `<ul class="plain">
      <li>Email searched ${esc(fresh.email.searchedAt)}: ${fresh.email.searches.map((item) => `${esc(item.mailbox)} “${esc(item.query)}” ${item.results}${item.complete ? "" : " (partial)"}`).join("; ")}.</li>
      ${fresh.email.monitor ? `<li>Mail monitor cutoff ${esc(fresh.email.monitor.source_cutoff)} (stale ${fresh.email.monitor.stale}).</li>` : ""}
      <li>Router History ${esc(db.fileName)}, received ${esc(db.receivedMin)}…${esc(db.receivedMax)}, ${db.rows} rows.</li>
      <li>Invoices: ${esc(fresh.invoices.fileName)} ${esc(fresh.invoices.dateMin)}…${esc(fresh.invoices.dateMax)}. ${esc(fresh.invoices.note)}</li>
      <li>Price Lab package ${esc(fresh.rules.priceLab.capturedAt)}; calculator ${esc(fresh.rules.onlineCalculator.sha256.slice(0, 12))}.</li>
    </ul><h4>Not checked / gaps</h4><ul class="plain">${fresh.email.gaps.map((gap) => `<li>${esc(gap)}</li>`).join("")}</ul>`;
  return `<section id="evidence" class="panel" aria-labelledby="evidence-title">
    <h2 id="evidence-title">Evidence</h2>
    <p class="muted">Everything the price rests on, with sources. Folded until you need it.</p>
    ${perGroup}
    ${fold("Freshness and gaps", fresh.email.gaps.length, freshness)}
    <p class="muted small">Generated ${esc(decision.generatedAt)} · inputs ${esc(decision.inputsFingerprint.slice(0, 16))} · v${decision.lifecycle.recommendationVersion}${decision.lifecycle.supersedes ? ` supersedes v${decision.lifecycle.supersedes}` : ""} · private working file; keep inside QPC.</p>
  </section>`;
}

export function renderHtml(decision, { lifecycle, now = new Date(), quoteTemplate = null } = {}) {
  const view = lifecycleView(decision, lifecycle);
  const state = stateOf(decision, view);
  const groups = groupLines(decision.lines);
  const quote = quoteSummary(decision, view, { template: quoteTemplate });
  const first = decision.lines[0].request;
  const rfqRef = (decision.rfq.reference || "").match(/RFQ\s*#?\s*\d[\w-]*/i)?.[0] || "Email RFQ";
  const waiting = businessDaysSince(decision.rfq.initiatedAt, now);
  const title = groups.length === 1 ? `${first.partNumber} Rev. ${first.revision}` : `${groups.length} parts`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pricing Decision ${esc(decision.caseId)}</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="who"><span class="customer">${esc(decision.customer.name)}</span><span class="sep">·</span><span>${esc(rfqRef)}</span></div>
    <span class="pill ${state.tone}">${esc(state.label)}</span>
  </div>
  <nav class="tabs" aria-label="Sections"><a href="#quote">Quote</a><a href="#why">Why</a><a href="#decision">Decision</a><a href="#evidence">Evidence</a></nav>
</header>
<main>
  <div class="intro">
    <p class="eyebrow">First-pass pricing · v${decision.lifecycle.recommendationVersion}</p>
    <h1>${esc(title)}</h1>
    <p class="subtitle">${esc(first.description || "")}${first.description ? " · " : ""}${decision.lines.map((line) => `${line.request.quantity}`).join(" / ")} ${esc(first.uom)}</p>
    <ul class="meta">
      <li>Asked ${day(decision.rfq.initiatedAt)}</li>
      ${decision.rfq.latestAskAt && decision.rfq.latestAskAt !== decision.rfq.initiatedAt ? `<li>Chased ${day(decision.rfq.latestAskAt)}</li>` : ""}
      ${waiting != null ? `<li class="${waiting >= 2 ? "late" : ""}">${waiting} business day${waiting === 1 ? "" : "s"} waiting</li>` : ""}
      <li>From ${esc(decision.rfq.initiatedBy)}</li>
    </ul>
    <p class="status ${state.status.tone}">${esc(state.status.text)}</p>
  </div>
  ${quoteSection(decision, view, groups, quote, state)}
  ${whySection(decision, groups)}
  ${decisionSection(decision, view)}
  ${evidenceSection(decision, groups)}
</main>
<div class="toast" role="status" aria-live="polite">${ICON.check}<span>Copied to clipboard</span></div>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>`;
}

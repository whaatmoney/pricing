// Renders a decision record for review. Everything shown is derived from the
// record; the wording is templated so the same record always renders the same.

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const day = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const isBlocked = (result) => Boolean(result?.blocked?.length);

const STATUS_LABEL = { comparable: "comparable", unverified: "scope unverified", different: "different", excluded: "excluded" };

function reasonGroup(entry) {
  if (entry.status === "excluded") return entry.category;
  if (entry.status === "unverified") return "scope not stated";
  const first = entry.differences[0] || "";
  if (first.startsWith("oxygen")) return "oxygen-service scope differs";
  if (first.startsWith("quantity")) return "quantity differs";
  if (first.startsWith("revision")) return "revision differs";
  if (first.startsWith("level")) return "cleanliness level differs";
  return "different";
}

export function whyNot(entry) {
  if (entry.status === "comparable") return "";
  return [entry.status === "excluded" ? `${entry.category}: ${entry.categoryReason}` : null, ...entry.differences, ...entry.unknown].filter(Boolean).join("; ");
}

export function summarizeLine(line, decision) {
  const rec = line.recommendation;
  const calc = line.calculations;
  const request = line.request;
  const history = line.history;
  const why = [];
  const flags = [];

  const repeatPos = [...new Map(history.purchaseOrders
    .filter((po) => rec.repeatCandidates.some((item) => item.poNumber === po.poNumber))
    .sort((a, b) => (b.revision || 0) - (a.revision || 0))
    .map((po) => [po.poNumber, po])).values()];
  if (repeatPos.length) {
    why.push(`${decision.customer.name.replace(/\.$/, "")} issued ${repeatPos.length === 1 ? "a PO" : `${repeatPos.length} POs`} at ${usd(repeatPos[0].unitPrice)} for this exact part, revision and scope in the last 12 months: ${repeatPos.map((po) => `${po.poNumber} (${po.quantity} pcs, ${day(po.date)})`).join(" and ")}. This request is ${request.quantity} pcs.`);
    const matched = repeatPos.map((po) => ({ po, job: history.jobs.find((job) => job.job === po.customerWorkOrder) })).filter((item) => item.job);
    if (matched.length) {
      const text = matched.map(({ po, job }) => {
        const workOrders = job.sources.filter((source) => source.source.startsWith("Work order") && source.status !== "excluded");
        return `${po.poNumber} ↔ ${workOrders.map((source) => `${source.evidence.split(",")[0]} at ${usd(source.unitPrice)}`).join(", ") || "no work order found"} (job ${job.job})`;
      }).join("; ");
      why.push(`${matched.every(({ job }) => job.agree) ? "QPC's own work orders carry the same price" : "QPC's work orders DISAGREE with the PO price"}: ${text}.`);
    }
  }
  const samePriceScope = history.timeline.filter((entry) => entry.status === "comparable" && entry.unitPrice != null && rec.preferred && entry.unitPrice !== rec.preferred.unitPrice);
  if (samePriceScope.length) {
    const newest = samePriceScope[0];
    why.push(`The same scope was also priced at ${usd(newest.unitPrice)} on ${newest.evidence.split(",")[0]} (${day(newest.date)})${samePriceScope.length > 1 ? ` and ${samePriceScope.length - 1} older record(s)` : ""}. The move to ${usd(rec.preferred.unitPrice)} is not explained in the checked mail.`);
  }
  if (!isBlocked(calc.sq5) && rec.deltaVsChain && rec.deltaVsChain.dollars !== 0) {
    const direction = rec.deltaVsChain.dollars < 0 ? "raise" : "lower";
    why.push(`The Price Lab chain alone gives ${usd(calc.sq5.settled)} (SQ2 ${usd(calc.sq2.price)} from the drawing envelope; SQ3 labor estimate ${usd(calc.sq3.price)}, unmeasured). Quoting it instead would ${direction} the price ${usd(Math.abs(rec.deltaVsChain.dollars))} (${pct(Math.abs(rec.deltaVsChain.dollars) / rec.preferred.unitPrice)}) with no change in part, scope or quantity.`);
  }
  if (!isBlocked(calc.sq4) && rec.preferred) {
    const inside = rec.preferred.unitPrice >= calc.sq4.low && rec.preferred.unitPrice <= calc.sq4.high;
    why.push(`${usd(rec.preferred.unitPrice)} is ${inside ? "inside" : "outside"} the Price Lab SQ4 negotiation band (${usd(calc.sq4.low)}–${usd(calc.sq4.high)}, context only).`);
  }
  const notUsed = history.timeline.filter((entry) => entry.unitPrice != null && entry.status !== "comparable");
  if (notUsed.length) {
    const groups = new Map();
    for (const entry of notUsed) groups.set(reasonGroup(entry), (groups.get(reasonGroup(entry)) || 0) + 1);
    why.push(`${notUsed.length} other priced records are shown but not used: ${[...groups].map(([reason, count]) => `${count} ${reason}`).join(", ")}.`);
  }
  for (const job of history.jobs.filter((item) => !item.agree)) {
    flags.push(`Price disagreement on job ${job.job}: ${job.sources.filter((source) => source.status !== "excluded").map((source) => `${source.evidence.split(",")[0]} ${usd(source.unitPrice)}`).join(" vs ")}. A work-order price is not always the billed price.`);
  }

  const checks = [];
  if (/confirm/i.test(request.packaging?.status || "")) checks.push(`Packaging: quote the drawing default (${request.packaging.requirement}) unless the customer asks otherwise.`);
  if (decision.rfq.urgency) checks.push(`Lead time: ${decision.rfq.urgency} ${decision.commercial?.standardLeadTime ? `Standard is ${decision.commercial.standardLeadTime}.` : ""} ${decision.commercial?.expediteEvidence || ""}`.trim());
  if (request.drawing?.caveat) checks.push(`Drawing: ${request.drawing.caveat}`);
  const estimated = (calc.sq3.steps || []).filter((step) => step.basis !== "measured").length;
  if (estimated) checks.push(`Labor: all ${estimated} SQ3 step times are estimates (no measured times exist for this part). They do not set the recommended price.`);
  if (rec.lotMinimum) checks.push(`Lot minimum: ${usd(rec.lotMinimum.extended)} vs ${usd(rec.lotMinimum.minimum)} — ${rec.lotMinimum.passes ? "passes" : "BELOW MINIMUM"}.`);

  let decisionNeeded;
  if (rec.preferred && rec.policy.id.startsWith("repeat") && rec.alternatives[0]) {
    const alt = rec.alternatives[0];
    decisionNeeded = `Approve ${usd(rec.preferred.unitPrice)}/ea (${usd(rec.preferred.extended)} for ${request.quantity}), or quote the Price Lab chain's ${usd(alt.unitPrice)}/ea (${usd(alt.extended)}). Your answer also settles the open rule: should a customer-accepted PO price for the same part and scope (last 12 months) lead the recommendation? Master v2 leaves history out, so this rule is still a proposal.`;
  } else if (rec.preferred) {
    decisionNeeded = `Approve ${usd(rec.preferred.unitPrice)}/ea (${usd(rec.preferred.extended)} for ${request.quantity}) after the SQ6 review.`;
  } else {
    decisionNeeded = `No price: ${rec.uncalculated}`;
  }
  return { why, flags, checks, decisionNeeded };
}

export function renderMarkdown(decision) {
  const out = [];
  out.push(`# ${decision.caseId} — first-pass pricing decision v${decision.lifecycle.recommendationVersion}`);
  out.push("", `**${decision.status}**`, "");
  out.push(`Generated ${decision.generatedAt}. Mode ${decision.mode}. Inputs fingerprint \`${decision.inputsFingerprint.slice(0, 16)}\`.${decision.lifecycle.supersedes ? ` Supersedes v${decision.lifecycle.supersedes}.` : ""}`);
  for (const line of decision.lines) {
    const { why, flags, checks, decisionNeeded } = summarizeLine(line, decision);
    const rec = line.recommendation;
    const request = line.request;
    const calc = line.calculations;
    const online = calc.onlineCalculator;
    out.push("", `## ${line.lineId}: ${request.partNumber} Rev. ${request.revision} × ${request.quantity} ${request.uom}`, "");
    out.push(rec.preferred
      ? `**Recommend ${usd(rec.preferred.unitPrice)}/ea — ${usd(rec.preferred.extended)} for ${request.quantity}.** ${rec.preferred.label}.`
      : `**No recommended price.** ${rec.uncalculated}`);
    out.push("", `Policy: \`${rec.policy.id}\` (${rec.policy.status}). ${rec.policy.rule}`);
    out.push("", "### Decision needed", "", decisionNeeded);
    out.push("", "### Why", "", ...why.map((item) => `- ${item}`));
    if (flags.length) out.push("", "### Flags", "", ...flags.map((item) => `- ${item}`));
    out.push("", "### Before anything is sent", "", ...checks.map((item) => `- ${item}`));
    out.push("", "### Options", "", "| Option | Unit | Extended | Basis |", "|---|---:|---:|---|");
    for (const option of [rec.preferred, ...rec.alternatives].filter(Boolean)) out.push(`| ${option.label} | ${usd(option.unitPrice)} | ${usd(option.extended)} | ${option.basis} |`);
    if (!isBlocked(online)) out.push(`| Online calculator (reference) | ${usd(online.price)} | ${usd(online.price * request.quantity)} | ${online.method}; no commercial rounding |`);

    out.push("", "### Job cross-check (customer job number)", "", "| Job | First date | Sources | Prices | Agree? |", "|---|---|---|---|---|");
    for (const job of line.history.jobs) out.push(`| ${job.job} | ${job.date} | ${job.sources.map((source) => `${source.source.split(" (")[0]} ${source.evidence.split(",")[0]} ${usd(source.unitPrice)}${source.status === "excluded" ? " (excluded)" : ""}`).join("; ")} | ${job.prices.map(usd).join(", ")} | ${job.agree ? "yes" : "**NO**"} |`);

    out.push("", "### Price history (newest first)", "", "| Date | Source | Evidence | Qty | Unit | Scope | Status | Why not used |", "|---|---|---|---:|---:|---|---|---|");
    for (const entry of line.history.timeline) {
      const evidence = entry.link ? `[${entry.evidence}](${entry.link})` : entry.evidence;
      out.push(`| ${entry.date || "—"} | ${entry.source} | ${evidence} | ${entry.quantity ?? "—"} | ${usd(entry.unitPrice)} | ${entry.scope} | ${STATUS_LABEL[entry.status]} | ${whyNot(entry)}${entry.notes.length ? ` _(${entry.notes.join("; ")})_` : ""} |`);
    }

    out.push("", "### Independent calculations", "");
    out.push(`**Volume — ${calc.sq2.method}**: ${isBlocked(calc.sq2) ? `blocked: ${calc.sq2.blocked.join(" ")}` : `${usd(calc.sq2.price)} (unrounded ${usd(calc.sq2.unit)})`}`);
    for (const step of calc.sq2.trace || []) out.push(`- ${step}`);
    out.push(`- Flags: ${(calc.sq2.flags || []).join("; ")}`);
    out.push("", "Sensitivity:", ...calc.sq2Sensitivity.map((item) => `- ${item.label}: ${item.blocked ? `blocked (${item.blocked.join(" ")})` : usd(item.price)}`));
    out.push("", `**Volume — ${online.method}**: ${isBlocked(online) ? `blocked: ${online.blocked.join(" ")}` : `${usd(online.price)} (unrounded ${usd(online.unit)})`}`);
    for (const step of online.trace || []) out.push(`- ${step}`);
    for (const item of calc.onlineAlternatives) out.push(`- ${item.label}: ${item.blocked ? "blocked" : usd(item.price)}`);
    out.push("", `**Labor — ${calc.sq3.method}**: ${isBlocked(calc.sq3) ? `blocked: ${calc.sq3.blocked.join(" ")}` : `${usd(calc.sq3.price)} per part at $${calc.sq3.components.rate}/h, confidence ${calc.sq3.confidence}`}`);
    out.push(`- Batch ${calc.sq3.batch.size} (${calc.sq3.batch.basis}): ${calc.sq3.batch.reason}`);
    out.push("", "| Step | Router | Class | Minutes | Basis |", "|---|---|---|---:|---|");
    for (const step of calc.sq3.steps) out.push(`| ${step.step} | ${step.router} | ${step.class} | ${step.minutes} | ${step.basis} |`);
    for (const step of calc.sq3.trace || []) out.push(`- ${step}`);
    out.push(`- ${calc.sq3.measuredTimeSearch}`);
    out.push("", "Sensitivity:", ...calc.sq3Sensitivity.map((item) => `- ${item.label}: ${item.blocked ? "blocked" : usd(item.price)}`));
    out.push("", `**Stabilization — SQ5**: ${isBlocked(calc.sq5) ? `blocked: ${calc.sq5.blocked.join(" ")}` : `${usd(calc.sq5.settled)} — ${calc.sq5.rule}; divergence ${pct(calc.sq5.divergence ?? 0)}; anchor ${calc.sq5.anchor?.choice || "—"} (${calc.sq5.anchor?.reason || ""})`}`);
    out.push(`- Flags: ${(calc.sq5.flags || []).join("; ")}`);
    if (!isBlocked(calc.sq4)) out.push(`- SQ4 negotiation band (context only): low ${usd(calc.sq4.low)}, mid ${usd(calc.sq4.mid)}, high ${usd(calc.sq4.high)}`);
    out.push(`- SQ6: ${calc.sq6.status || calc.sq6.verdict}`);

    out.push("", "### Request facts", "");
    out.push(`- Process: ${request.process.verbatim} (${request.process.source})`);
    out.push(`- Material: ${request.material.value} — ${request.material.source}`);
    out.push(`- Drawing: ${request.drawing.number} Rev. ${request.drawing.revision} ${request.drawing.title}; ${request.drawing.caveat}`);
    out.push(`- Size: ø${request.drawing.dimensions.maxOdAfterCoating} in max OD after coating × ${request.drawing.dimensions.F_max} in (${request.drawing.dimensions.source})`);
    out.push(`- Packaging: ${request.packaging.requirement} Sources: ${request.packaging.sources.join("; ")}.`);

    out.push("", "### Email evidence considered", "");
    for (const email of line.history.email.evidence) {
      out.push(`- ${email.receivedAt.slice(0, 10)} [${email.type}](${email.webLink}) — ${email.from}: ${email.typeReason}${email.subjectScopeConflict ? " **Subject scope contradicts the authored text.**" : ""}`);
    }
  }
  const fresh = decision.freshness;
  const db = fresh.database.current;
  out.push("", "## Freshness and coverage", "");
  out.push(`- Email history searched ${fresh.email.searchedAt}: ${fresh.email.searches.map((item) => `${item.mailbox} "${item.query}" ${item.results}${item.complete ? " (all pages)" : " (partial)"}`).join("; ")}.`);
  if (fresh.email.monitor) out.push(`- Codex monitor source cutoff ${fresh.email.monitor.source_cutoff} (saved ${fresh.email.monitor.as_of}; stale ${fresh.email.monitor.stale}).`);
  out.push(`- Router History: ${db.fileName}, exported ${db.exportDate}, received dates ${db.receivedMin}…${db.receivedMax}, ${db.rows} rows, imported ${db.importedAt}; stale ${fresh.database.stale}; unimported newer exports: ${fresh.database.unimportedNewerExports.length || "none"}.`);
  out.push(`- Invoices: ${fresh.invoices.fileName} ${fresh.invoices.dateMin}…${fresh.invoices.dateMax}. ${fresh.invoices.note}`);
  out.push(`- Price Lab package captured ${fresh.rules.priceLab.capturedAt}; online calculator sha256 ${fresh.rules.onlineCalculator.sha256.slice(0, 12)} (formula drift: ${fresh.rules.onlineCalculator.formulaDrift.length ? "YES" : "none"}).`);
  out.push("", "### Not checked / gaps", "", ...fresh.email.gaps.map((gap) => `- ${gap}`), "");
  return out.join("\n");
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
const list = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

function renderLineHtml(line, decision) {
  const { why, flags, checks, decisionNeeded } = summarizeLine(line, decision);
  const rec = line.recommendation;
  const request = line.request;
  const calc = line.calculations;
  const online = calc.onlineCalculator;
  const options = [rec.preferred, ...rec.alternatives].filter(Boolean)
    .map((option, index) => `<tr${index === 0 ? " class=\"pick\"" : ""}><td>${escapeHtml(option.label)}${index === 0 ? " <span class=\"chip gold\">recommended</span>" : ""}</td><td class="num">${usd(option.unitPrice)}</td><td class="num">${usd(option.extended)}</td><td>${escapeHtml(option.basis)}</td></tr>`)
    .concat(isBlocked(online) ? [] : [`<tr><td>Online calculator (reference)</td><td class="num">${usd(online.price)}</td><td class="num">${usd(online.price * request.quantity)}</td><td>${escapeHtml(online.method)}; no commercial rounding</td></tr>`])
    .join("");
  const jobs = line.history.jobs.map((job) => `<tr class="${job.agree ? "" : "alert"}"><td>${escapeHtml(job.job)}</td><td>${escapeHtml(job.date)}</td><td>${job.sources.map((source) => `${escapeHtml(source.source.split(" (")[0])} ${escapeHtml(source.evidence.split(",")[0])} <b>${usd(source.unitPrice)}</b>${source.status === "excluded" ? " <span class=\"chip muted\">excluded</span>" : ""}`).join("<br>")}</td><td>${job.agree ? "<span class=\"chip ok\">agree</span>" : "<span class=\"chip alert\">disagree</span>"}</td></tr>`).join("");
  const history = line.history.timeline.map((entry) => {
    const evidence = entry.link ? `<a href="${escapeHtml(entry.link)}" target="_blank" rel="noopener">${escapeHtml(entry.evidence)}</a>` : escapeHtml(entry.evidence);
    const reason = whyNot(entry);
    return `<tr class="${entry.status}"><td>${escapeHtml(entry.date || "—")}</td><td>${escapeHtml(entry.source)}</td><td>${evidence}</td><td class="num">${entry.quantity ?? "—"}</td><td class="num">${usd(entry.unitPrice)}</td><td>${escapeHtml(entry.scope)}</td><td><span class="chip ${entry.status}">${STATUS_LABEL[entry.status]}</span>${reason ? `<div class="why-not">${escapeHtml(reason)}</div>` : ""}${entry.notes.length ? `<div class="why-not">${escapeHtml(entry.notes.join("; "))}</div>` : ""}</td></tr>`;
  }).join("");
  const steps = calc.sq3.steps.map((step) => `<tr><td>${escapeHtml(step.step)}</td><td>${escapeHtml(step.router)}</td><td>${step.class}</td><td class="num">${step.minutes}</td><td>${escapeHtml(step.basis)}</td></tr>`).join("");
  const emails = line.history.email.evidence.map((email) => `<li><a href="${escapeHtml(email.webLink)}" target="_blank" rel="noopener">${escapeHtml(email.receivedAt.slice(0, 10))} · ${escapeHtml(email.type)}</a> — ${escapeHtml(email.from)}: ${escapeHtml(email.typeReason)}${email.subjectScopeConflict ? " <strong>Subject scope contradicts the authored text.</strong>" : ""}</li>`).join("");
  const sensitivity = (items) => items.map((item) => `${escapeHtml(item.label)} <b>${item.blocked ? "blocked" : usd(item.price)}</b>`).join(" · ");
  return `
<section class="line">
  <div class="eyebrow">${escapeHtml(line.lineId)} · ${escapeHtml(decision.customer.name)}</div>
  <h2>${escapeHtml(request.partNumber)} Rev. ${escapeHtml(request.revision)} <span class="qty">× ${request.quantity} ${escapeHtml(request.uom)}</span></h2>
  <p class="process">${escapeHtml(request.process.verbatim)} · ${escapeHtml(request.material.value)}</p>
  <div class="decision">
    <div class="price">${rec.preferred ? `${usd(rec.preferred.unitPrice)}<span>/ea</span>` : "No price"}</div>
    <div class="ext">${rec.preferred ? `${usd(rec.preferred.extended)} for ${request.quantity}` : escapeHtml(rec.uncalculated)}</div>
    <div class="basis">${rec.preferred ? escapeHtml(rec.preferred.label) : ""}</div>
    <div class="policy"><span class="chip warn">Rule ${escapeHtml(rec.policy.status)}</span></div>
  </div>
  <div class="ask"><h3>Decision needed</h3><p>${escapeHtml(decisionNeeded)}</p></div>
  <h3>Why</h3><ul>${list(why)}</ul>
  ${flags.length ? `<h3>Flags</h3><ul class="alert-list">${list(flags)}</ul>` : ""}
  <h3>Before anything is sent</h3><ul>${list(checks)}</ul>
  <h3>Options</h3>
  <div class="scroll"><table><thead><tr><th>Option</th><th class="num">Unit</th><th class="num">Extended</th><th>Basis</th></tr></thead><tbody>${options}</tbody></table></div>
  <h3>Job cross-check <small>PO ↔ work order ↔ invoice, by the customer's job number</small></h3>
  <div class="scroll"><table><thead><tr><th>Job</th><th>First date</th><th>Sources</th><th>Prices</th></tr></thead><tbody>${jobs}</tbody></table></div>
  <h3>Price history <small>newest first · linked rows open the source email</small></h3>
  <div class="scroll"><table class="history"><thead><tr><th>Date</th><th>Source</th><th>Evidence</th><th class="num">Qty</th><th class="num">Unit</th><th>Scope</th><th>Status</th></tr></thead><tbody>${history}</tbody></table></div>
  <h3>Independent calculations</h3>
  <details open><summary>Volume · ${escapeHtml(calc.sq2.method)} — <b>${isBlocked(calc.sq2) ? "blocked" : usd(calc.sq2.price)}</b></summary><ul class="trace">${list(calc.sq2.trace?.length ? calc.sq2.trace : calc.sq2.blocked)}</ul><p class="flags">${escapeHtml((calc.sq2.flags || []).join(" · "))}</p><p>Sensitivity: ${sensitivity(calc.sq2Sensitivity)}</p></details>
  <details><summary>Volume · ${escapeHtml(online.method)} — <b>${isBlocked(online) ? "blocked" : usd(online.price)}</b></summary><ul class="trace">${list(online.trace || online.blocked)}</ul><p>${sensitivity(calc.onlineAlternatives)}</p></details>
  <details><summary>Labor · ${escapeHtml(calc.sq3.method)} — <b>${isBlocked(calc.sq3) ? "blocked" : usd(calc.sq3.price)}</b> <span class="chip muted">estimate · confidence ${escapeHtml(calc.sq3.confidence || "—")}</span></summary>
    <p>Batch ${calc.sq3.batch.size} (${escapeHtml(calc.sq3.batch.basis)}): ${escapeHtml(calc.sq3.batch.reason)}</p>
    <div class="scroll"><table><thead><tr><th>Step</th><th>Router</th><th>Class</th><th class="num">Min</th><th>Basis</th></tr></thead><tbody>${steps}</tbody></table></div>
    <ul class="trace">${list(calc.sq3.trace || [])}</ul><p>${escapeHtml(calc.sq3.measuredTimeSearch)}</p>
    <p>Sensitivity: ${sensitivity(calc.sq3Sensitivity)}</p></details>
  <details><summary>Stabilization · SQ5 — <b>${isBlocked(calc.sq5) ? "blocked" : usd(calc.sq5.settled)}</b></summary><p>${isBlocked(calc.sq5) ? escapeHtml(calc.sq5.blocked.join(" ")) : `${escapeHtml(calc.sq5.rule)}; divergence ${pct(calc.sq5.divergence ?? 0)}; anchor ${escapeHtml(calc.sq5.anchor?.choice || "—")} — ${escapeHtml(calc.sq5.anchor?.reason || "")}`}</p><p class="flags">${escapeHtml((calc.sq5.flags || []).join(" · "))}</p>${isBlocked(calc.sq4) ? "" : `<p>SQ4 negotiation band (context only): ${usd(calc.sq4.low)} · ${usd(calc.sq4.mid)} · ${usd(calc.sq4.high)}</p>`}<p>SQ6: ${escapeHtml(calc.sq6.status || calc.sq6.verdict)}</p></details>
  <h3>Request facts</h3>
  <ul>
    <li>Drawing: ${escapeHtml(request.drawing.number)} Rev. ${escapeHtml(request.drawing.revision)} ${escapeHtml(request.drawing.title)}. ${escapeHtml(request.drawing.caveat)}</li>
    <li>Size: ø${request.drawing.dimensions.maxOdAfterCoating} in max OD after coating × ${request.drawing.dimensions.F_max} in thick (${escapeHtml(request.drawing.dimensions.source)})</li>
    <li>Material: ${escapeHtml(request.material.value)} — ${escapeHtml(request.material.source)}</li>
    <li>Packaging: ${escapeHtml(request.packaging.requirement)}</li>
  </ul>
  <details><summary>Email evidence considered (${line.history.email.evidence.length})</summary><ul>${emails}</ul></details>
</section>`;
}

export function renderHtml(decision) {
  const fresh = decision.freshness;
  const db = fresh.database.current;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pricing Decision ${escapeHtml(decision.caseId)}</title>
<style>
:root { --bg:#f7f6f2; --card:#ffffff; --ink:#1f2937; --muted:#5b6472; --line:#e3e0d8; --gold:#c9a34d; --gold-deep:#8a6a1f; --ok:#1f7a4d; --ok-bg:#e6f4ec; --warn:#8a5a00; --warn-bg:#fff3d6; --alert:#a3261a; --alert-bg:#fde8e6; --pick:#fbf6e8; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14171c; --card:#1c2027; --ink:#e8e6e1; --muted:#a3a9b3; --line:#2d333d; --gold:#d9b96a; --gold-deep:#e6c77a; --ok:#6fd3a0; --ok-bg:#153326; --warn:#f0c46a; --warn-bg:#3a2e12; --alert:#ff9b8f; --alert-bg:#3d1c19; --pick:#262219; } }
:root[data-theme="dark"] { --bg:#14171c; --card:#1c2027; --ink:#e8e6e1; --muted:#a3a9b3; --line:#2d333d; --gold:#d9b96a; --gold-deep:#e6c77a; --ok:#6fd3a0; --ok-bg:#153326; --warn:#f0c46a; --warn-bg:#3a2e12; --alert:#ff9b8f; --alert-bg:#3d1c19; --pick:#262219; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
header .status { background:var(--warn-bg); color:var(--warn); border:1px solid var(--line); border-radius:8px; padding:10px 14px; font-weight:600; }
header h1 { font-size:22px; margin:12px 0 4px; }
header p { color:var(--muted); margin:0; }
.line { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-top:20px; }
.eyebrow { color:var(--gold-deep); font-size:12px; letter-spacing:.08em; text-transform:uppercase; font-weight:600; }
h2 { margin:4px 0; font-size:24px; } h2 .qty { color:var(--muted); font-weight:500; }
.process { margin:0 0 16px; color:var(--muted); }
.decision { border-left:4px solid var(--gold); background:var(--pick); padding:14px 18px; border-radius:8px; display:grid; grid-template-columns:minmax(0, 1fr); gap:2px; }
.decision .policy .chip { white-space:normal; }
.decision, li, .trace, .why-not, header p { overflow-wrap:anywhere; }
.decision .price { font-size:40px; font-weight:700; line-height:1.1; } .decision .price span { font-size:18px; color:var(--muted); font-weight:500; }
.decision .ext { font-size:17px; font-weight:600; } .decision .basis { color:var(--muted); } .decision .policy { margin-top:6px; }
.ask { margin-top:14px; } .ask p { margin:0; font-weight:500; }
h3 { font-size:16px; margin:22px 0 8px; } h3 small { color:var(--muted); font-weight:400; }
ul { margin:0; padding-left:20px; } li { margin:4px 0; }
.alert-list li { color:var(--alert); }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
td.num, th.num { text-align:right; white-space:nowrap; }
tr.pick td { background:var(--pick); font-weight:600; }
tr.different td, tr.excluded td { color:var(--muted); }
tr.alert td { background:var(--alert-bg); }
.chip { display:inline-block; border-radius:999px; padding:1px 8px; font-size:12px; font-weight:600; white-space:nowrap; }
.chip.comparable, .chip.ok { background:var(--ok-bg); color:var(--ok); }
.chip.unverified, .chip.warn { background:var(--warn-bg); color:var(--warn); }
.chip.different, .chip.excluded, .chip.muted { background:var(--line); color:var(--muted); }
.chip.alert { background:var(--alert-bg); color:var(--alert); }
.chip.gold { background:var(--gold); color:#1f2937; }
.why-not { font-size:12px; color:var(--muted); margin-top:2px; }
details { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:8px 0; }
summary { cursor:pointer; font-weight:500; }
.trace { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
.flags { color:var(--muted); font-size:13px; }
a { color:var(--gold-deep); }
footer { color:var(--muted); font-size:13px; margin-top:24px; }
footer li { margin:2px 0; }
@media (max-width:640px) { .decision .price { font-size:32px; } h2 { font-size:20px; } }
</style>
</head>
<body>
<main>
<header>
  <div class="status">${escapeHtml(decision.status)}</div>
  <h1>First-pass pricing decision · ${escapeHtml(decision.caseId)} · v${decision.lifecycle.recommendationVersion}</h1>
  <p>RFQ from ${escapeHtml(decision.rfq.initiatedBy)} on ${day(decision.rfq.initiatedAt)}; latest ask ${day(decision.rfq.latestAskAt)} (${escapeHtml(decision.rfq.latestAskSummary)}). Last QPC response: ${escapeHtml(decision.rfq.lastQpcResponse)}.</p>
</header>
${decision.lines.map((line) => renderLineHtml(line, decision)).join("")}
<footer>
  <h3>Freshness and coverage</h3>
  <ul>
    <li>Email history searched ${escapeHtml(fresh.email.searchedAt)}: ${fresh.email.searches.map((item) => `${escapeHtml(item.mailbox)} “${escapeHtml(item.query)}” ${item.results}${item.complete ? " (all pages)" : " (partial)"}`).join("; ")}.</li>
    ${fresh.email.monitor ? `<li>Codex monitor source cutoff ${escapeHtml(fresh.email.monitor.source_cutoff)} (saved ${escapeHtml(fresh.email.monitor.as_of)}; stale ${fresh.email.monitor.stale}).</li>` : ""}
    <li>Router History ${escapeHtml(db.fileName)}: exported ${escapeHtml(db.exportDate)}, received ${escapeHtml(db.receivedMin)}…${escapeHtml(db.receivedMax)}, ${db.rows} rows, imported ${escapeHtml(db.importedAt)}; stale ${fresh.database.stale}.</li>
    <li>Invoices: ${escapeHtml(fresh.invoices.fileName)} ${escapeHtml(fresh.invoices.dateMin)}…${escapeHtml(fresh.invoices.dateMax)}. ${escapeHtml(fresh.invoices.note)}</li>
    <li>Price Lab package captured ${escapeHtml(fresh.rules.priceLab.capturedAt)}; calculator sha256 ${escapeHtml(fresh.rules.onlineCalculator.sha256.slice(0, 12))}.</li>
  </ul>
  <h3>Not checked / gaps</h3>
  <ul>${list(fresh.email.gaps)}</ul>
  <p>Generated ${escapeHtml(decision.generatedAt)} · inputs ${escapeHtml(decision.inputsFingerprint.slice(0, 16))} · private working file; keep inside QPC.</p>
</footer>
</main>
</body>
</html>`;
}

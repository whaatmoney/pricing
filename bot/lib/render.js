import { caseConfidence, reasonsText } from "./confidence.js";
import { lifecycleView } from "./lifecycle.js";
import { answerLines, approveAllLine, poTotal, quoteSummary, reviewCard } from "./review-card.js";

// The HTML review page lives in page.js and the shared design in design.js;
// this module keeps the Markdown copy and the shared summary.
export { renderHtml } from "./page.js";

// Renders a decision record for review. Everything shown is derived from the
// record and its lifecycle file; the wording is templated so the same record
// always renders the same.

const usd = (value) => (value == null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const day = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const isBlocked = (result) => Boolean(result?.blocked?.length);

export const STATUS_LABEL = { comparable: "comparable", unverified: "scope unverified", different: "different", excluded: "excluded" };
const CHOICE_LABEL = { approved: "Approved", alternative: "Alternative chosen", correction: "Correction requested" };

// A case can state its part size in its own words; seal cases give the coated
// OD and thickness instead.
export const sizeText = (dimensions) => dimensions.summary || `ø${dimensions.maxOdAfterCoating} in max OD after coating × ${dimensions.F_max} in thick`;

// `minimum` is the version's lot minimum, for entries recorded before the
// lot charge was stored on the entry itself.
export function describeDecision(entry, minimum = null) {
  const who = `${entry.decidedBy}, ${when(entry.decidedAt)}`;
  const note = entry.note && !/[.!?]$/.test(entry.note) ? `${entry.note}.` : entry.note;
  const ruling = entry.policyRuling ? ` Rule ${entry.policyRuling.policy}: ${entry.policyRuling.ruling} by ${entry.decidedBy}.` : "";
  if (entry.choice === "correction") return `${CHOICE_LABEL.correction} on v${entry.version} by ${who}: ${note}${ruling}`;
  const option = entry.option ? ` (${entry.option})` : " (not one of the listed options)";
  const charge = entry.lotCharge ?? minimum;
  const lot = entry.belowLotMinimum ? (charge != null ? ` Under the lot minimum, so the quote is the ${usd(charge)} lot charge.` : " Below the lot minimum.") : "";
  return `${CHOICE_LABEL[entry.choice]} on v${entry.version}: ${usd(entry.unitPrice)}/ea, ${usd(entry.extended)} for ${entry.quantity}${option}. ${who}.${lot}${note ? ` Note: ${note}` : ""}${ruling}`;
}

export function describeReview(entry) {
  return `Method ${entry.verdict}${entry.field ? ` (${entry.field})` : ""} on v${entry.version}: ${entry.decidedBy}, ${when(entry.decidedAt)}.${entry.note ? ` ${entry.note}` : ""}`;
}

// The page's status line. A decision counts only for the version and inputs
// it was made on; decisions on other versions are listed but never carried.
export function displayStatus(decision, view) {
  const version = decision.lifecycle.recommendationVersion;
  const earlier = view.earlier.map((entry) => `v${entry.version} ${entry.lineId} ${entry.choice}${entry.unitPrice != null ? ` ${usd(entry.unitPrice)}` : ""} (${entry.decidedBy})`);
  const decided = decision.lines.map((line) => view.current.get(line.lineId)).filter(Boolean);
  if (!decided.length) {
    return { tone: "warn", text: `${decision.status}${earlier.length ? ` Earlier decision(s): ${earlier.join("; ")}. They do not carry over to v${version}.` : ""}` };
  }
  const corrections = decided.filter((entry) => entry.choice === "correction");
  if (corrections.length) return { tone: "alert", text: `CORRECTION REQUESTED on v${version} (${corrections.map((entry) => entry.lineId).join(", ")}): a fact is wrong, so this version cannot be approved. Correct the case file and rebuild. Nothing is approved or sent.` };
  const summary = decided.map((entry) => `${entry.lineId} ${usd(entry.unitPrice)}/ea ${entry.choice} by ${entry.decidedBy}`).join("; ");
  const open = decision.lines.filter((line) => !view.current.get(line.lineId)).map((line) => line.lineId);
  if (open.length) return { tone: "warn", text: `PARTLY DECIDED on v${version}: ${summary}. Still needs review: ${open.join(", ")}. Nothing has been sent.` };
  return { tone: "ok", text: `DECIDED on v${version}: ${summary}. Not sent; sending the quote is a separate step.` };
}

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
    why.push(`The Price Lab chain alone gives ${usd(calc.sq5.settled)} (SQ2 ${usd(calc.sq2.price)} from the drawing envelope; SQ3 ${calc.sq3.handsOnPrice != null ? `hands-on labor ${usd(calc.sq3.handsOnPrice)}` : `labor estimate ${usd(calc.sq3.price)}`}, unmeasured). Quoting it instead would ${direction} the price ${usd(Math.abs(rec.deltaVsChain.dollars))} (${pct(Math.abs(rec.deltaVsChain.dollars) / rec.preferred.unitPrice)}) with no change in part, scope or quantity.`);
  }
  const inverted = !isBlocked(calc.sq5) && /inversion/.test(calc.sq5.rule || "");
  const chainLeads = Boolean(rec.preferred) && !rec.preferred.basis.startsWith("REPEAT-ACCEPTED");
  const flatExtended = inverted && chainLeads && rec.lotMinimum ? Math.max(Math.round(calc.sq2.price * request.quantity * 100) / 100, rec.lotMinimum.minimum) : null;
  if (!history.timeline.length) why.push("No price history for this part and customer in the checked sources (Router History, invoice export, email).");
  if (inverted && chainLeads) {
    why.push(`The volume method (SQ2) gives ${usd(calc.sq2.price)}; the labor method (SQ3) gives ${usd(calc.sq3.price)} from estimated step times spread over ${calc.sq3.batch.size} parts. Master v2 takes the labor figure when it is higher (model inversion), so the price is ${usd(calc.sq5.settled)}.`);
    if (flatExtended != null) why.push(`Quoted instead at the volume price with the ${usd(rec.lotMinimum.minimum)} lot minimum, this line would come to ${usd(flatExtended)} (${usd(flatExtended / request.quantity)}/ea effective) instead of ${usd(rec.preferred.extended)}.`);
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
  if (/confirm/i.test(request.packaging?.status || "")) checks.push(`Packaging: quote the drawing default (${request.packaging.requirement.replace(/^Drawing default:\s*/i, "")}) unless the customer asks otherwise.`);
  if (decision.rfq.urgency) checks.push(`Lead time: ${decision.rfq.urgency} ${decision.commercial?.standardLeadTime ? `Standard is ${decision.commercial.standardLeadTime}.` : ""} ${decision.commercial?.expediteEvidence || ""}`.trim());
  if (request.drawing?.caveat) checks.push(`Drawing: ${request.drawing.caveat}`);
  const estimated = (calc.sq3.steps || []).filter((step) => step.basis !== "measured").length;
  if (estimated) {
    checks.push(inverted && chainLeads
      ? `Labor: all ${estimated} SQ3 step times are estimates (no measured times exist for this part), and they set this price. Check the sensitivity lines under Labor.`
      : `Labor: all ${estimated} SQ3 step times are estimates (no measured times exist for this part). They do not set the recommended price.`);
  }
  if (rec.preferred?.lotCharge != null) checks.push(`Lot minimum: ${usd(rec.lotMinimum.extended)} at the unit price is under the ${usd(rec.lotMinimum.minimum)} minimum, so this line is quoted at ${usd(rec.preferred.lotCharge)}.`);
  else if (rec.lotMinimum) checks.push(`Lot minimum: ${usd(rec.lotMinimum.extended)} vs ${usd(rec.lotMinimum.minimum)} — ${rec.lotMinimum.passes ? "passes" : "BELOW MINIMUM"}.`);

  let decisionNeeded;
  if (rec.preferred && rec.policy.id.startsWith("repeat") && rec.alternatives[0]) {
    const alt = rec.alternatives[0];
    decisionNeeded = `Approve ${usd(rec.preferred.unitPrice)}/ea (${usd(rec.preferred.extended)} for ${request.quantity}), or quote the Price Lab chain's ${usd(alt.unitPrice)}/ea (${usd(alt.extended)}).${rec.policy.approved ? "" : " Your answer also settles the open rule: should a customer-accepted PO price for the same part and scope (last 12 months) lead the recommendation? Master v2 leaves history out, so this rule is still a proposal."}`;
  } else if (rec.preferred?.lotCharge != null) {
    decisionNeeded = `Approve ${usd(rec.preferred.unitPrice)}/ea with the ${usd(rec.preferred.lotCharge)} lot minimum (${usd(rec.preferred.lotCharge)} for ${request.quantity}; ${usd(rec.preferred.extended)} at the unit price).`;
  } else if (rec.preferred && flatExtended != null) {
    decisionNeeded = `Approve ${usd(rec.preferred.unitPrice)}/ea (${usd(rec.preferred.extended)} for ${request.quantity}), or quote the volume price ${usd(calc.sq2.price)}/ea with the ${usd(rec.lotMinimum.minimum)} lot minimum (${usd(flatExtended)} for ${request.quantity}).`;
  } else if (rec.preferred) {
    decisionNeeded = `Approve ${usd(rec.preferred.unitPrice)}/ea (${usd(rec.preferred.extended)} for ${request.quantity}).`;
  } else {
    decisionNeeded = `No price: ${rec.uncalculated}`;
  }
  return { why, flags, checks, decisionNeeded, flatExtended };
}

export function renderMarkdown(decision, { lifecycle, quoteTemplate = null } = {}) {
  const view = lifecycleView(decision, lifecycle);
  const out = [];
  out.push(`# ${decision.caseId} — first-pass pricing decision v${decision.lifecycle.recommendationVersion}`);
  out.push("", `**${displayStatus(decision, view).text}**`, "");
  const approveAll = [...view.current.values()].some((entry) => entry.choice !== "correction") ? null : approveAllLine(decision);
  const quote = quoteSummary(decision, view, { template: quoteTemplate });
  const confidence = caseConfidence(decision.lines, view);
  out.push(`## Quote (${quote.allApproved ? "approved" : "not all lines approved"})`, "", "```", quote.text, "```", "", ...quote.entries.map((entry) => `- ${entry.lineId}: ${entry.state}`), "");
  const po = poTotal(decision, view);
  if (po) out.push(`**Lot minimum (entire PO):** ${po.text}`, "");
  out.push(`**Confidence: ${confidence.level}**${reasonsText(confidence.weakest).length ? ` — ${reasonsText(confidence.weakest).join(" ")}` : ""}`, "");
  if (approveAll) out.push("Approve every line at its suggested price:", "", "```", approveAll, "```", "");
  out.push(`Generated ${decision.generatedAt}. Mode ${decision.mode}. Inputs fingerprint \`${decision.inputsFingerprint.slice(0, 16)}\`.${decision.lifecycle.supersedes ? ` Supersedes v${decision.lifecycle.supersedes}.` : ""}`);
  for (const line of decision.lines) {
    const { why, flags, checks, decisionNeeded, flatExtended } = summarizeLine(line, decision);
    const rec = line.recommendation;
    const request = line.request;
    const calc = line.calculations;
    const online = calc.onlineCalculator;
    out.push("", `## ${line.lineId}: ${request.partNumber} Rev. ${request.revision} × ${request.quantity} ${request.uom}`, "");
    for (const row of reviewCard(line, decision)) {
      if (row.steps) {
        out.push(`- **${row.label}:**`, ...row.steps.map((step, index) => `  ${index + 1}. ${step}`));
        if (row.assumptions.length) out.push(`  - _Check:_ ${row.assumptions.join("; ")}`);
      } else {
        out.push(`- **${row.label}:** ${row.value}${row.source ? ` _(${row.source})_` : ""}`);
      }
    }
    for (const review of view.reviews.filter((item) => item.lineId === line.lineId)) out.push(`- _${describeReview(review)}_`);
    out.push("", "### Answer (paste one line back)", "", "```", ...answerLines(line, decision, { flatExtended }).map((item) => item.text), "```", "");
    out.push(rec.preferred
      ? `**Recommend ${usd(rec.preferred.unitPrice)}/ea — ${usd(rec.preferred.extended)} for ${request.quantity}.** ${rec.preferred.label}.`
      : `**No recommended price.** ${rec.uncalculated}`);
    out.push("", `Policy: \`${rec.policy.id}\` (${rec.policy.status}). ${rec.policy.rule}`);
    const recorded = view.current.get(line.lineId);
    if (recorded) out.push("", "### Decision recorded", "", describeDecision(recorded, rec.lotMinimum?.minimum));
    for (const entry of view.earlier.filter((item) => item.lineId === line.lineId)) out.push("", `_Earlier: ${describeDecision(entry)} It does not apply to this version._`);
    out.push("", recorded && recorded.choice !== "correction" ? "### Question that was answered" : "### Decision needed", "", decisionNeeded);
    out.push("", "### Why", "", ...why.map((item) => `- ${item}`));
    if (flags.length) out.push("", "### Flags", "", ...flags.map((item) => `- ${item}`));
    out.push("", "### Before anything is sent", "", ...checks.map((item) => `- ${item}`));
    out.push("", "### Options", "", "| Option | Unit | Extended | Basis |", "|---|---:|---:|---|");
    for (const option of [rec.preferred, ...rec.alternatives].filter(Boolean)) out.push(`| ${option.label} | ${usd(option.unitPrice)} | ${usd(option.extended)} | ${option.basis} |`);
    if (calc.sq2.source === "calculator") {
      if (calc.masterSq2 && !isBlocked(calc.masterSq2)) out.push(`| PriceGPT master SQ2 (reference only) | ${usd(calc.masterSq2.price)} | ${usd(calc.masterSq2.price * request.quantity)} | per-cavity charges; not used (ruling calculator-volume-v1) |`);
    } else if (!isBlocked(online)) out.push(`| Online calculator (reference) | ${usd(online.price)} | ${usd(online.price * request.quantity)} | ${online.method}; no commercial rounding |`);

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
    if (calc.sq2.source === "calculator") {
      if (calc.masterSq2) {
        out.push("", `**Reference only — ${calc.masterSq2.method}** (per-cavity charges; not used, ruling calculator-volume-v1): ${isBlocked(calc.masterSq2) ? `blocked: ${calc.masterSq2.blocked.join(" ")}` : usd(calc.masterSq2.price)}`);
        for (const step of calc.masterSq2.trace || []) out.push(`- ${step}`);
      }
    } else {
      out.push("", `**Volume — ${online.method}**: ${isBlocked(online) ? `blocked: ${online.blocked.join(" ")}` : `${usd(online.price)} (unrounded ${usd(online.unit)})`}`);
      for (const step of online.trace || []) out.push(`- ${step}`);
      for (const item of calc.onlineAlternatives) out.push(`- ${item.label}: ${item.blocked ? "blocked" : usd(item.price)}`);
    }
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
    out.push(`- Size: ${sizeText(request.drawing.dimensions)} (${request.drawing.dimensions.source})`);
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


export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
export const list = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");



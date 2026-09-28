import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { versionsOf } from "./versioning.js";

// A person's decision on a recommendation is its own record, kept beside the
// decision files in CLAUDE-DECISION-<case>-lifecycle.json. Entries are only
// ever appended, each one bound to the version and inputs fingerprint it was
// made on and chained to the entry before it, so regenerating a recommendation
// can never overwrite, edit or carry forward an approval.

export const LIFECYCLE_SCHEMA = "qpc-rfq-lifecycle/0.1";
export const CHOICES = ["approved", "alternative", "correction"];
export const POLICY_RULINGS = ["approved", "rejected"];
export const METHOD_VERDICTS = ["ok", "wrong"];
// The review card's fields; a correction or a method review can name one.
export const CARD_FIELDS = ["pn", "envelope", "qty", "process", "price", "why"];

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const cents = (value) => Math.round(Number(value) * 100);
const money = (value) => Math.round(value * 100) / 100;

export function lifecyclePath(outputsDir, caseId) {
  return path.join(outputsDir, `CLAUDE-DECISION-${caseId}-lifecycle.json`);
}

function entryHash(entry) {
  return sha256(JSON.stringify(entry));
}

export function readLifecycle(file, caseId) {
  if (!fs.existsSync(file)) return { schema: LIFECYCLE_SCHEMA, caseId, entries: [] };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.schema !== LIFECYCLE_SCHEMA) throw new Error(`${path.basename(file)} is not a ${LIFECYCLE_SCHEMA} record.`);
  if (data.caseId !== caseId) throw new Error(`${path.basename(file)} belongs to case ${data.caseId}, not ${caseId}.`);
  let previous = null;
  for (const [index, entry] of data.entries.entries()) {
    if (entry.id !== index + 1 || entry.previousHash !== previous) {
      throw new Error(`${path.basename(file)} entry ${index + 1} was edited, removed or reordered; the record is append-only. Restore it before recording anything else.`);
    }
    previous = entryHash(entry);
  }
  return data;
}

function readDecision(outputsDir, caseId, version) {
  const file = path.join(outputsDir, `CLAUDE-DECISION-${caseId}-v${version}.json`);
  if (!fs.existsSync(file)) throw new Error(`No recommendation v${version} for ${caseId} in ${outputsDir}.`);
  return { file, decision: JSON.parse(fs.readFileSync(file, "utf8")) };
}

// Every priced option the review page offered for a line.
function listedOptions(line) {
  const rec = line.recommendation;
  const online = line.calculations?.onlineCalculator;
  return [rec.preferred, ...(rec.alternatives || [])].filter(Boolean)
    .concat(online && !online.blocked?.length ? [{ label: "Online calculator (reference)", unitPrice: online.price }] : []);
}

function checkDecider({ decidedBy, decidedAt, approvers, now }) {
  const who = String(decidedBy || "").trim();
  if (!who) throw new Error("Record who decided.");
  if (approvers?.length && !approvers.some((name) => name.toLowerCase() === who.toLowerCase())) {
    throw new Error(`"${who}" is not a configured approver (${approvers.join(", ")}).`);
  }
  const when = decidedAt ? new Date(decidedAt) : now;
  if (Number.isNaN(when.getTime())) throw new Error(`Cannot read the decision time "${decidedAt}".`);
  return { who, when };
}

function resolveLine({ outputsDir, caseId, version, lineId }) {
  if (!version) throw new Error("Name the recommendation version the decision was made on.");
  const { decision } = readDecision(outputsDir, caseId, version);
  if (decision.caseId !== caseId) throw new Error(`v${version} belongs to case ${decision.caseId}, not ${caseId}.`);
  if (!lineId && decision.lines.length > 1) throw new Error(`v${version} has ${decision.lines.length} lines (${decision.lines.map((line) => line.lineId).join(", ")}); name the line.`);
  const line = lineId ? decision.lines.find((item) => item.lineId === lineId) : decision.lines[0];
  if (!line) throw new Error(`v${version} has no line ${lineId}.`);
  return { decision, line };
}

function checkField(field) {
  if (field != null && !CARD_FIELDS.includes(field)) throw new Error(`Field must be one of: ${CARD_FIELDS.join(", ")}.`);
  return field ?? null;
}

// dryRun validates and returns the entry without writing it.
function append(file, lifecycle, fields, dryRun) {
  const previous = lifecycle.entries.at(-1);
  const entry = { id: lifecycle.entries.length + 1, ...fields, previousHash: previous ? entryHash(previous) : null };
  if (dryRun) return entry;
  lifecycle.entries.push(entry);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(lifecycle, null, 2)}\n`);
  fs.renameSync(temp, file);
  return entry;
}

// Validates a decision against the version it names and appends it.
// Returns the entry plus any notices the person recording it should see.
export function recordDecision({ outputsDir, caseId, version, lineId, choice, unitPrice, decidedBy, decidedAt, note, field, policyRuling, reply, approvers, dryRun = false, now = new Date() }) {
  if (!CHOICES.includes(choice)) throw new Error(`Choice must be one of: ${CHOICES.join(", ")}.`);
  const { who, when } = checkDecider({ decidedBy, decidedAt, approvers, now });
  const text = String(note || "").trim();
  if (policyRuling && !POLICY_RULINGS.includes(policyRuling)) throw new Error(`Rule ruling must be one of: ${POLICY_RULINGS.join(", ")}.`);
  const cardField = checkField(field);
  const { decision, line } = resolveLine({ outputsDir, caseId, version, lineId });
  const rec = line.recommendation;
  const quantity = line.request.quantity;
  const notices = [];

  let price = null;
  let option = null;
  if (choice === "correction") {
    if (unitPrice != null) throw new Error("A correction records a wrong fact, not a price. Leave the price off.");
    if (!text) throw new Error("A correction needs a note saying which fact is wrong.");
  } else {
    if (unitPrice == null || !(Number(unitPrice) > 0)) throw new Error(`An ${choice} decision needs the unit price that was decided.`);
    price = money(Number(unitPrice));
    if (choice === "approved") {
      if (!rec.preferred) throw new Error(`v${version} ${line.lineId} has no recommended price to approve. Record an alternative with a note, or a correction.`);
      if (cents(price) !== cents(rec.preferred.unitPrice)) {
        throw new Error(`v${version} ${line.lineId} recommends $${rec.preferred.unitPrice.toFixed(2)}, not $${price.toFixed(2)}. Use the alternative choice for a different price.`);
      }
      option = rec.preferred.label;
    } else {
      if (rec.preferred && cents(price) === cents(rec.preferred.unitPrice)) throw new Error(`$${price.toFixed(2)} is the recommended price; record it as approved.`);
      option = listedOptions(line).find((item) => cents(item.unitPrice) === cents(price))?.label || null;
      if (!option && !text) throw new Error(`$${price.toFixed(2)} is not one of the listed options; add a note giving its basis.`);
    }
  }

  const file = lifecyclePath(outputsDir, caseId);
  const lifecycle = readLifecycle(file, caseId);
  const newest = versionsOf(outputsDir, `CLAUDE-DECISION-${caseId}`)[0];
  if (newest > version) notices.push(`v${version} has been superseded by v${newest}; this decision applies to v${version} only.`);
  const earlier = [...lifecycle.entries].reverse().find((entry) => entry.type === "decision" && entry.version === version && entry.lineId === line.lineId);
  if (earlier) notices.push(`This replaces decision #${earlier.id} on v${version} ${line.lineId}; both stay on record.`);
  const extended = price == null ? null : money(price * quantity);
  const minimum = rec.lotMinimum?.minimum;
  if (extended != null && minimum != null && extended < minimum) notices.push(`$${extended.toFixed(2)} for ${quantity} is below the $${minimum.toFixed(2)} lot minimum.`);

  const entry = append(file, lifecycle, {
    type: "decision",
    version,
    inputsFingerprint: decision.inputsFingerprint,
    lineId: line.lineId,
    choice,
    unitPrice: price,
    quantity,
    extended,
    option,
    belowLotMinimum: extended != null && minimum != null ? extended < minimum : null,
    lotCharge: extended != null && minimum != null && extended < minimum ? minimum : null,
    recommended: rec.preferred ? { unitPrice: rec.preferred.unitPrice, label: rec.preferred.label } : null,
    policy: rec.policy?.id || null,
    policyRuling: policyRuling ? { policy: rec.policy?.id || null, ruling: policyRuling } : null,
    decidedBy: who,
    decidedAt: when.toISOString(),
    recordedAt: now.toISOString(),
    note: text || null,
    field: cardField,
    reply: reply || null,
    supersedesEntry: earlier?.id ?? null,
  }, dryRun);
  return { entry, file, notices };
}

// A reviewer's verdict on how the price was reached (independent of which
// price they chose), so the method can be checked and improved over time.
export function recordMethodReview({ outputsDir, caseId, version, lineId, verdict, field, note, decidedBy, decidedAt, reply, approvers, dryRun = false, now = new Date() }) {
  if (!METHOD_VERDICTS.includes(verdict)) throw new Error(`Method verdict must be one of: ${METHOD_VERDICTS.join(", ")}.`);
  const { who, when } = checkDecider({ decidedBy, decidedAt, approvers, now });
  const text = String(note || "").trim();
  if (verdict === "wrong" && !text) throw new Error("A \"method wrong\" review needs a note saying what is wrong.");
  const cardField = checkField(field);
  const { decision, line } = resolveLine({ outputsDir, caseId, version, lineId });
  const file = lifecyclePath(outputsDir, caseId);
  const lifecycle = readLifecycle(file, caseId);
  const entry = append(file, lifecycle, {
    type: "method-review",
    version,
    inputsFingerprint: decision.inputsFingerprint,
    lineId: line.lineId,
    verdict,
    field: cardField,
    note: text || null,
    policy: line.recommendation.policy?.id || null,
    recommended: line.recommendation.preferred ? { unitPrice: line.recommendation.preferred.unitPrice, label: line.recommendation.preferred.label } : null,
    decidedBy: who,
    decidedAt: when.toISOString(),
    recordedAt: now.toISOString(),
    reply: reply || null,
  }, dryRun);
  return { entry, file, notices: [] };
}

// What the lifecycle says about one rendered version: the decision in force
// for each of its lines, and decisions made on other versions (or on a
// version whose inputs have since changed), which never count for this one.
export function lifecycleView(decision, lifecycle) {
  const version = decision.lifecycle?.recommendationVersion;
  const latest = new Map();
  for (const entry of lifecycle?.entries || []) {
    if (entry.type === "decision") latest.set(`${entry.version}|${entry.lineId}`, entry);
  }
  const current = new Map();
  const earlier = [];
  for (const entry of latest.values()) {
    if (entry.version === version && entry.inputsFingerprint === decision.inputsFingerprint) current.set(entry.lineId, entry);
    else earlier.push(entry);
  }
  const reviews = (lifecycle?.entries || []).filter((entry) => entry.type === "method-review" && entry.version === version && entry.inputsFingerprint === decision.inputsFingerprint);
  return { current, earlier, reviews };
}

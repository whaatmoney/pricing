import fs from "node:fs";
import path from "node:path";
import { CARD_FIELDS, recordDecision, recordMethodReview } from "./lifecycle.js";

// A reviewer answers by pasting one line the review page offers, edited if
// needed. The line is parsed exactly; anything it cannot read is refused, never
// guessed. Grammar (case-insensitive, parts separated by ";"):
//
//   <case> v<N> <L1 | L1,L2 | all> approve <price>[/<price>...]
//   <case> v<N> <line> alt <price> — <basis>
//   <case> v<N> <line> correct <field>: <what is right>
//   <case> v<N> <line> method ok | method wrong [<field>]: <what is wrong>
//   ...optionally followed by "; method ok", "; method wrong [<field>]: ..."
//   and "; rule approve" or "; rule reject".

const PRICE = /^\$?(\d+(?:\.\d{1,2})?)$/;
const FIELD_ALIASES = { "p/n": "pn", part: "pn", "part number": "pn", dims: "envelope", dimensions: "envelope", size: "envelope", quantity: "qty", "suggested unit price": "price", unit: "price" };

function readField(text) {
  const key = String(text || "").trim().toLowerCase();
  if (!key) return null;
  const field = FIELD_ALIASES[key] || key;
  if (!CARD_FIELDS.includes(field)) throw new Error(`"${text}" is not a card field (${CARD_FIELDS.join(", ")}).`);
  return field;
}

function readPrice(text) {
  const match = String(text || "").trim().match(PRICE);
  if (!match) throw new Error(`"${text}" is not a price.`);
  return Number(match[1]);
}

// "wrong envelope: the tag adds 0.5 in" -> { verdict, field, note }
function readMethod(text) {
  const match = text.match(/^method\s+(ok|wrong)\b\s*([^:]*)(?::\s*(.*))?$/i);
  if (!match) throw new Error(`Cannot read "${text}". Use "method ok" or "method wrong [field]: what is wrong".`);
  const method = { verdict: match[1].toLowerCase(), field: readField(match[2]), note: (match[3] || "").trim() || null };
  if (method.verdict === "wrong" && !method.note) throw new Error("\"method wrong\" needs what is wrong after the colon, for example \"method wrong why: step 3 lot time is too high\".");
  return method;
}

export function parseAnswer(text) {
  const [head, ...rest] = String(text || "").trim().split(/\s*;\s*/);
  const match = head.match(/^(\S+)\s+v(\d+)\s+(all|L\d+(?:\s*,\s*L\d+)*)\s+(.+)$/i);
  if (!match) throw new Error("An answer starts with the case, version and line, for example \"CASE v1 L1 approve 8.50\".");
  const answer = { caseId: match[1], version: Number(match[2]), lines: match[3].toLowerCase() === "all" ? "all" : match[3].toUpperCase().split(/\s*,\s*/), action: null, method: null, rule: null };
  const body = match[4].trim();
  let action;
  if ((action = body.match(/^approve\s+(\S+)$/i))) {
    answer.action = { choice: "approved", prices: action[1].split("/").map(readPrice) };
  } else if ((action = body.match(/^alt(?:ernative)?\s+(\S+)(?:(?:\s*(?:—|–|-{1,2}|:)\s*|\s+)(.+))?$/i))) {
    answer.action = { choice: "alternative", prices: [readPrice(action[1])], note: (action[2] || "").trim() || null };
  } else if ((action = body.match(/^correct\s+([^:]+):\s*(.+)$/i))) {
    answer.action = { choice: "correction", field: readField(action[1]), note: action[2].trim() };
  } else if (/^correct\b/i.test(body)) {
    throw new Error("A correction names the field and what is right, for example \"correct envelope: 0.35 x 0.20 x 0.20 in\".");
  } else if (/^method\b/i.test(body)) {
    answer.method = readMethod(body);
  } else {
    throw new Error(`Cannot read "${body}". Use approve, alt, correct or method.`);
  }
  for (const part of rest) {
    if (/^method\b/i.test(part)) {
      if (answer.method) throw new Error("Give one method verdict per answer.");
      answer.method = readMethod(part);
    } else if (/^rule\s+(approve|approved|reject|rejected)$/i.test(part)) {
      answer.rule = /^rule\s+approve/i.test(part) ? "approved" : "rejected";
    } else {
      throw new Error(`Cannot read "${part}".`);
    }
  }
  return answer;
}

// Validates every entry the answer implies before writing any of them, so a
// bad line records nothing.
export function applyAnswer({ text, outputsDir, decidedBy, decidedAt, approvers, now = new Date() }) {
  const answer = parseAnswer(text);
  const file = path.join(outputsDir, `CLAUDE-DECISION-${answer.caseId}-v${answer.version}.json`);
  if (!fs.existsSync(file)) throw new Error(`No recommendation v${answer.version} for ${answer.caseId}.`);
  const decision = JSON.parse(fs.readFileSync(file, "utf8"));
  const lineIds = answer.lines === "all" ? decision.lines.map((line) => line.lineId) : answer.lines;
  const common = { outputsDir, caseId: answer.caseId, version: answer.version, decidedBy, decidedAt, approvers, reply: String(text).trim(), now };
  const calls = [];
  if (answer.action) {
    const { choice, prices, note, field } = answer.action;
    if (prices && prices.length !== 1 && prices.length !== lineIds.length) throw new Error(`${prices.length} prices for ${lineIds.length} lines.`);
    lineIds.forEach((lineId, index) => {
      const unitPrice = prices ? (prices.length === 1 ? prices[0] : prices[index]) : null;
      calls.push([recordDecision, { ...common, lineId, choice, unitPrice, note, field, policyRuling: answer.rule }]);
    });
  } else if (answer.rule) {
    throw new Error("A rule ruling goes with a price decision.");
  }
  if (answer.method) for (const lineId of lineIds) calls.push([recordMethodReview, { ...common, lineId, ...answer.method }]);
  for (const [record, args] of calls) record({ ...args, dryRun: true });
  return { answer, results: calls.map(([record, args]) => record(args)) };
}

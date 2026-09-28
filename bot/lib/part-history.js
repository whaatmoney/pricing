import { normalizeText } from "../../core.js";

// Exact part-history matching for pricing decisions. Part Memory's search is a
// substring filter; a pricing decision needs to know *how* a record matched
// (exact token, formatting variant, known alias, or merely a longer token that
// contains the P/N), whose record it is, and whether its scope is the same.

const CUSTOMER_SUFFIXES = new Set(["INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LLC", "LTD", "LIMITED", "LP", "PLC", "THE"]);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePartNumber(value) {
  return normalizeText(value).toUpperCase().replace(/\s+/g, " ");
}

export function compactPartNumber(value) {
  return normalizePartNumber(value).replace(/[^A-Z0-9]/g, "");
}

function partPatterns(partNumber) {
  const exact = normalizePartNumber(partNumber);
  const compact = compactPartNumber(partNumber);
  return {
    compact,
    // A dash or dot joining more characters after the P/N makes a different
    // part ("ABC-100-1", "0000111222-C01-T1"); before it, see joinedPrefix.
    exact: new RegExp(`(?<![A-Z0-9])${escapeRegex(exact)}(?![A-Z0-9]|[\\-.][A-Z0-9])`, "g"),
    extended: new RegExp(`(?:[A-Z0-9]+[\\-.])*${escapeRegex(exact)}(?:[\\-.][A-Z0-9]+)*`),
    // PDF text extraction and people insert spaces, dashes or dots ("704 C4T1 H").
    spaced: new RegExp(`(?<![A-Z0-9])${compact.split("").map(escapeRegex).join("[\\s\\-.]{0,3}")}(?![A-Z0-9]|[\\-.][A-Z0-9])`, "g"),
  };
}

// Labels people join to a P/N with a dash ("RFQ-ABC100", "PN-ABC-100"). Any
// other characters joined by a dash or dot make a longer, different part
// ("X-ABC-100").
const JOINED_LABELS = new Set(["RFQ", "PN", "P/N", "PO", "NO", "REF", "SN", "S/N"]);
function joinedPrefix(upper, index) {
  const before = upper.slice(Math.max(0, index - 12), index).match(/([A-Z0-9/]+)[-.]$/);
  return before && !JOINED_LABELS.has(before[1]) ? before[1] : null;
}

function firstStandalone(pattern, upper) {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(upper); match; match = pattern.exec(upper)) {
    if (!joinedPrefix(upper, match.index)) return match;
  }
  return null;
}

// Returns how `text` refers to the part, or null. Kinds, strongest first:
// exact, formatting-variant, known-alias, partial-token.
export function partNumberMatch(text, partNumber, aliases = []) {
  const upper = normalizeText(text).toUpperCase();
  if (!upper) return null;
  const patterns = partPatterns(partNumber);
  let match = firstStandalone(patterns.exact, upper);
  if (match) return { kind: "exact", matched: match[0], index: match.index };
  match = firstStandalone(patterns.spaced, upper);
  if (match) return { kind: "formatting-variant", matched: match[0], index: match.index };
  for (const alias of aliases) {
    const aliasValue = typeof alias === "string" ? alias : alias.value;
    match = firstStandalone(partPatterns(aliasValue).exact, upper);
    if (match) return { kind: "known-alias", matched: match[0], index: match.index, reason: alias.reason || "" };
  }
  match = patterns.extended.exec(upper);
  if (match && match[0] !== normalizePartNumber(partNumber)) return { kind: "partial-token", matched: match[0], index: match.index };
  const token = upper.split(/[^A-Z0-9]+/).find((word) => word !== patterns.compact && word.includes(patterns.compact));
  if (token) return { kind: "partial-token", matched: token, index: upper.indexOf(token) };
  return null;
}

export function revisionNear(text, partNumber, aliases = []) {
  const upper = normalizeText(text).toUpperCase();
  const found = partNumberMatch(upper, partNumber, aliases);
  if (!found || found.kind === "partial-token") return null;
  const after = upper.slice(found.index + found.matched.length, found.index + found.matched.length + 40);
  const revision = after.match(/^[\s,;:\-_]*REV(?:ISION)?\.?\s*[:\-]?\s*([A-Z0-9]{1,3})(?![A-Z0-9])/);
  return revision ? revision[1] : null;
}

export function customerKey(name) {
  return normalizeText(name).toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !CUSTOMER_SUFFIXES.has(word))
    .join(" ");
}

export function isSameCustomer(name, customer) {
  const key = customerKey(name);
  if (!key) return false;
  return [customer.name, ...(customer.aliases || [])].some((candidate) => customerKey(candidate) === key);
}

const OXYGEN_NEGATION = "\\b(?:NOT|NON|WITHOUT|NO|EXCLUD\\w*)[\\s-]+(?:FOR\\s+)?(?:OXYGEN|O2|LOX|GOX)(?:\\s+SERVICE)?\\b";

export function scopeFlags(text) {
  const upper = normalizeText(text).toUpperCase();
  const negated = new RegExp(OXYGEN_NEGATION).test(upper);
  const positive = /\bOXYGEN\b|\bLOX\b|\bGOX\b/.test(upper.replace(new RegExp(OXYGEN_NEGATION, "g"), " "));
  let oxygen = null;
  if (negated && positive) oxygen = "conflict";
  else if (negated) oxygen = "not-for";
  else if (positive) oxygen = "for";

  let aclar = null;
  if (/\bACLAR\b/.test(upper)) aclar = /\b(?:WITHOUT|NO|NOT|EXCLUD\w*)\b[^.\n]{0,60}\bACLAR\b/.test(upper) ? "excluded" : "mentioned";

  // "300R4", "300 R 4", "100A"; a following word ("300 NOT FOR") is not a grade.
  const levelMatch = upper.match(/\bLEVEL\s*(\d{2,4})\s*(?:([A-Z])\s*(\d{1,2})|([A-Z])(?![A-Z]))?/);
  const specs = [];
  if (/CC[\s-]*1246/.test(upper)) specs.push("IEST-STD-CC1246");
  if (/MS(?:F)?C[\s-]*SPEC[\s-]*164/.test(upper)) specs.push("MSFC-SPEC-164");

  return {
    oxygen,
    aclar,
    level: levelMatch ? `${levelMatch[1]}${levelMatch[2] || levelMatch[4] || ""}${levelMatch[3] || ""}` : null,
    specs,
    returnedNotCleaned: /\bNOT\s+CLEANED\b|\bRETURN(?:ED)?\s+(?:TO\s+CUSTOMER|TO\s+[A-Z]{2,}|UNCLEANED|AS[\s-]+IS)\b|\bNO\s+CLEAN(?:ING)?\b/.test(upper),
    expedite: /\bEXPEDITE/.test(upper),
    credit: /\bCREDIT\b/.test(upper),
  };
}

// Price classification for one history record. Only "ordinary" records belong
// in normal cleaning-price comparisons; everything else stays visible with a reason.
export function classifyRecord(record, scope) {
  if (record.duplicateMarked) return { category: "duplicate-marked", reason: "description is marked duplicate in the source" };
  if (scope.returnedNotCleaned) return { category: "returned-not-cleaned", reason: "description says not cleaned / returned" };
  if (record.priceStatus === "negative" || scope.credit) return { category: "credit", reason: "negative price or credit wording" };
  if (record.priceStatus === "zero") return { category: "zero-price", reason: "zero price is not proof of free work" };
  if (record.priceStatus === "blank") return { category: "blank-price", reason: "no price in the source" };
  if (record.priceStatus === "invalid") return { category: "invalid-price", reason: `unreadable price "${record.unitPriceRaw}"` };
  return { category: "ordinary", reason: "" };
}

export function compareScope(recordScope, recordRevision, line) {
  const differences = [];
  const unknown = [];
  if (line.revision) {
    if (!recordRevision) unknown.push("revision not stated");
    else if (recordRevision !== line.revision.toUpperCase()) differences.push(`revision ${recordRevision} vs ${line.revision}`);
  }
  if (line.scope?.oxygen) {
    if (!recordScope.oxygen) unknown.push("oxygen service not stated");
    else if (recordScope.oxygen !== line.scope.oxygen) differences.push(`oxygen service: ${recordScope.oxygen} vs requested ${line.scope.oxygen}`);
  }
  if (line.scope?.level) {
    if (!recordScope.level) unknown.push("cleanliness level not stated");
    else if (recordScope.level !== line.scope.level) differences.push(`level ${recordScope.level} vs ${line.scope.level}`);
  }
  if (line.scope?.aclar && recordScope.aclar && line.scope.aclar !== recordScope.aclar) {
    differences.push(`Aclar: ${recordScope.aclar} vs requested ${line.scope.aclar}`);
  }
  return { comparable: differences.length === 0, differences, unknown };
}

// Matches one RFQ line against normalized records. `fields` names the record
// fields that carry the P/N (description) and scope (description + process +
// special instructions), so the router export and the sales export share logic.
export function matchLineHistory(records, line, customer, fields = { partText: ["description"], scopeText: ["description", "process", "special"] }) {
  const results = [];
  for (const record of records) {
    const partText = fields.partText.map((field) => record[field] || "").join("\n");
    const match = partNumberMatch(partText, line.partNumber, line.aliases || []);
    if (!match) continue;
    const scopeText = fields.scopeText.map((field) => record[field] || "").join("\n");
    const scope = scopeFlags(scopeText);
    const revision = revisionNear(partText, line.partNumber, line.aliases || []);
    const classification = classifyRecord(record, scope);
    const sameCustomer = isSameCustomer(record.customer, customer);
    const comparison = compareScope(scope, revision, line);
    let bucket;
    if (match.kind === "partial-token") bucket = "partial-token";
    else if (!sameCustomer) bucket = "other-customer";
    else if (match.kind !== "exact") bucket = "same-customer-variant";
    else bucket = "same-customer-exact";
    results.push({
      record,
      match,
      bucket,
      sameCustomer,
      revision,
      scope,
      category: classification.category,
      categoryReason: classification.reason,
      comparable: bucket === "same-customer-exact" && classification.category === "ordinary" && comparison.comparable && !comparison.unknown.length,
      differences: comparison.differences,
      unknown: comparison.unknown,
    });
  }
  return results;
}

export function summarizeMatches(matches) {
  const count = (predicate) => matches.filter(predicate).length;
  return {
    total: matches.length,
    sameCustomerExact: count((item) => item.bucket === "same-customer-exact"),
    sameCustomerVariant: count((item) => item.bucket === "same-customer-variant"),
    otherCustomer: count((item) => item.bucket === "other-customer"),
    partialToken: count((item) => item.bucket === "partial-token"),
    ordinary: count((item) => item.bucket === "same-customer-exact" && item.category === "ordinary"),
    excluded: count((item) => item.bucket === "same-customer-exact" && item.category !== "ordinary"),
    comparable: count((item) => item.comparable),
  };
}

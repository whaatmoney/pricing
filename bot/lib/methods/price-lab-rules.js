import fs from "node:fs";
import path from "node:path";
import { sha256Buffer } from "../router-snapshot.js";

// Loads the captured Price Lab source package from a private directory and
// refuses to run if any file differs from the hashes in its manifest.json.
// The rate tables are company pricing data: they are read at run time and are
// never copied into this repository.

export const RULE_FILES = {
  master: "PriceGPT-Master-v2.md",
  volume: "QPC Pricing Model - v10.2.25.csv",
  cleanliness: "Cleanliness Multipliers - v10.2.25.csv",
  cleanlinessReference: "Cleanliness Levels Reference - v10.2.25.csv",
  geometry: "Internal Geometry Multipliers - v10.2.25.csv",
  cavity: "Cavity Tiers - v10.2.25.csv",
  specFees: "Spec-Based Fixed Charges - v10.2.25.csv",
  packaging: "Packaging Charges - v10.2.25.csv",
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function dollars(text) {
  const value = Number(String(text).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(value)) throw new Error(`Not a dollar amount: ${text}`);
  return value;
}

function requireMatch(text, pattern, label) {
  const match = text.match(pattern);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value)) throw new Error(`PriceGPT master no longer states ${label}; review the method before pricing.`);
  return value;
}

export function loadPriceLabRules(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const expected = Object.fromEntries(manifest.sources.map((source) => [path.basename(source.snapshot_path), source.sha256]));
  const text = {};
  const hashes = {};
  const problems = [];
  for (const [key, name] of Object.entries(RULE_FILES)) {
    const buffer = fs.readFileSync(path.join(dir, name));
    hashes[key] = sha256Buffer(buffer);
    if (!expected[name]) problems.push(`${name} is not listed in manifest.json`);
    else if (expected[name] !== hashes[key]) problems.push(`${name} hash ${hashes[key]} does not match manifest ${expected[name]}`);
    text[key] = buffer.toString("utf8");
  }
  if (problems.length) throw new Error(`Price Lab source package failed verification:\n- ${problems.join("\n- ")}`);

  const table = (key) => parseCsv(text[key]).slice(1);
  return {
    version: "PriceGPT-Master-v2 with v10.2.25 tables",
    capturedAt: manifest.captured_at,
    directory: dir,
    hashes,
    laborRate: requireMatch(text.master, /fixed internal labor rate of \$(\d+(?:\.\d+)?)\/hr/i, "the SQ3 labor rate"),
    baseMinimum: requireMatch(text.master, /Base price minimum = \$(\d+(?:\.\d+)?)/i, "the base price minimum"),
    volumeBuffer: requireMatch(text.master, /Buffered Volume = Raw x (\d+(?:\.\d+)?)/i, "the volume buffer"),
    lotMinimum: requireMatch(text.master, /PO minimum = \$(\d+(?:\.\d+)?)/i, "the PO minimum"),
    volumeTable: table("volume").map(([min, max, base]) => ({ min: Number(min), max: Number(max), base: dollars(base) })),
    cleanliness: Object.fromEntries(table("cleanliness").map(([level, multiplier]) => [level.trim(), Number(multiplier)])),
    geometry: Object.fromEntries(table("geometry").map(([name, multiplier]) => [name.trim(), Number(multiplier)])),
    cavityTiers: Object.fromEntries(table("cavity").map(([tier, charge]) => [tier.trim(), Number(charge)])),
    specFees: table("specFees").map(([specification, fee]) => ({ specification: specification.trim(), fee: dollars(fee) })),
    packagingPerSquareFoot: Object.fromEntries(table("packaging").map(([type, rate]) => [type.trim(), dollars(rate)])),
  };
}

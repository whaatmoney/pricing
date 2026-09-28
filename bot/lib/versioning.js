import fs from "node:fs";
import path from "node:path";

// Recommendation versions: the same inputs rewrite the same version; any
// change in inputs (case facts, evidence, snapshot, rules) creates the next
// version and records which one it supersedes. Approvals and sent quotes are
// separate records, so a new version never overwrites them.
export function versionsOf(outputsDir, stem) {
  const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-v(\\d+)\\.json$`);
  return fs.readdirSync(outputsDir)
    .map((name) => name.match(pattern))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
}

export function nextVersion(outputsDir, stem, fingerprint) {
  const existing = versionsOf(outputsDir, stem);
  if (!existing.length) return { version: 1, reused: false, supersedes: null };
  const latest = existing[0];
  const previous = JSON.parse(fs.readFileSync(path.join(outputsDir, `${stem}-v${latest}.json`), "utf8"));
  if (previous.inputsFingerprint === fingerprint) return { version: latest, reused: true, supersedes: previous.lifecycle?.supersedes ?? null };
  return { version: latest + 1, reused: false, supersedes: latest };
}

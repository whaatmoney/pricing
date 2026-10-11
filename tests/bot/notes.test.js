import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { noteSubject, notesSection, readNotes } from "../../bot/lib/notes.js";

const decision = { caseId: "acme-123-2026-10-09", lifecycle: { recommendationVersion: 2 } };
const feedback = { to: "owner@shop.example", tag: "QPC pricing note" };

test("the notes box tags the email with the case and version it was written on", () => {
  const html = notesSection(decision, { feedback });
  assert.equal(noteSubject("QPC pricing note", decision.caseId, 2), "[QPC pricing note] acme-123-2026-10-09 v2");
  assert.match(html, /data-note-to="owner@shop\.example"/);
  assert.match(html, /data-note-subject="\[QPC pricing note\] acme-123-2026-10-09 v2"/);
  assert.match(html, /data-note-send/);
});

test("notes show with Claude's answer, escaped; no box and no notes means no section", () => {
  const notes = [{ caseId: decision.caseId, version: 1, at: "2026-10-09T16:00:00Z", fromName: "Tyler", text: "Size is <4 x 4> in", status: "applied", response: "Rebuilt as v2 with 4 x 4 x 2 in." }];
  const html = notesSection(decision, { notes, feedback: null });
  assert.match(html, /Size is &lt;4 x 4&gt; in/);
  assert.match(html, /Rebuilt as v2/);
  assert.match(html, /chip ok">Applied</);
  assert.doesNotMatch(html, /data-note-send/, "no address configured, no send button");
  assert.equal(notesSection(decision, {}), "");
});

test("readNotes keeps only this case's notes, oldest first, and tolerates a missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
  const file = path.join(dir, "notes.json");
  fs.writeFileSync(file, JSON.stringify({ notes: [
    { caseId: decision.caseId, at: "2026-10-09T18:00:00Z", text: "second" },
    { caseId: "other", at: "2026-10-09T17:00:00Z", text: "other case" },
    { caseId: decision.caseId, at: "2026-10-09T16:00:00Z", text: "first" },
  ] }));
  assert.deepEqual(readNotes(file, decision.caseId).map((note) => note.text), ["first", "second"]);
  assert.deepEqual(readNotes(path.join(dir, "missing.json"), decision.caseId), []);
  assert.deepEqual(readNotes(null, decision.caseId), []);
});

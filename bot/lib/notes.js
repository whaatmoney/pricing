import fs from "node:fs";
import { ICON } from "./design.js";
import { escapeHtml as esc } from "./render.js";

// Notes the pricing owners leave on a price page for Claude. The page cannot
// store anything itself, so "Send to Claude" opens an email to the address in
// the private config (config.feedback.to) with a tagged subject; the scheduled
// pricing run reads those emails, acts on each note, and writes what it did
// back to the notes file (config.feedback.file), which this page then shows.
// Nothing here records a decision.

const STATUS = {
  new: ["warn", "Waiting for the next run"],
  applied: ["ok", "Applied"],
  lesson: ["ok", "Saved as a standing lesson"],
  "applied+lesson": ["ok", "Applied and saved as a lesson"],
  "needs-code": ["alert", "Needs a code change"],
  answered: ["ok", "Answered"],
  "no-change": ["muted", "No change"],
  held: ["muted", "Held for Tyler"],
};

export const noteSubject = (tag, caseId, version) => `[${tag}] ${caseId} v${version}`;

// Every note for one case, oldest first. A missing or unreadable file means no notes.
export function readNotes(file, caseId) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return (data.notes || []).filter((note) => String(note.caseId).toLowerCase() === String(caseId).toLowerCase()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  } catch { return []; }
}

const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "");

export function notesSection(decision, { notes = [], feedback = null } = {}) {
  if (!feedback?.to && !notes.length) return "";
  const items = notes.map((note) => {
    const [tone, label] = STATUS[note.status] || STATUS.new;
    return `<li class="note">
      <div class="note-head"><span class="chip ${tone}">${esc(label)}</span><span class="muted small">${esc(note.fromName || note.from || "")} · ${esc(when(note.at))} · on v${esc(note.version ?? "?")}</span></div>
      <p class="note-text">${esc(note.text)}</p>
      ${note.response ? `<p class="note-reply">${ICON.check}<span><b>Claude${note.respondedAt ? `, ${esc(when(note.respondedAt))}` : ""}:</b> ${esc(note.response)}</span></p>` : ""}
    </li>`;
  }).join("");
  const subject = feedback?.to ? noteSubject(feedback.tag || "QPC pricing note", decision.caseId, decision.lifecycle.recommendationVersion) : "";
  const form = feedback?.to ? `<div class="note-form" data-note-to="${esc(feedback.to)}" data-note-subject="${esc(subject)}">
      <label class="small muted" for="note-text">What is wrong or missing, in your words. Say whether it is only for this RFQ or a rule for every RFQ like it.</label>
      <textarea id="note-text" rows="4" placeholder="e.g. Size is 4 x 4 x 2 in from the print. / For this customer, always use our last quote even if it is over a year old."></textarea>
      <div><button type="button" class="btn primary" data-note-send>${ICON.external}<span>Send to Claude</span></button></div>
      <p class="small muted">Opens an email to yourself with this page's tag. Press Send; the next scheduled pricing run reads it, fixes this page or saves the rule, and answers here.</p>
    </div>` : "";
  return `<section id="notes" class="panel" aria-labelledby="notes-title">
    <h2 id="notes-title">Notes for Claude</h2>
    ${items ? `<ul class="notes">${items}</ul>` : ""}
    ${form}
  </section>`;
}

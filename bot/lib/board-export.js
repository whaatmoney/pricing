import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { caseGroup, triageGroup } from "./board.js";
import { lineQuoteEmailAt } from "./sent-quote.js";

// A read-only copy of the board as two CSV files, for a reader that cannot
// open the board itself (an assistant that reads a shared folder). One row
// per part and quantity. The files are written by this code from the same
// board the pages are drawn from, so no figure is retyped, and nothing here
// writes to a record, a decision or the board.
//
// Open requests and sent quotes are kept apart so the reader can take the
// short file for most questions:
//   rfq-open.csv     every request still owed a price or its quote, the
//                    ones the board lists with no price page yet included
//   rfq-history.csv  every request whose quote went out, newest first
// Both names are stable: each run overwrites the file, and only when its
// text has changed.
export const OPEN_EXPORT = "rfq-open.csv";
export const HISTORY_EXPORT = "rfq-history.csv";

export const EXPORT_COLUMNS = [
  "board_as_of", "rfq_id", "status", "customer", "end_user", "contact", "rfq_reference",
  "part_number", "revision", "description", "quantity", "material", "spec_callouts",
  "price_kind", "unit_price", "extended", "lot_minimum", "lot_minimum_applies_to", "lot_charge",
  "expedite", "lead_time", "customer_need", "priced_by",
  "asked", "decided", "sent", "price_quote_date", "due", "last_activity",
  "missing_facts", "price_basis", "confidence", "copy_id",
];

// What a price in the row is. A reader must be able to tell a price a person
// decided and the customer was sent from one the board only suggests, and
// from a decided price nothing shows was the one on the quote.
export const PRICE_KINDS = {
  quoted: "quoted",
  unconfirmed: "decided - not confirmed as the quoted price",
  decided: "decided - quote not seen sent",
  suggestedSent: "suggested - quoted price not recorded",
  suggested: "suggested - not decided",
  none: "none",
};

const STATUS = {
  ready: "open - ready for a price decision",
  facts: "open - needs facts",
  decided: "decided - quote not seen sent",
  sent: "quote sent",
  reopened: "open again - price question after the quote",
};

const ZONE = "America/Los_Angeles";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const valid = (iso) => Boolean(iso) && !Number.isNaN(Date.parse(iso));
const time = (iso) => (valid(iso) ? Date.parse(iso) : null);
// A day as the shop's calendar has it; a date with no time is kept as written.
const day = (iso) => (!iso ? "" : DATE_ONLY.test(iso) ? iso : valid(iso) ? new Date(iso).toLocaleDateString("en-CA", { timeZone: ZONE }) : "");
const minute = (iso) => {
  if (!valid(iso)) return "";
  const at = new Date(iso);
  return `${at.toLocaleDateString("en-CA", { timeZone: ZONE })} ${at.toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" })} PT`;
};

// One line of plain text: a record never spans lines, so a reader that takes
// the file a page at a time always gets whole rows. Nothing is cut short: the
// reader cannot open the board to find what a shortened cell left out.
const plain = (value) => (value === null || value === undefined ? "" : String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim());
const cents = (value) => Math.round(Number(value) * 100) / 100;

// How far the board's reading of customer mail reaches: the age of the copy,
// whenever it happened to be written. With two mail sources the copy is only
// as current as the one further behind. A source the board has (a mail check,
// a monitor in use) that gives no time makes the age unknown, and so does
// having none: the cell is left empty. The time of a sync is never used: a
// sync reads no mail.
export function boardAsOf(board) {
  const sources = [board.claudeMail, board.monitor].filter(Boolean);
  if (!sources.length || !sources.every((source) => valid(source.cutoff))) return "";
  return minute(sources.map((source) => source.cutoff).sort((x, y) => Date.parse(x) - Date.parse(y))[0]);
}

// When the sent quote a decided price was read from went out, or null. This is
// the only proof that a price is the one a customer was sent: from-sent read
// it out of the sent quote, and the board's own strict reading of that note
// accepts it (lineQuoteEmailAt: this request's email, this part, this very
// quantity, this very price). Dates prove nothing here. A price decided by
// hand before the case's quote went out was probably the one on it, but the
// case's sent date can come from a customer's receipt note, and a price
// recorded after a quote may be a revision still to send; both are exported
// as decided and not confirmed.
const quoteReadFrom = (record, saved, decided) => (record && saved ? lineQuoteEmailAt(record, saved, decided) : null);

function readRecord(outputsDir, kase) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputsDir, String(kase.page).replace(/\.html$/, ".json")), "utf8"));
  } catch {
    return null;
  }
}

// The request's process callout in its own words, then the cleanliness level
// the record holds, always and labelled: the words may only seem to give it
// (a specification number can hold the same digits).
function callouts(request) {
  const words = plain(request.process?.verbatim);
  const level = plain(request.scope?.level);
  return [words, level ? `cleanliness level: ${level}` : ""].filter(Boolean).join(" | ");
}

// The newest the board has from the customer after the request itself: a
// later ask on the saved record, a chase the mail check attached to the card,
// or one the front desk logged against it.
function lastActivity(kase) {
  const later = kase.chasedAt && kase.chasedAt !== kase.askedAt ? kase.chasedAt : null;
  return [later, kase.mailChase?.at, kase.followup?.lastAt].filter((iso) => iso && (DATE_ONLY.test(iso) || valid(iso))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function statusOf(kase) {
  if (kase.open && kase.reopened) return STATUS.reopened;
  return STATUS[caseGroup(kase)];
}

// The rows of one request. `record` is its saved decision record, which holds
// the request's own words (material, callouts, lead time); without it the row
// still goes out with what the board knows, so no request is ever left off.
export const caseRows = (kase, record, asOf = "") => caseExport(kase, record, asOf).rows;

// The rows, and with them the dates of the sent quotes their prices were read
// from (for ordering the history).
function caseExport(kase, record, asOf) {
  const quoteDates = [];
  const group = caseGroup(kase);
  const wentOut = group === "sent" || Boolean(kase.reopened);
  const reference = kase.monitorReference && !String(kase.reference || "").includes(kase.monitorReference) ? `${kase.reference || ""} [${kase.monitorReference}]` : kase.reference;
  const order = record?.poLotMinimum || null;
  const rows = kase.lines.map((line) => {
    const saved = (record?.lines || []).find((item) => item.lineId === line.lineId) || null;
    const request = saved?.request || {};
    const decided = line.decided && line.decided.choice !== "correction" && line.decided.unitPrice != null ? line.decided : null;
    const correction = line.decided?.choice === "correction" ? line.decided : null;
    const unit = decided ? decided.unitPrice : line.suggested;
    const quoteAt = decided ? quoteReadFrom(record, saved, decided) : null;
    if (quoteAt) quoteDates.push(quoteAt);
    const kind = decided ? (!wentOut ? PRICE_KINDS.decided : quoteAt ? PRICE_KINDS.quoted : PRICE_KINDS.unconfirmed) : unit != null ? (wentOut ? PRICE_KINDS.suggestedSent : PRICE_KINDS.suggested) : PRICE_KINDS.none;
    const lineMinimum = saved?.recommendation?.lotMinimum?.minimum ?? null;
    const minimum = lineMinimum ?? order?.minimum ?? null;
    const basis = decided
      ? decided.choice === "approved" ? `approved: ${decided.recommended?.label || "the suggested price"}` : `reviewer's own price${decided.option ? `: ${decided.option}` : ""}`
      : line.source?.text;
    return {
      board_as_of: asOf,
      rfq_id: kase.caseId,
      status: statusOf(kase),
      customer: plain(kase.customer),
      end_user: plain(kase.customerRecord?.endUser),
      contact: plain(kase.email?.fromName ? `${kase.email.fromName} <${kase.email.from}>` : kase.email?.from),
      rfq_reference: plain(reference),
      part_number: plain(line.partNumber),
      revision: plain(request.revision),
      description: plain(request.description),
      quantity: line.quantity ?? "",
      material: plain(request.material?.value),
      spec_callouts: plain(callouts(request)),
      price_kind: kind,
      unit_price: unit ?? "",
      extended: unit == null || line.quantity == null ? "" : decided && decided.extended != null && decided.quantity === line.quantity ? decided.extended : cents(unit * line.quantity),
      lot_minimum: minimum ?? "",
      lot_minimum_applies_to: minimum == null ? "" : lineMinimum != null ? "line" : "order",
      lot_charge: (decided ? decided.lotCharge : unit != null ? line.lotCharge : null) ?? "",
      expedite: plain(record?.commercial?.expediteEvidence),
      lead_time: plain(record?.commercial?.standardLeadTime),
      customer_need: plain(record?.rfq?.urgency),
      priced_by: plain(decided?.decidedBy),
      asked: day(kase.askedAt),
      decided: day(decided?.decidedAt),
      sent: day(kase.lastSentAt),
      price_quote_date: day(quoteAt),
      due: day(kase.dueDate),
      last_activity: day(lastActivity(kase)),
      missing_facts: plain([Array.isArray(line.missing) ? line.missing.join("; ") : line.missing, correction ? `correction recorded: ${correction.note || "see the price page"}` : null].filter(Boolean).join("; ")),
      price_basis: plain(basis),
      confidence: plain(kase.confidence?.level),
      copy_id: "",
    };
  });
  return { rows, quoteDates };
}

// Newest first, an undated one ahead of the dated; the request id settles a tie
// so the same board always writes the same file.
const newestFirst = (pick) => (a, b) => {
  const [x, y] = [time(pick(a)), time(pick(b))];
  if (x !== y) return x === null ? -1 : y === null ? 1 : y - x;
  return String(a.caseId).localeCompare(String(b.caseId));
};

// ---- Requests the board lists with no price page ---------------------------
// The board also shows what has no page yet: messages the mail check found,
// front-desk chases, and (while a mail monitor is in use) its own lists. Each
// gets a row in the open file with what is known and no price, so a request
// that came in an hour ago is not missing from the copy. One the reviewer's
// triage set aside as not a price request is still listed, marked so, exactly
// as the board keeps it folded rather than dropping it.
const NO_PAGE = {
  rfq: "open - no price page yet (request)",
  secure: "open - no price page yet (protected message)",
  followup: "open - no price page yet (chase)",
  question: "open - no price page yet (question)",
  chat: "open - no price page yet (front desk chase)",
  monitor: "open - no price page yet (mail monitor)",
  owed: "open - quote still owed, no price page (mail monitor)",
  reopened: "open again - price question after the quote, no price page (mail monitor)",
};

export function noPageRows(board, asOf = boardAsOf(board)) {
  const blank = { ...Object.fromEntries(EXPORT_COLUMNS.map((column) => [column, ""])), board_as_of: asOf, price_kind: PRICE_KINDS.none };
  // The board's own set-aside test (renderBoard): the triage entry for the
  // row's key, unless the row has activity newer than the check.
  const setAside = (key, lastAt) => { const entry = (board.triage || {})[key]; return entry && (!lastAt || String(lastAt) <= String(entry.at)) ? entry : null; };
  const rows = [];
  const add = (at, status, entry, fields) => rows.push({ at, aside: Boolean(entry), row: { ...blank, ...fields, status: entry ? `set aside - ${triageGroup(entry.reason)}` : status } });
  for (const item of board.mailFound || []) {
    const chase = item.kind === "followup" || item.kind === "question";
    const own = item.monitor && item.monitor.matchedBy !== "customer" ? item.monitor : null;
    // Chases are never set aside by triage on the board; requests and protected messages can be.
    const entry = chase ? null : setAside(`mail|${item.customerDomain}|${String(item.subject).replace(/^(re|fw|fwd):\s*/gi, "")}`, item.at);
    add(item.at, NO_PAGE[item.kind] || NO_PAGE.rfq, entry, {
      customer: plain(item.monitor?.customer || item.customerDomain),
      contact: plain(item.from),
      rfq_reference: plain([item.subject, own?.reference ? `[${own.reference}]` : null].filter(Boolean).join(" ")),
      part_number: plain((item.partNumbers || []).join("; ")),
      description: plain(item.note),
      asked: chase ? "" : day(item.at),
      due: day(item.dueDate || own?.dueDate),
      last_activity: day(item.at),
    });
  }
  for (const thread of board.chasing?.unmatched || []) {
    add(thread.lastAt || thread.firstAt, NO_PAGE.chat, null, {
      customer: plain(thread.company),
      contact: plain(thread.contact),
      rfq_reference: plain(thread.subject),
      description: plain(thread.note || thread.label),
      asked: day(thread.firstAt),
      last_activity: day(thread.lastAt),
    });
  }
  for (const [list, status] of [["withoutPage", NO_PAGE.monitor], ["owed", NO_PAGE.owed], ["openAfterQuote", NO_PAGE.reopened]]) {
    for (const item of board.monitor?.[list] || []) {
      add(item.lastActivityAt, status, setAside(`monitor|${item.customer}|${item.reference}`, item.lastActivityAt), {
        customer: plain(item.customer),
        contact: plain(item.email?.fromName && item.email?.from ? `${item.email.fromName} <${item.email.from}>` : item.email?.from),
        rfq_reference: plain(item.reference),
        description: plain(item.status),
        due: day(item.dueDate),
        last_activity: day(item.lastActivityAt),
      });
    }
  }
  // Still to act on first, newest first; set aside last. The text settles a tie.
  const order = newestFirst((item) => item.at);
  return rows
    .sort((a, b) => Number(a.aside) - Number(b.aside) || order({ ...a, caseId: a.row.rfq_reference }, { ...b, caseId: b.row.rfq_reference }))
    .map((item) => item.row);
}

// Every case on the board lands in exactly one of the two lists, and every
// row the board lists with no page lands in the open one.
export function exportRows(board, { outputsDir = null, read = (kase) => (outputsDir ? readRecord(outputsDir, kase) : null) } = {}) {
  const asOf = boardAsOf(board);
  const built = board.cases.map((kase) => ({ kase, ...caseExport(kase, read(kase), asOf) }));
  // A sent case is ordered by its newest known quote: the last one seen sent,
  // or a later one a price was read from.
  const sentAt = ({ kase, quoteDates }) => [kase.lastSentAt, ...quoteDates].filter(valid).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  const pick = (keep, at) => built.filter(({ kase }) => keep(caseGroup(kase) === "sent")).map((item) => ({ ...item, caseId: item.kase.caseId, at: at(item) })).sort(newestFirst((item) => item.at)).flatMap((item) => item.rows);
  const noPage = noPageRows(board, asOf);
  return { open: [...pick((sent) => !sent, ({ kase }) => kase.askedAt), ...noPage], history: pick((sent) => sent, sentAt), noPage: noPage.length };
}

// A cell a spreadsheet would run as a formula is written as text. A leading
// minus is left alone: part numbers begin with one.
const cell = (value) => {
  let text = typeof value === "number" ? String(value) : plain(value);
  if (typeof value !== "number" && /^[=+@]/.test(text)) text = `'${text}`;
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const toCsv = (rows) => `${[EXPORT_COLUMNS.join(","), ...rows.map((row) => EXPORT_COLUMNS.map((column) => cell(row[column])).join(","))].join("\n")}\n`;

// ---- The two files as one copy ---------------------------------------------
// A reader takes the files one at a time, and a synced folder can deliver one
// before the other, so it must be able to tell that the two it holds belong
// together and that each is whole:
//  - every row of both files carries the same `copy_id`, made from the rows of
//    both, so it changes exactly when either file's content does (and then
//    both files are written);
//  - each file ends with one marker row that is not a request: its status
//    says END OF FILE and how many rows stand above it, and it carries the
//    copy_id even when the file has no other row.
// Two files with different copy_ids are from different moments: read again.
export const END_OF_FILE = /^END OF FILE - (\d+) rows? above - not a request$/;
export function exportTexts(board, options = {}) {
  const { open, history, noPage } = exportRows(board, options);
  const copyId = crypto.createHash("sha256").update(JSON.stringify([open, history])).digest("hex").slice(0, 10);
  const asOf = boardAsOf(board);
  const text = (rows) => toCsv([
    ...rows.map((row) => ({ ...row, copy_id: copyId })),
    { board_as_of: asOf, status: `END OF FILE - ${rows.length} ${rows.length === 1 ? "row" : "rows"} above - not a request`, copy_id: copyId },
  ]);
  return { open: text(open), history: text(history), copyId, rows: { open: open.length, history: history.length }, noPage };
}

// The fields of one written line (the reverse of `cell`'s quoting), and the
// request ids a written file holds.
function fieldsOf(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { fields.push(field); field = ""; }
    else field += char;
  }
  return [...fields, field];
}
const ID_COLUMN = EXPORT_COLUMNS.indexOf("rfq_id");
const linesOf = (text) => String(text || "").split("\n").slice(1).filter(Boolean);
const idOf = (line) => fieldsOf(line)[ID_COLUMN] || "";
const idsIn = (text) => new Set(linesOf(text).map(idOf).filter(Boolean));

// The writes, in an order that never leaves a request out of both files while
// they are being written: a file that gains a request is written before the
// file that loses it. When each file both gains and loses (one request's
// quote goes out as another's reopens), the history is first written with the
// requests it is about to lose still in it, then the open file, then the
// history as it should be.
function writePlan(open, history) {
  const leaves = (from, to) => [...idsIn(from.before)].filter((id) => !idsIn(from.text).has(id) && idsIn(to.text).has(id));
  const leavingHistory = new Set(leaves(history, open));
  const leavingOpen = leaves(open, history);
  if (!leavingHistory.size) return [[history, history.text], [open, open.text]];
  if (!leavingOpen.length) return [[open, open.text], [history, history.text]];
  const lines = history.text.trimEnd().split("\n");
  const marker = lines.pop();
  const kept = linesOf(history.before).filter((line) => leavingHistory.has(idOf(line)));
  return [[history, `${[...lines, ...kept, marker].join("\n")}\n`], [open, open.text], [history, history.text]];
}

// One writer at a time per folder, across processes: the background sync and
// a command run by hand can both rebuild the board, and two of them reading
// and writing the pair in turns could leave a case that moved in neither file.
// The lock is a file in the system's temporary folder (never in the synced
// folder), named for the folder itself (its real path, so a symlink to it
// shares the lock) and holding the writer's process id and a token of its own.
// It is made whole and then linked into place, so it is never seen half
// written. Only a lock whose process is gone is taken over; a live writer
// keeps it however long it takes. A writer that cannot get the lock within
// `waitMs` gives up with an error and writes nothing: the files stay a whole
// copy and the next rebuild writes them.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const realDir = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
export const exportLockPath = (exportDir) => path.join(os.tmpdir(), `board-export-${crypto.createHash("sha256").update(realDir(exportDir)).digest("hex").slice(0, 16)}.lock`);
// What the lock file holds now; null when there is none. Any other trouble reading it is thrown.
const lockHolder = (lock) => { try { return fs.readFileSync(lock, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
function withExportLock(exportDir, { waitMs = 10000 } = {}, work) {
  const lock = exportLockPath(exportDir);
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const mine = `${lock}.${token.replace(":", ".")}`;
  const deadline = Date.now() + waitMs;
  fs.writeFileSync(mine, token);
  try {
    for (;;) {
      try {
        fs.linkSync(mine, lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      // Every turn of the loop is bounded by the deadline.
      if (Date.now() >= deadline) throw new Error(`another board export is writing to this folder; nothing written, the next rebuild will write it (lock: ${lock})`);
      const holder = lockHolder(lock);
      const pid = holder === null ? null : Number(holder.split(":")[0]);
      // Its writer is gone: remove it, if it is still that writer's, and try again.
      if (Number.isInteger(pid) && pid > 0 && !alive(pid) && lockHolder(lock) === holder) fs.rmSync(lock, { force: true });
      else pause(50);
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }
  try {
    return work();
  } finally {
    // Only its own lock is released.
    try { if (lockHolder(lock) === token) fs.rmSync(lock, { force: true }); } catch { /* left for the next writer to find its process gone */ }
  }
}

// Writes both files into `exportDir`. When neither file's text has changed
// nothing is written, so a sync that finds nothing new does not make the
// folder's own sync upload them again. The two files are one copy: a case
// that moves from one to the other must never be left in neither. So, under
// the folder's lock, both are read first and written in an order that keeps
// every request in at least one of them (writePlan), and if a write fails,
// every file a write was begun on is put back as it was (a failed write may
// already have emptied its file) and the error is thrown: the pair stays the
// last whole copy, with its older board_as_of. A file that cannot be put back
// is named in the error. The files are written in place (the same items in a
// synced folder), not swapped in by rename. `write` and `lock` are for tests.
export function writeBoardExport({ outputsDir, exportDir, board, write = fs.writeFileSync, lock = {} }) {
  const texts = exportTexts(board, { outputsDir });
  const { noPage } = texts;
  const open = { length: texts.rows.open };
  const history = { length: texts.rows.history };
  fs.mkdirSync(exportDir, { recursive: true });
  return withExportLock(exportDir, lock, () => {
    const [openFile, historyFile] = [[OPEN_EXPORT, texts.open], [HISTORY_EXPORT, texts.history]].map(([name, text]) => {
      const file = path.join(exportDir, name);
      return { name, file, text, before: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
    });
    const begun = [];
    try {
      for (const [item, text] of writePlan(openFile, historyFile).filter(([entry]) => entry.before !== entry.text)) {
        if (!begun.includes(item)) begun.push(item);
        write(item.file, text);
      }
    } catch (error) {
      const lost = [];
      for (const item of begun) {
        try {
          if (item.before === null) fs.rmSync(item.file, { force: true });
          else fs.writeFileSync(item.file, item.before);
        } catch {
          lost.push(item.name);
        }
      }
      if (lost.length) error.message = `${error.message}; and ${lost.join(" and ")} could not be put back as it was: check the folder`;
      throw error;
    }
    const written = [OPEN_EXPORT, HISTORY_EXPORT].filter((name) => begun.some((item) => item.name === name));
    return { written, rows: { open: open.length, history: history.length }, cases: board.cases.length, noPage, copyId: texts.copyId };
  });
}

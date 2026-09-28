import { customerWorkOrder } from "./decision.js";
import { matchLineHistory } from "./part-history.js";

// The customer's own job numbers on QPC work orders for a part, so each one can
// be searched in mail. A customer PO whose subject and file name leave out the
// part number (or whose PDF spaces it out) is still found by its job number.
// Both forms ("WO NO: W1-100", "JOB NO: 1234-1") are read by the decision's own
// parser, so this list and the job cross-check always agree.

export const customerJobNumber = customerWorkOrder;

// PDF text often spaces out hyphens ("W1- 100"), so both sides are compared
// with the space around hyphens removed and the job read as a whole token.
const tightHyphens = (text) => String(text || "").replace(/\s*-\s*/g, "-").toUpperCase();

export function mentionsJob(text, job) {
  const escaped = tightHyphens(job).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Z0-9-])${escaped}(?![0-9])`).test(tightHyphens(text));
}

const messageText = (message) => [message.subject, message.body, ...(message.attachments || []).map((item) => `${item.name}\n${item.text || ""}`)].join("\n");

// For each part number in the case (quantity tiers of one part share a list):
// every job number on the same customer's exact-part work orders, the work
// orders and prices behind it, and the saved evidence messages that mention
// it. Jobs that no message mentions are the searches still to run.
export function customerJobs({ records, lines, customer, messages = [] }) {
  const parts = new Map();
  for (const line of lines) {
    const key = JSON.stringify([line.partNumber, ...(line.aliases || []).map((alias) => alias.value ?? alias)]);
    if (!parts.has(key)) parts.set(key, { line, lineIds: [] });
    parts.get(key).lineIds.push(line.lineId);
  }
  return [...parts.values()].map(({ line, lineIds }) => {
    const jobs = new Map();
    let withoutJob = 0;
    for (const match of matchLineHistory(records, line, customer)) {
      if (match.bucket !== "same-customer-exact") continue;
      const job = customerJobNumber(match.record.description);
      if (!job) {
        withoutJob += 1;
        continue;
      }
      if (!jobs.has(job)) jobs.set(job, { job, firstReceived: null, workOrders: [] });
      const item = jobs.get(job);
      item.workOrders.push({ wo: match.record.wo, received: match.record.received, unitPrice: match.record.unitPrice, category: match.category });
      if (match.record.received && (!item.firstReceived || match.record.received < item.firstReceived)) item.firstReceived = match.record.received;
    }
    const list = [...jobs.values()].map((item) => ({
      ...item,
      mentionedIn: messages.filter((message) => mentionsJob(messageText(message), item.job))
        .map((message) => ({ id: message.id, mailbox: message.mailbox, receivedAt: message.receivedAt, subject: message.subject })),
    })).sort((a, b) => (b.firstReceived || "").localeCompare(a.firstReceived || ""));
    return {
      lineIds,
      partNumber: line.partNumber,
      jobs: list,
      recordsWithoutJobNumber: withoutJob,
      searchNext: list.filter((item) => !item.mentionedIn.length).map((item) => item.job),
    };
  });
}

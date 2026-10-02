import { otherCustomerBasis } from "./other-customer.js";

// Recommendation policies. Each is named and versioned so a decision record
// always says which rule picked its preferred price. No policy here approves a
// price or sends anything; the output is a recommendation for a person.

export const POLICIES = {
  "repeat-accepted-hold-v0": {
    status: "APPROVED 2026-09-27 by the Quality Manager (pricing owner)",
    approved: { date: "2026-09-27", by: "Quality Manager (pricing owner)" },
    rule: "When the same customer issued a purchase order within 365 days for the exact part number (any revision) and same process scope, at a quantity within ±25% of the request, recommend that PO's unit price and show the Price Lab chain beside it. Otherwise QPC's previous quote to this customer for the part (previous-quote-hold-v1), then the newest price another customer was charged or quoted for the same part number within 365 days (other-customer-hold-v1), then the Price Lab chain result. When neither exists, leave the price uncalculated and name the missing fact.",
  },
  "chain-only-v0": {
    status: "PriceGPT-Master-v2 as written",
    rule: "Recommend the SQ5 settled price (SQ6 still to be run by a reviewer). History is shown but never selects the price.",
  },
};

const DAY = 86400000;

export function acceptedRepeatPrice(purchaseOrders, line, requestDate) {
  const eligible = purchaseOrders.filter((po) => {
    const ageDays = (Date.parse(requestDate) - Date.parse(po.date)) / DAY;
    return po.comparable
      && po.unitPrice > 0
      && ageDays >= 0 && ageDays <= 365
      && po.quantity != null
      && Math.abs(po.quantity - line.quantity) / line.quantity <= 0.25;
  });
  eligible.sort((a, b) => b.date.localeCompare(a.date) || (b.revision || 0) - (a.revision || 0));
  return { latest: eligible[0] || null, eligible };
}

// Ruling previous-quote-hold-v1: when QPC already quoted this customer this
// exact part, the newest such quote (within 365 days) is matched. Any quantity
// qualifies; among the newest quote's rows the closest quantity is used. A quote
// that differs in anything but quantity (scope, oxygen service) does not.
export function previousQuote(sentQuotes, line, requestDate) {
  const eligible = sentQuotes.filter((quote) => {
    const ageDays = (Date.parse(requestDate) - Date.parse(quote.date)) / DAY;
    return quote.unitPrice > 0
      && ageDays >= 0 && ageDays <= 365
      && quote.status !== "excluded"
      && quote.differences.every((item) => item.startsWith("quantity "));
  });
  if (!eligible.length) return { latest: null, eligible };
  const newest = eligible.reduce((date, quote) => (quote.date > date ? quote.date : date), "");
  const distance = (quote) => (quote.quantity == null ? Number.POSITIVE_INFINITY : Math.abs(quote.quantity - line.quantity));
  const latest = eligible.filter((quote) => quote.date === newest).sort((a, b) => distance(a) - distance(b))[0];
  return { latest, eligible };
}

const money = (value) => Math.round(value * 100) / 100;

export function recommend({ policyId, line, requestDate, purchaseOrders, sentQuotes = [], chain, otherCustomer = null }) {
  const policy = POLICIES[policyId];
  if (!policy) throw new Error(`Unknown recommendation policy "${policyId}"`);
  const repeat = acceptedRepeatPrice(purchaseOrders, line, requestDate);
  const quoted = previousQuote(sentQuotes, line, requestDate);
  const quoteOption = (quote) => option(`Match QPC's previous quote (${quote.date})`, quote.unitPrice, `PREVIOUS-QUOTE: QPC quoted ${quote.quantity ?? "an unstated quantity of"} pcs at $${quote.unitPrice.toFixed(2)} on ${quote.date} (${quote.evidence}); rule previous-quote-hold-v1`);
  const chainPrice = chain?.settled ?? null;
  const alternatives = [];
  const option = (label, unitPrice, basis) => ({ label, unitPrice, extended: money(unitPrice * line.quantity), basis });
  const other = otherCustomer?.latest || null;
  const otherOption = (candidate) => option(`Another customer's price (${candidate.customer}, ${candidate.date})`, candidate.unitPrice, otherCustomerBasis(candidate));

  let preferred = null;
  if (policyId === "repeat-accepted-hold-v0" && repeat.latest) {
    const po = repeat.latest;
    preferred = option(`Hold the customer's accepted price from ${po.poNumber}${po.revision ? ` Rev. ${po.revision}` : ""}`, po.unitPrice, `REPEAT-ACCEPTED: customer PO ${po.poNumber} dated ${po.date}, ${po.quantity} pcs at $${po.unitPrice.toFixed(2)}, same part, revision and process scope`);
    if (quoted.latest) alternatives.push(quoteOption(quoted.latest));
    if (other) alternatives.push(otherOption(other));
    if (chainPrice != null) alternatives.push(option("Price Lab chain (SQ5, SQ6 pending)", chainPrice, "SQ2 MODEL anchored; history excluded per master v2"));
  } else if (policyId === "repeat-accepted-hold-v0" && quoted.latest) {
    preferred = quoteOption(quoted.latest);
    if (other) alternatives.push(otherOption(other));
    if (chainPrice != null) alternatives.push(option("Price Lab chain (SQ5, SQ6 pending)", chainPrice, "SQ2/SQ3 stabilized per master v2"));
  } else if (policyId === "repeat-accepted-hold-v0" && other) {
    preferred = otherOption(other);
    if (chainPrice != null) alternatives.push(option("Price Lab chain (SQ5, SQ6 pending)", chainPrice, "SQ2/SQ3 stabilized per master v2"));
  } else if (chainPrice != null) {
    preferred = option("Price Lab chain (SQ5, SQ6 pending)", chainPrice, "SQ2/SQ3 stabilized per master v2");
    if (repeat.latest) alternatives.push(option(`Customer's accepted price on ${repeat.latest.poNumber}`, repeat.latest.unitPrice, "REPEAT-ACCEPTED (shown for comparison only)"));
  }

  return {
    policy: { id: policyId, ...policy },
    preferred,
    alternatives,
    repeatCandidates: repeat.eligible.map((po) => ({ poNumber: po.poNumber, revision: po.revision, date: po.date, quantity: po.quantity, unitPrice: po.unitPrice })),
    quoteCandidates: quoted.eligible.map((quote) => ({ date: quote.date, quantity: quote.quantity, unitPrice: quote.unitPrice, evidence: quote.evidence })),
    otherCustomerCandidates: (otherCustomer?.all || []).map(({ source, date, customer, unitPrice, quantity, evidence, link, eligible, why, flags }) => ({ source, date, customer, unitPrice, quantity, evidence, link, eligible, why, flags })),
    deltaVsChain: preferred && chainPrice != null ? { dollars: money(preferred.unitPrice - chainPrice), percent: (preferred.unitPrice - chainPrice) / chainPrice } : null,
    uncalculated: preferred ? null : "No comparable accepted PO, no previous QPC quote, no other customer's price for this part in the last 365 days, and the Price Lab chain is blocked; see the missing facts.",
  };
}

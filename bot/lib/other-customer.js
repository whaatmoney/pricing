// Ruling other-customer-hold-v1: when this customer has no accepted PO and no
// previous quote for the part, what another customer was charged (or quoted)
// for the same part number is the next suggestion, ahead of the calculator.
// Work orders come from Router History matches the engine already buckets as
// "other-customer"; quotes are QPC estimates sent to someone other than this
// customer. Revision is ignored (revision-irrelevant-v1). A different cleaning
// level does not disqualify a match; it is labelled. Prices well below the
// calculator, or quoted for far larger lots, are labelled as possible
// large-lot prices.

const DAY = 86400000;
const LARGE_LOT_RATIO = 5;
const FAR_BELOW_CHAIN = 0.5;

const withinYear = (date, requestDate) => {
  const ageDays = (Date.parse(requestDate) - Date.parse(date)) / DAY;
  return ageDays >= 0 && ageDays <= 365;
};

function flagsFor(candidate, line, chainPrice) {
  const flags = candidate.differences.filter((item) => !item.startsWith("quantity ")).map((item) => `different scope: ${item}`);
  if (candidate.quantity != null && line.quantity && candidate.quantity >= LARGE_LOT_RATIO * line.quantity) {
    flags.push(`large-lot price: ${candidate.quantity} pcs vs ${line.quantity} requested, check quantity`);
  } else if (candidate.quantity == null && chainPrice != null && candidate.unitPrice < FAR_BELOW_CHAIN * chainPrice) {
    flags.push(`well under the calculator ($${chainPrice.toFixed(2)}); possibly a large-lot price, check quantity`);
  }
  return flags;
}

// dbMatches: matchLineHistory results; quotes: other-customer QPC estimates as
// { date, customer, unitPrice, quantity, evidence, link, differences }.
export function otherCustomerPrice({ dbMatches = [], quotes = [], line, requestDate, chainPrice = null }) {
  const workOrders = dbMatches
    .filter((item) => item.bucket === "other-customer")
    .map((item) => ({
      source: "work order",
      date: item.record.received,
      customer: item.record.customer,
      unitPrice: item.record.unitPrice,
      quantity: null,
      evidence: `WO ${item.record.wo}`,
      link: null,
      category: item.category,
      differences: item.differences || [],
    }));
  const all = [...workOrders, ...quotes.map((quote) => ({ source: "QPC quote", category: "ordinary", differences: [], ...quote }))]
    .map((candidate) => {
      const why = !(candidate.unitPrice > 0) ? "no unit price (lot-priced or $0)"
        : candidate.category !== "ordinary" ? `not an ordinary line (${candidate.category})`
          : !candidate.date ? "no date"
            : !withinYear(candidate.date, requestDate) ? "older than 365 days"
              : null;
      return { ...candidate, eligible: !why, why, flags: why ? [] : flagsFor(candidate, line, chainPrice) };
    })
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const eligible = all.filter((candidate) => candidate.eligible);
  // Newest first; on the same day a work order (paid) leads a quote, then the higher price.
  const latest = [...eligible].sort((a, b) => b.date.localeCompare(a.date)
    || (a.source === "work order" ? 0 : 1) - (b.source === "work order" ? 0 : 1)
    || b.unitPrice - a.unitPrice)[0] || null;
  return { latest, eligible, all };
}

export function otherCustomerBasis(candidate) {
  return `OTHER-CUSTOMER: ${candidate.customer}; ${candidate.source} ${candidate.evidence}; ${candidate.date}; ${candidate.quantity != null ? `${candidate.quantity} pcs` : "quantity not recorded"} at $${candidate.unitPrice.toFixed(2)}; rule other-customer-hold-v1${candidate.flags.length ? `; ${candidate.flags.join("; ")}` : ""}`;
}

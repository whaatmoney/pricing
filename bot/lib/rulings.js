// Pricing rulings made by QPC's pricing owners that change how PriceGPT
// Master v2 is applied. Each is named, dated and quoted, so every decision
// record says which rulings shaped its price. Names of the people who ruled
// live in the private lifecycle records, not here.

export const RULINGS = [
  {
    id: "hands-on-labor-no-inversion-v1",
    date: "2026-09-27",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "Model inversion severely overprices small lots: lot setup minutes divided over a few parts made labor override the volume price, although the lot minimum already recovers setup.",
    rule: "SQ5 compares SQ2 with hands-on (PER-PART) labor only; lot setup minutes are left out of the comparison because the lot minimum recovers them. Model inversion is removed: the divergence bands and the credible anchor apply in both directions. When the extended price is below the lot minimum, the lot minimum is charged.",
  },
  {
    id: "repeat-accepted-hold-v0-approved",
    date: "2026-09-27",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "Approved after the first repeat-price case: the customer's own accepted POs for the same part, revision and scope are the most reliable price evidence.",
    rule: "The recommendation policy repeat-accepted-hold-v0 is approved: when the same customer issued a PO within 365 days for the exact part number, revision and process scope, at a quantity within ±25% of the request, recommend that PO's unit price and show the Price Lab chain beside it; otherwise recommend the chain.",
  },
  {
    id: "lot-minimum-per-po-v1",
    date: "2026-09-28",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "A lot minimum is for the entire PO, not per line item.",
    rule: "When an RFQ covers more than one part, the lot minimum is checked once against the PO total (every part at its requested quantity), not against each line. Quantity tiers of a single part are alternative POs, so each tier is checked on its own.",
  },
  {
    id: "calculator-volume-v1",
    date: "2026-09-28",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "The master's per-cavity charges overcharge the unit price; the nuance is missing. The published pricing calculator is preferred for volume pricing.",
    rule: "On every first pass the volume price (the SQ2 slot used by the settle step and the band) is the published calculator's price, rounded to the nearest $0.25. Holes, bores and cavities enter only through the calculator's Complexity pick, which the case states with a reason; Cavity $ is always 0. The master's SQ2 is kept in the record as a reference only.",
  },
  {
    id: "previous-quote-hold-v1",
    date: "2026-09-28",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "If there is a previous quote then it should match that and that should be the suggestion.",
    rule: "When no accepted PO applies, the newest quote QPC sent the same customer for the exact part within 365 days is the suggested price (any quantity; the closest quantity on that quote is used). A quote that differs in scope or oxygen service does not qualify. An accepted PO still leads; the calculator chain is shown beside it.",
  },
  {
    id: "revision-irrelevant-v1",
    date: "2026-09-30",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "The rev on the part number does not matter in terms of this pricing. If there is a part number match then it should match; rev is irrelevant.",
    rule: "Revision is never compared when finding price history or emails for a part: a work order, PO, quote or invoice for the same part number is the same part whatever revision the record or the request states, or whether either states one at all. Process scope, oxygen service and cleanliness level are still compared. This replaces the words \"same revision\" in repeat-accepted-hold-v0-approved and previous-quote-hold-v1.",
  },
  {
    id: "other-customer-hold-v1",
    date: "2026-10-02",
    decidedBy: "Quality Manager (pricing owner)",
    reason: "If there is a match in part numbers but the customer is different, it should still be explored in suggested pricing.",
    rule: "When no accepted PO and no previous quote to this customer apply, the newest price another customer was charged (Router History work order) or quoted by QPC for the same part number within 365 days is the suggested price, ahead of the calculator chain, which is shown beside it. $0 lot-priced and non-ordinary lines are skipped; on the same day a work order leads a quote. A different cleaning level does not disqualify the match but is labelled, and a price quoted for 5x the requested quantity or more, or (quantity unknown) under half the calculator, is labelled a possible large-lot price. Revision is ignored.",
  },
];

export const ACTIVE_RULINGS = RULINGS.map((ruling) => ruling.id);

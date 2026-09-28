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
];

export const ACTIVE_RULINGS = RULINGS.map((ruling) => ruling.id);

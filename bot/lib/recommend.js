// Recommendation policies. Each is named and versioned so a decision record
// always says which rule picked its preferred price. No policy here approves a
// price or sends anything; the output is a recommendation for a person.

export const POLICIES = {
  "repeat-accepted-hold-v0": {
    status: "APPROVED 2026-09-27 by the Quality Manager (pricing owner)",
    approved: { date: "2026-09-27", by: "Quality Manager (pricing owner)" },
    rule: "When the same customer issued a purchase order within 365 days for the exact part number, same revision and same process scope, at a quantity within ±25% of the request, recommend that PO's unit price and show the Price Lab chain beside it. Otherwise recommend the Price Lab chain result. When neither exists, leave the price uncalculated and name the missing fact.",
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

const money = (value) => Math.round(value * 100) / 100;

export function recommend({ policyId, line, requestDate, purchaseOrders, chain }) {
  const policy = POLICIES[policyId];
  if (!policy) throw new Error(`Unknown recommendation policy "${policyId}"`);
  const repeat = acceptedRepeatPrice(purchaseOrders, line, requestDate);
  const chainPrice = chain?.settled ?? null;
  const alternatives = [];
  const option = (label, unitPrice, basis) => ({ label, unitPrice, extended: money(unitPrice * line.quantity), basis });

  let preferred = null;
  if (policyId === "repeat-accepted-hold-v0" && repeat.latest) {
    const po = repeat.latest;
    preferred = option(`Hold the customer's accepted price from ${po.poNumber}${po.revision ? ` Rev. ${po.revision}` : ""}`, po.unitPrice, `REPEAT-ACCEPTED: customer PO ${po.poNumber} dated ${po.date}, ${po.quantity} pcs at $${po.unitPrice.toFixed(2)}, same part, revision and process scope`);
    if (chainPrice != null) alternatives.push(option("Price Lab chain (SQ5, SQ6 pending)", chainPrice, "SQ2 MODEL anchored; history excluded per master v2"));
  } else if (chainPrice != null) {
    preferred = option("Price Lab chain (SQ5, SQ6 pending)", chainPrice, "SQ2/SQ3 stabilized per master v2");
    if (repeat.latest) alternatives.push(option(`Customer's accepted price on ${repeat.latest.poNumber}`, repeat.latest.unitPrice, "REPEAT-ACCEPTED (shown for comparison only)"));
  }

  return {
    policy: { id: policyId, ...policy },
    preferred,
    alternatives,
    repeatCandidates: repeat.eligible.map((po) => ({ poNumber: po.poNumber, revision: po.revision, date: po.date, quantity: po.quantity, unitPrice: po.unitPrice })),
    deltaVsChain: preferred && chainPrice != null ? { dollars: money(preferred.unitPrice - chainPrice), percent: (preferred.unitPrice - chainPrice) / chainPrice } : null,
    uncalculated: preferred ? null : "No comparable accepted PO and the Price Lab chain is blocked; see the missing facts.",
  };
}

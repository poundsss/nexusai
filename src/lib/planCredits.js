// Display helpers for the two credit pools. Message and Integration are never summed.
export const fmtCredits = (n) => (typeof n === "number" ? n.toLocaleString() : "—");

// [message label, integration label] for a plan, from its existing fields.
export function planCreditLines(p) {
  if (p?.code === "enterprise") return ["Custom Message credits", "Custom Integration credits"];
  // P-8.8: a plan with selectable volumes (Elite parity) shows its lowest rung — the exact
  // chosen amount is picked on the Plans page.
  if (p?.credit_options?.length) {
    const minMsg = Math.min(...p.credit_options.map((o) => Number(o.message_credits) || 0));
    const minInt = Math.min(...p.credit_options.map((o) => Number(o.integration_credits) || 0));
    return [
      `From ${fmtCredits(minMsg)} Message credits (choose your volume)`,
      `From ${fmtCredits(minInt)} Integration credits (choose your volume)`,
    ];
  }
  return [
    `${fmtCredits(p?.included_credits)} Message credits`,
    `${fmtCredits(p?.included_integration_credits)} Integration credits`,
  ];
}

// Per-pool balance from the ledger-derived balance (balance.by_type).
export const poolBalance = (balance, pool) => balance?.by_type?.[pool] || null;
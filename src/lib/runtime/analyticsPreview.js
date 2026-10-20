// Preview-side handling of the generated app's `analytics.*` calls.
//
// A preview is not a deployment: there is no live app, no end-user session and therefore no
// project-scoped analytics context the server could attribute an event to. Rather than send an
// unattributable event (or let the call fall through to the database handler and fail with a
// confusing "unknown db operation"), the preview answers the SAME shapes the deployed runtime
// returns and records nothing. Ingestion stays exclusively the deployed runtime's job, so the
// server-side analytics contract is untouched and preview traffic can never pollute real data.
export const ANALYTICS_OPS = ["session_start", "session_current", "session_end", "track", "link_identity"];

export function isAnalyticsOp(op) {
  return ANALYTICS_OPS.includes(op);
}

const session = (session_key, status, page) => ({
  session: {
    session_key: session_key || null,
    status,
    environment: "development",
    page: page || null,
    preview: true,
  },
});

// Mirrors the deployed runtime's return shapes: session ops return { session }, ingestion ops
// report that nothing was accepted, so app code that reads the result behaves identically.
export function handleAnalyticsCall(op, args = {}) {
  if (!isAnalyticsOp(op)) throw new Error(`Unknown analytics operation ${op}`);
  if (op === "session_start") return session(args.session_key, "active", args.page);
  if (op === "session_current") return session(args.session_key, "active", args.page);
  if (op === "session_end") return session(args.session_key, "ended", args.page);
  if (op === "link_identity") return { linked: false, preview: true };
  return { accepted: false, preview: true, reason: "Analytics events are recorded for deployed applications only" };
}
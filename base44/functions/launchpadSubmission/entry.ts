// Launchpad submission — the authorized surface over the CONFIRMED submission-management
// slice ONLY (submit / my_submissions / edit / withdraw). No voting, rounds, leaderboard,
// Wall of Fame, prize credits, comments, public browsing or moderation engine — none of those
// contracts is documented. The lifecycle is NexusAI-native and NON-PARITY (see the entity).
// NOTE: no security-scan gate — no persisted per-project security-scan result contract exists;
// the only scan surface is a self-contained certification harness unrelated to the caller's
// project, so gating on it would mean inventing a contract.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  submitLaunchpad, myLaunchpadSubmissions, editLaunchpadSubmission, withdrawLaunchpadSubmission,
} from "../../shared/launchpad.ts";

export const config = { public: true };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "submit") {
      const res = await submitLaunchpad(base44, user, body);
      return Response.json(res);
    }
    if (action === "my_submissions") {
      const res = await myLaunchpadSubmissions(base44, user, body);
      return Response.json(res);
    }
    if (action === "edit") {
      const res = await editLaunchpadSubmission(base44, user, body);
      return Response.json(res);
    }
    if (action === "withdraw") {
      const res = await withdrawLaunchpadSubmission(base44, user, body);
      return Response.json(res);
    }
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 400 });
  }
}
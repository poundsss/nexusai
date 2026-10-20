// Authorized surface for the reward / outcome engine.
//
// Deliberately minimal: calculate the reward for a sealed episode that already has a Judge
// evaluation, retrieve the active reward, and read the reward history across policy versions.
// Rewards are derived server-side from the evaluation and the authoritative user outcome, so no
// client can submit a reward value, and nothing here writes to the trajectory, evaluation, build,
// runtime, version or deployment records the reward is computed from.
//
// Every action authorizes the caller against the project through the platform's existing path
// (write to calculate, read to retrieve) and is then filtered by that project id. Responses come
// from a field allowlist and expose no policy internals beyond the documented formula string.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runRewardCalculation, getReward, listRewardHistory, listProjectRewards, REWARD_POLICY_VERSION, rewardPolicyVersions } from "../../shared/reward.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "get";

    if (action === "calculate") return Response.json(await runRewardCalculation(base44, user, body));
    if (action === "get") return Response.json(await getReward(base44, user, body));
    if (action === "history") return Response.json(await listRewardHistory(base44, user, body));
    if (action === "list") return Response.json(await listProjectRewards(base44, user, body));
    if (action === "policies") return Response.json({ current: REWARD_POLICY_VERSION, versions: rewardPolicyVersions() });
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}
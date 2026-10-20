// R-8 / PA-35: server-side GitHub plan entitlement. The plan's `github_integration` entitlement
// (Builder and higher) was only displayed; this is the single server check every gated GitHub
// action uses. A lapsed subscription resolves to the free plan (effectivePlan), so it is refused
// too. Links, settings and history are never removed here — only gated USE is blocked.
import { effectivePlan } from "./planLimits.ts";

export const GITHUB_PLAN_NOT_ENTITLED = "GITHUB_PLAN_NOT_ENTITLED";

export async function githubEntitlement(svc, workspaceId, { resolvePlan = effectivePlan } = {}) {
  if (!workspaceId) return { allowed: false, plan_code: null, source: "no_workspace" };
  // A plan-read failure propagates (fail closed) — never treated as entitled.
  const { plan, source } = await resolvePlan(svc, workspaceId);
  return { allowed: plan?.entitlements?.github_integration === true, plan_code: plan?.code || null, source };
}

export const githubPlanMessage = (e) => e.source === "lapsed"
  ? "Your subscription is no longer active, so GitHub integration is unavailable. Your repository link and history are kept; renew a Builder or higher plan to use them."
  : "GitHub integration requires the Builder plan or higher. Your repository link and history are kept; upgrade to use them.";

export async function requireGitHubEntitlement(svc, workspaceId, opts = {}) {
  const e = await githubEntitlement(svc, workspaceId, opts);
  if (!e.allowed) {
    throw Object.assign(new Error(githubPlanMessage(e)), { status: 403, code: GITHUB_PLAN_NOT_ENTITLED, plan_code: e.plan_code, source: e.source });
  }
  return e;
}
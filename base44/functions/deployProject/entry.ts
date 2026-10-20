// Deployment control plane: create, cancel and roll back production deployments.
//
// Creating a deployment persists it as QUEUED and returns immediately — the "Deployment
// Executor" workflow drives build → artifact → verify → LIVE in the background, so closing
// the browser cannot interrupt or corrupt a deployment.
//
// Every action here is explicitly user-authorized against the project. Agents cannot reach
// this endpoint on a user's behalf: it requires a real end-user identity.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { DEPLOY_TERMINAL, DEPLOY_ACTIVE, ensureProjectSlug, deploymentPath, normalizeEnvironment, currentLiveDeployment, requestDeployment, convergeDeploymentRequest } from "../../shared/deploy.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";
// P-10.5: the plan's daily deployment ceiling applies to EVERY deployment request this
// endpoint creates — plain deploys (via requestDeployment), promotions and rollbacks alike.
import { assertDeploymentQuota, createDeploymentWithinLimit } from "../../shared/planLimits.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "deploy.manage");
    const svc = base44.asServiceRole;
    const action = String(body.action || "deploy");

    // A plain "deploy this version" goes through THE shared request path (also used by the CLI), so
    // rate limiting, the in-progress guard and the cross-project version check live in one place.
    if (action === "deploy") {
      try {
        const r = await requestDeployment(base44, user, { project_id: project.id, environment: body.environment || "production", version_id: body.version_id || null });
        return Response.json({ deployment_id: r.deployment.id, status: "QUEUED", environment: r.environment, version_number: r.version.number, deployment_url: deploymentPath(r.slug, r.environment), promoted_from: null }, { status: 202 });
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.deployment_id ? { deployment_id: e.deployment_id } : {}) }, { status: e.status || 500 });
      }
    }

    if (action === "cancel") {
      const deployment = await svc.entities.Deployment.get(body.deployment_id).catch(() => null);
      // Cross-project protection: a deployment id from another project is simply not found.
      if (!deployment || deployment.project_id !== project.id) return Response.json({ error: "Deployment not found" }, { status: 404 });
      if (DEPLOY_TERMINAL.includes(deployment.status)) return Response.json({ deployment_id: deployment.id, status: deployment.status, already_terminal: true });
      await svc.entities.Deployment.update(deployment.id, { cancel_requested: true });
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "deployment.cancel_requested", resource: "Deployment", resource_id: deployment.id, metadata: { status: deployment.status } }).catch(() => {});
      return Response.json({ deployment_id: deployment.id, cancel_requested: true, status: deployment.status });
    }

    // Deployments consume real build capacity, so they are rate-limited per caller. Cancelling
    // is deliberately exempt: stopping work must never be the thing that gets throttled.
    await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspace.id }), action: "deploy", workspace_id: workspace.id });
    // Plan entitlement (P-10.5), fail-closed before any request state is read or written:
    // a non-active workspace lifecycle and an exhausted daily deployment ceiling refuse the
    // request outright, exactly like the shared deploy path.
    if (workspace.status && workspace.status !== "active") {
      return Response.json({ error: `Workspace is ${workspace.status}; deployments are suspended`, code: "WORKSPACE_NOT_ENTITLED" }, { status: 402 });
    }
    await assertDeploymentQuota(base44, workspace);

    // Target environment. Staging and production are independent pipelines, so the
    // in-progress guard, the rollback target and the promotion source are all scoped to one
    // environment — deploying to staging can never block or alter production.
    const environment = normalizeEnvironment(body.environment || "production");

    // One deployment at a time per environment: two deployments can never half-replace
    // each other.
    const recent = await svc.entities.Deployment.filter({ project_id: project.id }, "-created_date", 40);
    const active = recent.find((d) => DEPLOY_ACTIVE.includes(d.status) && (d.environment || "production") === environment);
    if (active) {
      return Response.json({ error: `A ${environment} deployment is already in progress for this project`, code: "DEPLOYMENT_IN_PROGRESS", deployment_id: active.id }, { status: 409 });
    }

    let version = null;
    let rollbackTarget = null;
    let promotionSource = null;
    let presetArtifactId = null;
    // What the environment served before this action, for the audit trail only.
    let previousLive = null;

    if (action === "promote") {
      // Promotion ships the EXACT artifact another environment already proved good: no
      // rebuild, so the promoted bits are byte-identical to the verified ones.
      const from = normalizeEnvironment(body.from_environment || "staging");
      if (from === environment) return Response.json({ error: "Promotion needs two different environments", code: "SAME_ENVIRONMENT" }, { status: 400 });
      const source = await currentLiveDeployment(svc, project, from);
      if (!source) return Response.json({ error: `Nothing is live in ${from} to promote`, code: "NOTHING_TO_PROMOTE" }, { status: 400 });
      if (!source.artifact_id) return Response.json({ error: "The source deployment has no artifact to promote", code: "ARTIFACT_ERROR" }, { status: 400 });
      const target = await currentLiveDeployment(svc, project, environment);
      previousLive = target;
      if (target && target.artifact_checksum && target.artifact_checksum === source.artifact_checksum) {
        return Response.json({ error: `${environment} already serves this exact build`, code: "ALREADY_LIVE", deployment_id: target.id }, { status: 400 });
      }
      version = await svc.entities.ProjectVersion.get(source.version_id).catch(() => null);
      if (!version || version.project_id !== project.id) return Response.json({ error: "The version behind that deployment no longer exists" }, { status: 400 });
      promotionSource = source;
      presetArtifactId = source.artifact_id;
    } else if (action === "rollback") {
      // Rollback never mutates history: it creates a NEW deployment pointing at the
      // version/artifact an earlier deployment already proved good.
      const target = await svc.entities.Deployment.get(body.deployment_id).catch(() => null);
      if (!target || target.project_id !== project.id) return Response.json({ error: "Deployment not found" }, { status: 404 });
      if (target.status !== "LIVE") return Response.json({ error: "Only a deployment that reached LIVE can be rolled back to", code: "NOT_ROLLBACKABLE" }, { status: 400 });
      if ((target.environment || "production") !== environment) return Response.json({ error: `That deployment belongs to ${target.environment || "production"}, not ${environment}`, code: "WRONG_ENVIRONMENT" }, { status: 400 });
      const live = await currentLiveDeployment(svc, project, environment);
      previousLive = live;
      if (live && live.id === target.id) return Response.json({ error: `That deployment is already serving ${environment}`, code: "ALREADY_LIVE" }, { status: 400 });
      version = await svc.entities.ProjectVersion.get(target.version_id).catch(() => null);
      if (!version) return Response.json({ error: "The version behind that deployment no longer exists" }, { status: 400 });
      rollbackTarget = target;
    } else {
      // Deploy an explicit version, or the project's latest.
      if (body.version_id) {
        version = await svc.entities.ProjectVersion.get(body.version_id).catch(() => null);
        // A version id belonging to another project must never be deployable here.
        if (!version || version.project_id !== project.id) return Response.json({ error: "Version not found in this project" }, { status: 404 });
      } else {
        const latest = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1);
        version = latest[0] || null;
        if (!version) return Response.json({ error: "This project has no versions yet — build it first", code: "NO_VERSION" }, { status: 400 });
      }
    }

    const slug = await ensureProjectSlug(svc, project);
    const now = new Date().toISOString();
    // Same concurrency-safe quota create as the shared deploy path: the daily count is
    // re-derived after the row exists, so racing requests cannot land past the ceiling.
    const deployment = await createDeploymentWithinLimit(base44, workspace, {
      project_id: project.id, workspace_id: workspace.id, version_id: version.id, version_number: version.number,
      environment, status: "QUEUED", trigger: promotionSource ? "promotion" : rollbackTarget ? "rollback" : "user",
      rollback_target_deployment_id: rollbackTarget?.id || undefined,
      promoted_from_deployment_id: promotionSource?.id || undefined,
      artifact_id: presetArtifactId || undefined, artifact_checksum: promotionSource?.artifact_checksum || undefined,
      deployment_url: deploymentPath(slug, environment), deployed_by: user.id,
      cancel_requested: false, recovery_count: 0, started_at: now, heartbeat_at: now,
    });
    // Internal deployment event: written by the platform actor (service role), with the real
    // requesting user kept in metadata. The deployment is already persisted, so a failed audit
    // write must not turn a successful request into an error.
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: "platform",
      action: promotionSource ? "deployment.promotion_requested" : rollbackTarget ? "deployment.rollback_requested" : "deployment.requested",
      resource: "Deployment", resource_id: deployment.id,
      metadata: {
        actor: "platform", initiated_by_user_id: user.id, requested_by_user_id: user.id, workspace_user_id: user.id,
        version: version.number, environment, rollback_of: rollbackTarget?.id || null, promoted_from: promotionSource?.id || null,
        previous_state: previousLive ? { deployment_id: previousLive.id, version_number: previousLive.version_number ?? null, status: previousLive.status } : null,
        new_state: { deployment_id: deployment.id, version_number: version.number, status: "QUEUED" },
      },
    }).catch(() => {});
    // Same convergence as the shared request path: a racing duplicate of THIS environment
    // cancels its own row, so at most one active deployment per environment ever advances —
    // promotion and rollback requests included.
    const converged = await convergeDeploymentRequest(svc, { project_id: project.id, environment, deployment });
    if (converged.cancelled) {
      return Response.json({ error: `A ${environment} deployment is already in progress for this project`, code: "DEPLOYMENT_IN_PROGRESS", deployment_id: converged.winner.id }, { status: 409 });
    }
    return Response.json({ deployment_id: deployment.id, status: "QUEUED", environment, version_number: version.number, deployment_url: deploymentPath(slug, environment), promoted_from: promotionSource?.id || null }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}
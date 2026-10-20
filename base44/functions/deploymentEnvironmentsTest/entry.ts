// Real test for deployment environments, promotion and custom domains.
//
// Nothing is simulated: a throwaway project is created with two real versions, deployed to
// staging and production through the REAL deployment worker (runDeploymentStep), served
// through the REAL public runtime resolution path, promoted, rolled back, and addressed by a
// custom hostname whose ownership is verified through the real DNS verification code.
// Only the DNS network boundary is scripted (a controlled DoH responder passed into the
// verifier), because no test can publish a TXT record on a domain it does not own.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createFs } from "../../shared/projectFs.ts";
import { createVersion } from "../../shared/persistence.ts";
import { runDeploymentStep, currentLiveDeployment, reconcileEnvironmentPointer, ensureProjectSlug } from "../../shared/deploy.ts";
import { parseAppSlug, environmentSlug, deploymentPath, pointerFields, normalizeEnvironment, ENVIRONMENTS } from "../../shared/environments.ts";
import { normalizeHostname, verificationHost, newVerificationToken, verifyDomain, resolveHostname, lookupTxtRecords, dnsInstructions } from "../../shared/domains.ts";
import { startSubscription } from "../../shared/subscriptions.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const appSource = (label) => `import { html } from 'runtime';
export default function App() {
  return html\`<div class="page"><h1 class="card-title">${label}</h1></div>\`;
}
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

// Drives a deployment to a terminal state through the real worker, exactly like the
// background executor workflow does.
async function drive(svc, deploymentId, max = 8) {
  let out = null;
  for (let i = 0; i < max; i++) {
    out = await runDeploymentStep(svc, deploymentId);
    if (out.done) break;
  }
  // The terminal write is committed by the worker, but a read issued immediately after can
  // still observe the pre-terminal row. Re-read until the row reflects the reported status
  // so the assertions below inspect the real record instead of a stale one.
  let deployment = await svc.entities.Deployment.get(deploymentId);
  for (let i = 0; i < 5 && out?.status && deployment.status !== out.status; i++) {
    await new Promise((r) => setTimeout(r, 250));
    deployment = await svc.entities.Deployment.get(deploymentId);
  }
  return { ...out, deployment };
}

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const stamp = Date.now();
  let project = null;
  let ws = null;
  let subscriptionId = null;
  const domainIds = [];

  const deployVersion = async (version, environment, extra = {}) => {
    const slug = await ensureProjectSlug(svc, project);
    const now = new Date().toISOString();
    const d = await svc.entities.Deployment.create({
      project_id: project.id, workspace_id: project.workspace_id, version_id: version.id, version_number: version.number,
      environment, status: "QUEUED", trigger: extra.trigger || "user", deployment_url: deploymentPath(slug, environment),
      deployed_by: "test-user", cancel_requested: false, recovery_count: 0, started_at: now, heartbeat_at: now, ...extra,
    });
    const res = await drive(svc, d.id);
    project = await svc.entities.Project.get(project.id);
    return res;
  };

  try {
    // ===================== environment addressing (pure) =====================
    check("environment slugs round-trip", environmentSlug("shop", "staging") === "shop--staging" && environmentSlug("shop", "production") === "shop"
      && parseAppSlug("shop--staging").environment === "staging" && parseAppSlug("shop--staging").slug === "shop"
      && parseAppSlug("shop").environment === "production", JSON.stringify(parseAppSlug("shop--staging")));
    check("each environment has its own pointer fields", pointerFields("staging").deployment === "staging_deployment_id" && pointerFields("production").deployment === "production_deployment_id" && ENVIRONMENTS.length === 2, ENVIRONMENTS.join(","));
    let badEnv = null;
    try { normalizeEnvironment("preview"); } catch (e) { badEnv = e; }
    check("an unknown environment is refused", !!badEnv && badEnv.status === 400, badEnv?.message);

    // ===================== real deployments ==================================
    // Scratch workspace + active credits_topup subscription: the deploy path's plan-entitlement
    // gate (assertPublicServing / assertDeploymentQuota) resolves the plan server-side from the
    // workspace's subscription. A scratch workspace with no subscription defaults to the free
    // plan (5 deployments/day, and a non-active/missing workspace row is refused 402), which would
    // block this suite mid-run. credits_topup has no daily deployment ceiling, so the gate passes
    // legitimately — nothing is bypassed or mocked.
    ws = await svc.entities.Workspace.create({ name: `Env Test WS ${stamp}`, owner_id: "test-user", status: "active", credits_balance: 0 });
    const subRes = await startSubscription(svc, { workspace_id: ws.id, plan_code: "credits_topup", user_id: "test-user" });
    subscriptionId = subRes.subscription?.id || null;
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: `Env Test ${stamp}`, slug: `env-test-${stamp}` });
    const fsV1 = createFs([]);
    const mkVersion = async (label) => {
      const fs = createFs([]);
      fs.files.set("src/main.js", { id: null, path: "src/main.js", content: MAIN, original: null });
      fs.files.set("src/App.js", { id: null, path: "src/App.js", content: appSource(label), original: null });
      fs.files.set("styles.css", { id: null, path: "styles.css", content: STYLES, original: null });
      return createVersion(svc, { project, fs, entities: [], secrets: [], message: label, changedFiles: [] });
    };
    const v1 = await mkVersion("Version one");
    const v2 = await mkVersion("Version two");
    project = await svc.entities.Project.get(project.id);

    const stagingRun = await deployVersion(v1, "staging");
    check("a version deploys to staging and goes LIVE", stagingRun.status === "LIVE" && stagingRun.deployment.environment === "staging" && stagingRun.deployment.deployment_url === `/app/${project.slug}--staging`, `${stagingRun.status} ${stagingRun.deployment.failure_summary || ""}`);
    check("staging deployment does not touch production", !!project.staging_deployment_id && project.staging_version_number === v1.number && !project.production_deployment_id, `staging=${project.staging_version_number} production=${project.production_version_number}`);
    check("production has nothing live while staging does", !(await currentLiveDeployment(svc, project, "production")) && (await currentLiveDeployment(svc, project, "staging"))?.id === stagingRun.deployment.id, "environment isolation");

    const prodRun = await deployVersion(v2, "production");
    project = await svc.entities.Project.get(project.id);
    check("a different version deploys to production independently", prodRun.status === "LIVE" && project.production_version_number === v2.number && project.staging_version_number === v1.number, `prod=${project.production_version_number} staging=${project.staging_version_number}`);
    check("each environment resolves its own live deployment", (await currentLiveDeployment(svc, project, "staging")).version_number === v1.number && (await currentLiveDeployment(svc, project, "production")).version_number === v2.number, "independent resolution");

    // The public runtime path: slug → environment → that environment's artifact.
    const serve = async (slugOrHost, isHost = false) => {
      const res = await svc.functions.invoke("appRuntime", isHost ? { action: "artifact", host: slugOrHost } : { action: "artifact", slug: slugOrHost });
      return res.data || res;
    };
    const prodServed = await serve(project.slug);
    const stagingServed = await serve(`${project.slug}--staging`);
    check("the public runtime serves production at the plain slug", prodServed.deployment?.version_number === v2.number && prodServed.app?.environment === "production" && prodServed.files.some((f) => f.content.includes("Version two")), JSON.stringify(prodServed.deployment || prodServed).slice(0, 200));
    check("the public runtime serves staging at the staging slug", stagingServed.deployment?.version_number === v1.number && stagingServed.app?.environment === "staging" && stagingServed.files.some((f) => f.content.includes("Version one")), JSON.stringify(stagingServed.deployment || stagingServed).slice(0, 200));

    // ===================== promotion =========================================
    const stagingLive = await currentLiveDeployment(svc, project, "staging");
    const promo = await deployVersion(v1, "production", { trigger: "promotion", promoted_from_deployment_id: stagingLive.id, artifact_id: stagingLive.artifact_id, artifact_checksum: stagingLive.artifact_checksum });
    project = await svc.entities.Project.get(project.id);
    check("promotion ships the exact staging artifact to production", promo.status === "LIVE" && promo.deployment.artifact_id === stagingLive.artifact_id && promo.deployment.artifact_checksum === stagingLive.artifact_checksum, `${promo.status} ${promo.deployment.failure_summary || ""}`);
    const artifactsForV1 = await svc.entities.DeploymentArtifact.filter({ project_id: project.id, version_id: v1.id }, "-created_date", 10);
    check("promotion reuses the artifact instead of rebuilding it", artifactsForV1.length === 1, `${artifactsForV1.length} artifact(s) for the promoted version`);
    const afterPromo = await serve(project.slug);
    check("production now serves the promoted build", afterPromo.deployment.version_number === v1.number && afterPromo.deployment.checksum === stagingLive.artifact_checksum, JSON.stringify(afterPromo.deployment).slice(0, 200));
    check("promotion left staging untouched", (await currentLiveDeployment(svc, project, "staging")).id === stagingLive.id && project.staging_version_number === v1.number, "staging stable");
    const supersededProd = await svc.entities.Deployment.get(prodRun.deployment.id);
    check("the superseded production deployment is stamped, not rewritten", !!supersededProd.superseded_at && supersededProd.status === "LIVE" && supersededProd.version_number === v2.number, `superseded_at=${supersededProd.superseded_at}`);

    // A promotion whose artifact belongs to another project version cannot go live.
    const forged = await deployVersion(v2, "production", { trigger: "promotion", artifact_id: stagingLive.artifact_id });
    check("a mismatched promotion artifact fails before any switch", forged.status === "FAILED" && forged.deployment.failure_code === "ARTIFACT_ERROR" && (await currentLiveDeployment(svc, project, "production")).version_number === v1.number, `${forged.status}/${forged.deployment.failure_code}/${forged.deployment.failure_summary}`);

    // ===================== rollback within one environment ===================
    const rollback = await deployVersion(v2, "production", { trigger: "rollback", rollback_target_deployment_id: prodRun.deployment.id });
    project = await svc.entities.Project.get(project.id);
    check("rollback returns production to an earlier verified version", rollback.status === "LIVE" && project.production_version_number === v2.number && rollback.deployment.artifact_checksum === prodRun.deployment.artifact_checksum, `now v${project.production_version_number}`);

    // Pointer reconciliation is per environment: corrupting one must not disturb the other.
    await svc.entities.Project.update(project.id, { production_deployment_id: null });
    project = await svc.entities.Project.get(project.id);
    const fixed = await reconcileEnvironmentPointer(svc, project, "production");
    project = await svc.entities.Project.get(project.id);
    check("a lost pointer is reconciled from the live deployment", fixed?.id === rollback.deployment.id && project.production_deployment_id === rollback.deployment.id && project.staging_deployment_id === stagingLive.id, "pointer repaired");
    const stillServes = await serve(project.slug);
    check("the runtime serves correctly even with a stale pointer", stillServes.deployment.version_number === v2.number, JSON.stringify(stillServes.deployment).slice(0, 150));

    // ===================== custom domains ====================================
    check("hostnames are normalized and validated", normalizeHostname(" HTTPS://App.Acme.com/dashboard ") === "app.acme.com" && verificationHost("app.acme.com") === "_nexus-verify.app.acme.com", normalizeHostname("https://App.Acme.com/x"));
    for (const bad of ["localhost", "notadomain", "*.acme.com", "my app.com", "app.base44.app", "http://10.0.0.1:8080"]) {
      let err = null;
      try { normalizeHostname(bad); } catch (e) { err = e; }
      check(`an unusable hostname is refused (${bad})`, !!err && err.status === 400, err?.message);
    }

    const hostname = `app-${stamp}.nexus-test.dev`;
    const token = newVerificationToken();
    const domain = await svc.entities.CustomDomain.create({
      project_id: project.id, workspace_id: project.workspace_id, hostname, environment: "production",
      status: "pending_verification", verification_method: "dns_txt", verification_host: verificationHost(hostname),
      verification_token: token, is_primary: false, added_by: "test-user",
    });
    domainIds.push(domain.id);
    check("DNS instructions describe the record to publish", dnsInstructions(domain).name === `_nexus-verify.${hostname}` && dnsInstructions(domain).value === token && dnsInstructions(domain).type === "TXT", JSON.stringify(dnsInstructions(domain)));
    check("an unverified hostname resolves to nothing", (await resolveHostname(svc, hostname)) === null, "not servable");

    // Scripted DoH responder: the real verifier, real DNS-JSON parsing, controlled answers.
    const doh = (answers, status = 0) => async () => new Response(JSON.stringify({ Status: status, Answer: answers }), { status: 200, headers: { "content-type": "application/dns-json" } });
    const nxdomain = await verifyDomain(svc, domain, { fetchImpl: doh([], 3) });
    check("a missing TXT record keeps the domain unverified", !nxdomain.ok && nxdomain.code === "RECORD_NOT_FOUND" && nxdomain.status === "pending_verification" && /No TXT record/.test(nxdomain.domain.last_error), nxdomain.domain.last_error);
    const wrongToken = await verifyDomain(svc, nxdomain.domain, { fetchImpl: doh([{ type: 16, data: `"nexus-verify-somebodyelse"` }]) });
    check("a foreign token does not verify the domain", !wrongToken.ok && wrongToken.status === "pending_verification" && (await resolveHostname(svc, hostname)) === null, wrongToken.domain.last_error);
    const verified = await verifyDomain(svc, wrongToken.domain, { fetchImpl: doh([{ type: 16, data: `"unrelated"` }, { type: 16, data: `"${token}"` }]) });
    check("the real TXT record activates the domain", verified.ok && verified.status === "active" && !!verified.domain.verified_at && !verified.domain.last_error, JSON.stringify(verified.code));

    const resolved = await resolveHostname(svc, `HTTPS://${hostname}/some/path`);
    check("an active hostname resolves to its project and environment", resolved?.project_id === project.id && resolved.environment === "production", JSON.stringify(resolved?.environment));
    const hostServed = await serve(hostname, true);
    check("the public runtime serves the app on its custom domain", hostServed.deployment?.version_number === v2.number && hostServed.app?.environment === "production", JSON.stringify(hostServed.deployment || hostServed).slice(0, 200));

    // A staging domain must serve staging, never production.
    const stagingHost = `stg-${stamp}.nexus-test.dev`;
    const stagingToken = newVerificationToken();
    const stagingDomain = await svc.entities.CustomDomain.create({
      project_id: project.id, workspace_id: project.workspace_id, hostname: stagingHost, environment: "staging",
      status: "pending_verification", verification_host: verificationHost(stagingHost), verification_token: stagingToken, added_by: "test-user",
    });
    domainIds.push(stagingDomain.id);
    await verifyDomain(svc, stagingDomain, { fetchImpl: doh([{ type: 16, data: `"${stagingToken}"` }]) });
    const stagingHostServed = await serve(stagingHost, true);
    check("a staging domain serves staging only", stagingHostServed.deployment?.version_number === v1.number && stagingHostServed.app?.environment === "staging", JSON.stringify(stagingHostServed.deployment || stagingHostServed).slice(0, 200));

    // Transient DNS failure must not demote a live domain.
    const flaky = await verifyDomain(svc, verified.domain, { fetchImpl: async () => new Response("upstream down", { status: 502 }) });
    check("a DNS outage never takes a verified domain offline", !flaky.ok && flaky.code === "DNS_LOOKUP_FAILED" && flaky.status === "active" && (await resolveHostname(svc, hostname))?.project_id === project.id, `${flaky.code}/${flaky.status}`);
    let timedOut = null;
    try { await lookupTxtRecords("example.com", { fetchImpl: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 5)) }); } catch (e) { timedOut = e; }
    check("a DNS timeout is classified, not swallowed", timedOut?.code === "DNS_TIMEOUT", timedOut?.message);

    // Removal takes effect immediately.
    await svc.entities.CustomDomain.update(verified.domain.id, { status: "removed", is_primary: false });
    check("a removed domain stops resolving at once", (await resolveHostname(svc, hostname)) === null, "unresolvable");
    const goneRes = await svc.functions.invoke("appRuntime", { action: "artifact", host: hostname }).then((r) => r.data || r).catch((e) => ({ error: e.message }));
    check("the runtime refuses a removed domain", !goneRes.files && /not found|404/i.test(JSON.stringify(goneRes)), JSON.stringify(goneRes).slice(0, 150));
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    if (project) {
      for (const entity of ["Deployment", "DeploymentArtifact", "ProjectVersion", "Build", "AppRecord"]) {
        const rows = await svc.entities[entity].filter({ project_id: project.id }, "-created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      for (const id of domainIds) await svc.entities.CustomDomain.delete(id).catch(() => {});
      await svc.entities.Project.delete(project.id).catch(() => {});
      if (subscriptionId) await svc.entities.Subscription.delete(subscriptionId).catch(() => {});
      if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
      const leftovers = await svc.entities.Deployment.filter({ project_id: project.id }, "-created_date", 5).catch(() => []);
      results.push({ name: "scratch project, deployments and domains cleaned up", ok: leftovers.length === 0, detail: `${leftovers.length} deployment rows left` });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}
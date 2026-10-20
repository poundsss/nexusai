// Production deployment control plane.
//
// This is an ORCHESTRATION layer over what already exists — there is no second build
// system, version system, secret system or runtime:
//   • source of truth .... ProjectVersion snapshots (immutable) → projectFs
//   • validation ......... buildEngine.runBuild, the same pass the builder and agent use
//   • storage ............ blobStore (artifact payloads live beside version snapshots)
//   • secrets ............ ProjectSecret, values read server-side only, never packaged
//   • execution .......... functionRuntime.executeProjectFunction (the preview's executor)
//   • durability ......... the same lease + heartbeat + bounded-recovery pattern as agents
//   • audit .............. authz.audit
//
// The deployment pipeline is: Version → build → immutable Artifact → Deployment → LIVE.
// A deployment NEVER reads the project's mutable working files: it reads the version
// snapshot it was created from, so redeploying an old version is exact.
import { createFs, activeFiles } from "./projectFs.ts";
import { resolveSessionRecord, normalizeEmail } from "./appAuth.ts";
import { runBuild } from "./buildEngine.ts";
import { unpackSnapshot, packJson, unpackJson } from "./blobStore.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";
import { isIntegrationPath, parseIntegrationFile } from "./integrations.ts";
// Referral (Slice 2): the production LIVE switch is the publish condition of the referrer
// reward. Detection rides this EXISTING production path; fail-safe below.
import { maybeGrantReferrerReward } from "./referral.ts";
import { emitAppPublish } from "./workflowTriggers.ts";
// The actor RESOURCE contract (E8). Used here only to project each declared actor into the
// artifact — the definition, the runtime and the permission model are all unchanged.
import { isActorFilePath, parseActorDocument } from "./actorResource.ts";
// The agent (E9), agent-skill (E11) and connector (E12) RESOURCE contracts. Used here only to
// decide which half of the artifact each declaration travels in and to project it — every
// definition, validator, permission gate and runtime stays exactly where it already lives.
import { isAgentFilePath, isAgentSkillFilePath, isConnectorFilePath, isContextFilePath } from "./base44Layout.ts";
import { collectAgents } from "./agentResource.ts";
import { collectAgentSkills } from "./agentSkillResource.ts";
import { collectConnectors } from "./connectorResource.ts";
// The workflow RESOURCE contract (#28). Used here only to classify workflow documents as server
// resources and to project them into the artifact — the definition model, the validator, the
// trigger system and the durable engine all stay exactly where they already live.
import { isWorkflowFilePath, collectWorkflowFiles, parseWorkflowDocument } from "./workflowResource.ts";
import { validateWorkflow } from "./workflowContract.ts";
import { readFunctionConfig } from "./functionRuntime.ts";
import { ENTRY_FILE } from "./runtimeExports.ts";
import { resolvedDependencyState, validateDependencyFiles } from "./packageLock.ts";
import { packageModules, verifyPackageModules } from "./packageModules.ts";
import { audit, loadAuthorizedProject } from "./authz.ts";
import { enforceLimit, identityFor } from "./apiLimits.ts";
// Plan entitlement for deployment requests (P-10.5): the daily deployment ceiling, resolved
// server-side from the workspace's plan — never from the request.
import { assertDeploymentQuota, createDeploymentWithinLimit } from "./planLimits.ts";
import { resolveSecretValues } from "./secretCrypto.ts";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT, normalizeEnvironment, pointerFields, deploymentPath, environmentSlug } from "./environments.ts";

export { ENVIRONMENTS, DEFAULT_ENVIRONMENT, normalizeEnvironment, deploymentPath, environmentSlug } from "./environments.ts";

export const DEPLOY_TERMINAL = ["LIVE", "FAILED", "CANCELLED", "ROLLED_BACK"];
export const DEPLOY_ACTIVE = ["QUEUED", "BUILDING", "DEPLOYING", "VERIFYING"];
const LEASE_MS = 150000;
const ITERATION_BUDGET_MS = 60000;
export const MAX_DEPLOY_RECOVERIES = 3;

const trunc = (v, n = 500) => String(v ?? "").slice(0, n);

// --- slug / URL model --------------------------------------------------------
// MVP URL model: one generated path per project, served by the platform's public runtime
// route. A slug belongs to exactly one project, so project A can never resolve to B.
export function slugify(name) {
  return String(name || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
}

export async function ensureProjectSlug(svc, project) {
  if (project.slug) return project.slug;
  const base = slugify(project.name);
  let slug = base;
  for (let i = 0; i < 25; i++) {
    const taken = await svc.entities.Project.filter({ slug }, { sort: "slug", limit: 1 }).then((p) => p.items || []);
    if (!taken.length) break;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  await svc.entities.Project.update(project.id, { slug });
  project.slug = slug;
  return slug;
}

// The single definition of "what an environment serves", used by the public runtime and by
// pointer reconciliation. It is DERIVED from deployment rows rather than trusted from the
// project pointer, so an interrupted environment switch can never take an app offline or
// serve a deployment that never finished verifying. Environments are resolved
// independently: staging deployments are invisible to production and vice versa.
export async function currentLiveDeployment(svc, project, environment = DEFAULT_ENVIRONMENT) {
  const env = normalizeEnvironment(environment);
  const live = await svc.entities.Deployment.filter({ project_id: project.id, status: "LIVE" }, { sort: "-created_date", limit: 25 }).then((p) => p.items || []);
  return live.find((d) => !d.superseded_at && (d.environment || DEFAULT_ENVIRONMENT) === env) || null;
}

/**
 * THE public-serving lifecycle gate (G-2). A suspended or terminated workspace — or an
 * archived project — must not be served: the public runtime refuses BEFORE resolving the
 * live deployment. Shared here so the runtime entry, every test that certifies the gate,
 * and any future public surface exercise ONE implementation.
 */
export async function assertPublicServing(svc, project, { sessionToken, action } = {}) {
  const workspace = await svc.entities.Workspace.get(project.workspace_id).catch(() => null);
  if (!workspace || (workspace.status && workspace.status !== "active")) {
    throw Object.assign(new Error("Application unavailable"), { status: 402, code: "WORKSPACE_NOT_ENTITLED" });
  }
  if (project.status === "archived") {
    throw Object.assign(new Error("Application not found"), { status: 404, code: "PROJECT_ARCHIVED" });
  }
  // Danger Zone 'Unpublish': the app is intentionally taken offline while the project, data,
  // settings, custom domains and the production deployment pointer all remain intact. This is a
  // hard offline for everyone — no auth action is exempt (unlike visibility), because republishing,
  // not signing in, is what brings an unpublished app back. 503 is already used by this runtime
  // for "application unavailable"; the code follows the existing gate naming. Distinct from the
  // archived (Delete) gate above: an unpublished project keeps its lifecycle status.
  if (project.unpublished) {
    throw Object.assign(new Error("This application is currently offline"), { status: 503, code: "APP_UNPUBLISHED" });
  }
  // App Visibility — who can open the published app. The existing suspension/archive gates above
  // are unchanged and universal. 'public' is open. 'private' requires an authenticated invited app
  // user. 'workspace' requires that user to be a member of the owning workspace (matched by email
  // against an active WorkspaceMember row, or the workspace owner). The 'auth' action stays
  // reachable for anonymous visitors so a private/workspace app can be opened after login.
  const visibility = project.visibility || "public";
  if (visibility === "public" || action === "auth") return workspace;
  if (!sessionToken) {
    throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
  }
  const resolved = await resolveSessionRecord(svc, project.id, sessionToken);
  if (!resolved) {
    throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
  }
  if (visibility === "private") return workspace;
  // workspace: the resolved app user must be a member of the owning workspace or its owner.
  const email = normalizeEmail(resolved.user?.email);
  if (email) {
    const owner = await svc.entities.User.get(workspace.owner_id).catch(() => null);
    if (owner && normalizeEmail(owner.email) === email) return workspace;
    const members = await svc.entities.WorkspaceMember.filter({ workspace_id: workspace.id }, { sort: "email", limit: 200 }).then((p) => p.items || []).catch(() => []);
    if (members.some((m) => m.status === "active" && normalizeEmail(m.email) === email)) return workspace;
  }
  throw Object.assign(new Error("Workspace members only"), { status: 403, code: "NOT_A_WORKSPACE_MEMBER" });
}

// Repairs an environment's cached pointer when a worker died mid-switch. Idempotent.
export async function reconcileEnvironmentPointer(svc, project, environment = DEFAULT_ENVIRONMENT) {
  const env = normalizeEnvironment(environment);
  const live = await currentLiveDeployment(svc, project, env);
  const fields = pointerFields(env);
  if (!live || project[fields.deployment] === live.id) return null;
  await svc.entities.Project.update(project.id, { [fields.deployment]: live.id, [fields.version]: live.version_number });
  return live;
}

// --- secret leak scan --------------------------------------------------------
// A real scan, not a pattern guess: every configured secret VALUE for this project is
// searched for in the code that will actually be shipped to browsers. Generic credential
// shapes are flagged too, so a hardcoded key that was never registered is still caught.
const CREDENTIAL_PATTERNS = [
  { re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/g, what: "Stripe-style secret key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, what: "GitHub token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: "AWS access key id" },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]{24,}/g, what: "hardcoded bearer token" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, what: "JWT" },
];

export function scanForSecrets(clientFiles, secretValues) {
  const findings = [];
  const real = (secretValues || []).filter((v) => typeof v === "string" && v.length >= 8);
  for (const f of clientFiles) {
    const content = String(f.content || "");
    for (const v of real) {
      if (content.includes(v)) findings.push(`${f.path}: contains the value of a configured project secret`);
    }
    for (const { re, what } of CREDENTIAL_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(content)) findings.push(`${f.path}: looks like a ${what} embedded in client code`);
    }
  }
  return [...new Set(findings)];
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- context files (P-9.11D) --------------------------------------------------------
/**
 * The validated context-file projection for the artifact's SERVER half — a PURE function
 * over the project's files and its declared agents, so the parity suite certifies exactly
 * what the deploy path ships. The build already refused a missing or oversized reference
 * (validateAgentReferences); this re-checks presence fail-closed and dedupes references
 * shared by several agents deterministically, emitting {path, content} rows the agent
 * runtime resolves by each agent's own declaration.
 */
export function projectContextFiles(files, agents) {
  const out = [];
  for (const a of agents || []) {
    for (const cf of a.context_files || []) {
      if (out.some((c) => c.path === cf)) continue;
      const f = (files || []).find((x) => x.path === cf);
      if (!f) return { ok: false, error: `agent "${a.name}" declares context file "${cf}" which this version does not contain` };
      out.push({ path: cf, content: f.content });
    }
  }
  return { ok: true, contextFiles: out };
}

// --- artifact ----------------------------------------------------------------
// Immutable, reproducible bundle of exactly what the production runtime needs. Contains
// NO secret values: functions declare secret NAMES and the runtime resolves them
// server-side at execution time.
export async function buildArtifact(svc, { project, version, userId }) {
  const snapshot = await unpackSnapshot(version);
  const fs = createFs((snapshot.files || []).map((f) => ({ ...f, id: f.path })));
  // The version's entities, INCLUDING each one's row-level rules: an artifact that dropped them
  // would deploy an app that enforces nothing. An entity with no rules is shaped exactly as before.
  const entities = (snapshot.entities || []).map((e) => ({ name: e.name, fields: e.fields || {}, ...(e.rls ? { rls: e.rls } : {}) }));
  const secretRefs = snapshot.secrets || [];

  // The same validation pass the builder and agent use. A version that does not build
  // cannot become an artifact.
  const build = runBuild(fs, entities, secretRefs);
  if (build.status !== "success") {
    return { ok: false, code: "BUILD_FAILED", build, diagnostics: build.logs.filter((l) => l.startsWith("error")).slice(0, 20) };
  }

  const files = activeFiles(fs);
  // Actor modules are SERVER code: they execute in the platform's sandbox, never in a browser, so
  // they travel with the artifact's server half and are kept out of the client bundle.
  const actorFiles = files.filter((f) => isActorFilePath(f.path));
  // Agent, agent-skill and connector DECLARATIONS are server-side resources too: an agent's
  // instructions and a connector's credential reference are context the platform resolves, never
  // anything a browser may read. They are classified out of the client bundle for the same reason
  // actor modules are, and projected into the artifact's server half below.
  // A workflow document is server-side automation CONFIGURATION: it names backend functions and
  // platform primitives the platform resolves itself, and a browser neither needs it nor may read
  // which internal work a trigger performs. It is classified out of the client bundle for the same
  // reason an agent declaration is, and projected into the artifact's server half below.
  // A context file (P-9.11D) is server-side reference material too: its content is projected
  // into the artifact's server half for the agent runtime only, never the client bundle.
  const isServerResourcePath = (path) =>
    isFunctionPath(path) || isIntegrationPath(path) || isActorFilePath(path) ||
    isAgentFilePath(path) || isAgentSkillFilePath(path) || isConnectorFilePath(path) ||
    isWorkflowFilePath(path) || isContextFilePath(path);
  const clientFiles = files.filter((f) => !isServerResourcePath(f.path));
  const functionFiles = files.filter((f) => isFunctionPath(f.path));
  const integrationFiles = files.filter((f) => isIntegrationPath(f.path));
  if (!clientFiles.some((f) => f.path === ENTRY_FILE)) {
    return { ok: false, code: "ARTIFACT_ERROR", diagnostics: [`artifact has no ${ENTRY_FILE} entry file`] };
  }

  // Real leak scan against live secret values, server-side only.
  const secretRows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, { sort: "name", limit: 200 }).then((p) => p.items || []);
  // Values are encrypted at rest; the scan needs the plaintext, so it decrypts here inside
  // the trusted deploy path. Plaintext is used for comparison only and never stored,
  // returned or logged. An undecryptable row simply cannot be compared.
  const { values: secretPlaintexts } = await resolveSecretValues(secretRows, project.id);
  const findings = scanForSecrets(clientFiles, [...secretPlaintexts.values()]);

  const integrations = [];
  for (const f of integrationFiles) {
    try { integrations.push(parseIntegrationFile(f.path, f.content)); } catch { /* build already validated these */ }
  }
  const requiredSecrets = new Set();
  for (const f of build.functions || []) for (const s of f.secrets || []) requiredSecrets.add(s);
  for (const i of integrations) if (i.auth?.secret) requiredSecrets.add(i.auth.secret);

  // Declared actors, as the deployed runtime needs them: the validated definition plus the source
  // the sandbox executes. The build already refused a malformed actor, so every entry here runs.
  const actors = actorFiles
    .map((f) => ({ parsed: parseActorDocument(f.path, f.content), source: f.content }))
    .filter((a) => a.parsed.ok)
    .map((a) => ({ ...a.parsed.actor, source: a.source }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Declared agents, agent skills and connectors, read through their OWN resource contracts — the
  // same collectors the build, the sandbox and the resource sync use, so validation stays
  // authoritative here and no declaration is re-interpreted by the deploy path. Each collector
  // returns its resources already sorted by name, keeping the artifact checksum deterministic.
  const agents = collectAgents(files).agents;
  const agentSkills = collectAgentSkills(files).skills;
  // A connector's runtime projection is its integration file, which the artifact already carries;
  // the declaration travels beside it so the deployment records what the project declared.
  const connectors = collectConnectors(files).connectors;
  // P-9.11D: the context files the declared agents reference — server half only. Present
  // only when an agent actually declares one, keeping an artifact for a project without
  // context files byte-identical to before.
  const ctxProjection = projectContextFiles(files, agents);
  if (!ctxProjection.ok) return { ok: false, code: "ARTIFACT_ERROR", diagnostics: [ctxProjection.error] };
  const contextFiles = ctxProjection.contextFiles;

  // Declared workflows, read through their OWN resource contract — the same parser the resource
  // sync and the build use, so the artifact re-interprets nothing. Each entry is the EXACT
  // definition this version was built from (the shape the existing engine already executes, plus
  // the lineage key and the document fingerprint), so a deployed version carries immutable
  // automation configuration instead of pointing at a mutable definition row. A malformed document
  // is left out here and refused by verification below, never silently defaulted.
  const workflows = collectWorkflowFiles(files)
    .map((f) => ({ path: f.path, parsed: parseWorkflowDocument(f.path, f.content) }))
    .map(({ path, parsed }) => (parsed.ok
      ? { path, workflow_key: parsed.workflow_key, definition_checksum: parsed.definition_checksum, ...parsed.definition }
      : { path, workflow_key: null, error: parsed.error }))
    .sort((a, b) => a.path.localeCompare(b.path));

  // The EXACT dependency state this artifact was built from, READ from the lockfile the version
  // snapshot carries (shared/packageLock.ts — the same reader the build and the runtimes use). The
  // deploy path resolves nothing of its own and keeps no second dependency model: a project with no
  // lockfile has no state to record, so its artifact stays byte-identical to before.
  const dependencies = resolvedDependencyState(files);
  // B5: browser modules for the pinned packages, from the ONE shared producer the preview uses.
  // Absent (null) for a project that pins no packages, keeping its artifact byte-identical.
  let packageModulesOut = null;
  try { packageModulesOut = await packageModules(svc, files); }
  catch (e) { return { ok: false, code: e.code || "PACKAGE_MODULE_UNAVAILABLE", build, diagnostics: [`error: ${e.message}`] }; }

  const payload = {
    // canonical ordering keeps the checksum stable for identical project state
    client_files: clientFiles.map((f) => ({ path: f.path, content: f.content })).sort((a, b) => a.path.localeCompare(b.path)),
    functions: functionFiles.map((f) => ({ name: functionNameFromPath(f.path), path: f.path, source: f.content })).sort((a, b) => a.name.localeCompare(b.name)),
    // Present only when the project declares actors, so an artifact for a project with none is
    // byte-identical to before.
    ...(actors.length ? { actors } : {}),
    // Same rule for the other server-side resource kinds: present only when declared, so an
    // artifact for a project that declares none stays byte-identical to before.
    ...(agents.length ? { agents } : {}),
    ...(contextFiles.length ? { context_files: contextFiles } : {}),
    ...(agentSkills.length ? { agent_skills: agentSkills } : {}),
    ...(connectors.length ? { connectors } : {}),
    ...(workflows.length ? { workflows } : {}),
    ...(packageModulesOut ? { package_modules: packageModulesOut } : {}),
    integrations: integrations.sort((a, b) => a.name.localeCompare(b.name)),
    entities: entities.map((e) => ({ name: e.name, fields: e.fields, ...(e.rls ? { rls: e.rls } : {}) })).sort((a, b) => a.name.localeCompare(b.name)),
    // App metadata, plugin declarations and asset names travel WITH the artifact, so the public
    // runtime serves what the project declared. Each is present only when the project declares it,
    // leaving an artifact for a project that declares none byte-identical to before.
    config: {
      entry: ENTRY_FILE, version_number: version.number, project_id: project.id, framework: project.framework || "preact-htm",
      ...(build.app ? { app: build.app } : {}),
      ...(build.plugins?.length ? { plugins: build.plugins } : {}),
      ...(build.assets?.length ? { assets: build.assets.map((a) => a.name) } : {}),
      // Present only when the project pins a lockfile, keeping an artifact for a project with no
      // dependencies byte-identical to before. The lockfile itself ships with the client files, so
      // the recorded state can be checked against the shipped state at verification time.
      ...(dependencies.lockfile_present ? { dependencies } : {}),
    },
  };
  const json = JSON.stringify(payload);
  const checksum = await sha256(json);
  if (findings.length) {
    return { ok: false, code: "SECRET_LEAK", diagnostics: findings, checksum };
  }

  // Reproducible identity: the same version state reuses its existing artifact instead of
  // creating a duplicate, and an artifact row is never rewritten once created. Concurrent
  // builders of identical state converge to ONE canonical row — the earliest created,
  // tie-broken by id — deterministically, so every worker (reuse or fresh create) adopts
  // the same row instead of racing a second artifact into existence.
  const canonicalOf = (rows) => [...rows].sort((a, b) => (deploymentOrderKey(a) < deploymentOrderKey(b) ? -1 : 1))[0];
  const dedupe = async (rows) => {
    const canonical = canonicalOf(rows);
    // Duplicates left behind by a builder that died between create and its own convergence
    // are removed when nothing references them, so a checksum keeps exactly one canonical
    // row. A duplicate some deployment already references is kept — history stays truthful.
    for (const d of rows) {
      if (d.id === canonical.id) continue;
      const refs = await svc.entities.Deployment.filter({ artifact_id: d.id }, { sort: "-created_date", limit: 1 }).then((p) => p.items || []).catch(() => []);
      if (!refs.length) await svc.entities.DeploymentArtifact.delete(d.id).catch(() => {});
    }
    return canonical;
  };
  const existing = await svc.entities.DeploymentArtifact.filter({ project_id: project.id, checksum }, { sort: "-created_date", limit: 10 }).then((p) => p.items || []);
  if (existing.length) return { ok: true, artifact: await dedupe(existing), build, reused: true };

  const payload_url = await packJson(svc, `artifact_${project.id}_${checksum.slice(0, 12)}.json`, payload);
  const artifact = await svc.entities.DeploymentArtifact.create({
    project_id: project.id, version_id: version.id, version_number: version.number, checksum, payload_url,
    file_count: files.length, client_file_count: clientFiles.length,
    function_names: payload.functions.map((f) => f.name), integration_names: integrations.map((i) => i.name),
    entity_names: entities.map((e) => e.name), secret_names: [...requiredSecrets].sort(),
    // The SAME fingerprint the lockfile pinned — queryable without loading the payload, and never a
    // second fingerprint system. Null for a project that pins no dependencies.
    dependency_fingerprint: dependencies.dependency_fingerprint || null,
    secret_scan: "pass", secret_scan_findings: [], size_bytes: json.length, built_by: userId || null,
  });
  // Create-path convergence: a concurrent builder of the identical state may have committed
  // its row between the filter above and this create. Re-read and adopt the canonical row;
  // our own just-created duplicate is unreferenced (this call has not handed it to any
  // deployment yet), so removing it leaves exactly one canonical artifact row.
  const after = await svc.entities.DeploymentArtifact.filter({ project_id: project.id, checksum }, { sort: "-created_date", limit: 10 }).then((p) => p.items || []);
  const canonical = await dedupe(after);
  if (canonical.id !== artifact.id) return { ok: true, artifact: canonical, build, reused: true, converged: true };
  return { ok: true, artifact, build, reused: false };
}

export async function loadArtifactPayload(artifact) {
  return unpackJson(artifact.payload_url);
}

// --- lease (same contract as the agent loop) ---------------------------------
async function claimLease(svc, deployment) {
  const now = Date.now();
  const held = Date.parse(deployment.lease_expires_at || "");
  if (Number.isFinite(held) && held > now) return null;
  const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  await svc.entities.Deployment.update(deployment.id, { lease_token: token, lease_expires_at: new Date(now + LEASE_MS).toISOString() });
  const check = await svc.entities.Deployment.get(deployment.id);
  return check.lease_token === token ? token : null;
}

// Ownership of a deployment's terminal outcome. Thrown by the ownership-checked writes in
// runDeploymentStep when THIS worker's lease no longer matches the row, and recognized by
// the worker's catch, which then writes nothing further — the lease's current owner owns
// the deployment's outcome.
const DEPLOY_OWNERSHIP_LOST = "DEPLOY_OWNERSHIP_LOST";
const ownershipLost = () => Object.assign(new Error("deployment lease ownership was lost"), { code: DEPLOY_OWNERSHIP_LOST });

// Total order over deployments: created_date, tie-broken by id, so every request or worker
// comparing two rows computes the SAME winner regardless of when it reads them.
const deploymentOrderKey = (d) => `${d.created_date || ""}|${d.id}`;

/**
 * Convergence for the check-then-create race: two concurrent requests can both pass the
 * in-progress guard and both create a QUEUED deployment for one environment. The
 * deterministic rule is FIRST REQUEST WINS — an active deployment created EARLIER keeps
 * the environment, and a request that finds one cancels its OWN row (a compare-and-set on
 * status QUEUED, so a twin a worker already started is left to the switch-time convergence
 * in runDeploymentStep) and reports the winner.
 */
export async function convergeDeploymentRequest(svc, { project_id, environment, deployment }) {
  const env = normalizeEnvironment(environment || DEFAULT_ENVIRONMENT);
  const rows = await svc.entities.Deployment.filter({ project_id }, { sort: "-created_date", limit: 40 }).then((p) => p.items || []);
  const mine = rows.find((d) => d.id === deployment.id) || deployment;
  const twin = rows.find((d) =>
    d.id !== deployment.id && DEPLOY_ACTIVE.includes(d.status) &&
    normalizeEnvironment(d.environment || DEFAULT_ENVIRONMENT) === env &&
    deploymentOrderKey(d) < deploymentOrderKey(mine));
  if (!twin) return { cancelled: false, deployment: mine };
  const claim = await svc.entities.Deployment.updateMany(
    { id: deployment.id, status: "QUEUED" },
    { $set: {
      status: "CANCELLED", failure_code: "SUPERSEDED_BY_CONCURRENT_REQUEST",
      failure_summary: "Another deployment of this environment was already in progress; this duplicate request was dropped.",
      superseded_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    } },
  ).catch(() => null);
  if (!Number(claim?.updated || 0)) return { cancelled: false, deployment: mine, contested: true };
  return { cancelled: true, deployment: mine, winner: twin };
}

// Ownership-checked release: a worker whose lease was reclaimed updates zero rows, so a
// zombie can never clear the new owner's lease from under it.
const releaseLease = (svc, id, token) => (token
  ? svc.entities.Deployment.updateMany({ id, lease_token: token }, { $set: { lease_token: null, lease_expires_at: null } }).catch(() => {})
  : Promise.resolve());

// --- verification ------------------------------------------------------------
// Real checks against the real artifact and the real production data path. Anything that
// fails here keeps the deployment out of production.
export async function verifyDeployment(svc, { project, deployment, artifact }) {
  const checks = [];
  const fail = (name, detail) => { checks.push({ name, ok: false, detail: trunc(detail, 200) }); };
  const pass = (name, detail) => { checks.push({ name, ok: true, detail: trunc(detail, 200) }); };

  let payload;
  try {
    payload = await loadArtifactPayload(artifact);
    pass("artifact_loads", `${payload.client_files.length} client files, ${payload.functions.length} function(s)`);
  } catch (e) {
    fail("artifact_loads", e.message);
    return { ok: false, checks };
  }

  // Frontend: the entry module and every relative import it needs must exist in the artifact.
  const byPath = new Map(payload.client_files.map((f) => [f.path, f.content]));
  const entry = byPath.get(payload.config.entry);
  if (!entry) fail("frontend_serves", `missing ${payload.config.entry}`);
  else {
    const missing = [];
    for (const [path, content] of byPath) {
      for (const m of String(content).matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")).split("/") : [];
        for (const seg of m[1].split("/")) { if (seg === "." || seg === "") continue; if (seg === "..") dir.pop(); else dir.push(seg); }
        const resolved = dir.join("/");
        if (!byPath.has(resolved)) missing.push(`${path} → ${m[1]}`);
      }
    }
    if (missing.length) fail("frontend_serves", `unresolved imports: ${missing.slice(0, 3).join(", ")}`);
    else pass("frontend_serves", `entry ${payload.config.entry} resolves`);
  }

  // Backend: every packaged function must load and expose a handler in the sandbox.
  let backendOk = true;
  for (const fn of payload.functions) {
    try {
      const { handler } = await readFunctionConfig(fn.source);
      if (typeof handler !== "function") { backendOk = false; fail("backend_responds", `${fn.name} has no handler`); break; }
    } catch (e) { backendOk = false; fail("backend_responds", `${fn.name}: ${e.message}`); break; }
  }
  if (backendOk) pass("backend_responds", payload.functions.length ? `${payload.functions.length} function(s) load` : "no backend functions");

  // Database: the production data path for this project is reachable and scoped to it.
  try {
    const rows = await svc.entities.AppRecord.filter({ project_id: project.id }, { sort: "-created_date", limit: 5 }).then((p) => p.items || []);
    const foreign = rows.filter((r) => r.project_id !== project.id).length;
    if (foreign) fail("database_scoped", `${foreign} record(s) outside this project`);
    else pass("database_scoped", `${rows.length} record(s) visible, all project-scoped`);
  } catch (e) { fail("database_scoped", e.message); }

  // Secrets: required names must be configured AND readable server-side only.
  const secretRows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, { sort: "name", limit: 200 }).then((p) => p.items || []);
  const byName = new Map(secretRows.map((s) => [s.name, s]));
  const { values: verifyPlaintexts, failed: undecryptable } = await resolveSecretValues(secretRows, project.id);
  const missingSecrets = (artifact.secret_names || []).filter((n) => { const r = byName.get(n); return !r || (!r.value && r.required !== false); });
  const unreadable = undecryptable.filter((n) => (artifact.secret_names || []).includes(n));
  if (unreadable.length) fail("secrets_available", `unreadable at rest: ${unreadable.join(", ")}`);
  else if (missingSecrets.length) fail("secrets_available", `not configured: ${missingSecrets.join(", ")}`);
  else pass("secrets_available", `${(artifact.secret_names || []).length} required secret(s) resolved server-side`);

  // Leak scan re-run against the artifact that is actually about to go live.
  const leaks = scanForSecrets(payload.client_files, [...verifyPlaintexts.values()]);
  if (leaks.length) fail("no_secret_leak", leaks.slice(0, 3).join(" | "));
  else pass("no_secret_leak", "0 credentials in client bundle");

  // Dependencies: what the artifact RECORDED at build time must be exactly what its client files
  // SHIP. Both sides are read through the one dependency reader, so a lockfile edited after the
  // build — or a lockfile that no longer agrees with its manifest — keeps the deployment out of
  // production instead of serving code against packages nobody verified. A project that pins no
  // dependencies has nothing to compare and passes cleanly.
  const recordedDeps = payload.config?.dependencies || null;
  const shippedDeps = resolvedDependencyState(payload.client_files);
  const shippedDocs = validateDependencyFiles(payload.client_files);
  if (!recordedDeps && !shippedDeps.lockfile_present) pass("dependencies_pinned", "this project pins no dependencies");
  else if (!recordedDeps || !shippedDeps.lockfile_present) {
    fail("dependencies_pinned", recordedDeps ? "the artifact records a dependency state but ships no lockfile" : `the artifact ships a lockfile (${shippedDeps.package_count} package(s)) but records no dependency state`);
  } else if (!shippedDocs.ok) fail("dependencies_pinned", `the shipped dependency files are not valid: ${shippedDocs.errors[0]}`);
  else if (recordedDeps.dependency_fingerprint !== shippedDeps.dependency_fingerprint) {
    fail("dependencies_pinned", `the shipped lockfile pins ${shippedDeps.dependency_fingerprint} but the artifact was built against ${recordedDeps.dependency_fingerprint}`);
  } else if (artifact.dependency_fingerprint && artifact.dependency_fingerprint !== shippedDeps.dependency_fingerprint) {
    fail("dependencies_pinned", `the artifact row records ${artifact.dependency_fingerprint} but the shipped lockfile pins ${shippedDeps.dependency_fingerprint}`);
  } else {
    const drifted = (recordedDeps.packages || []).filter((p) => !shippedDeps.packages.some((s) => s.name === p.name && s.version === p.version));
    // B5: the shipped package modules must match the shipped lockfile pins and their digests.
    const modulesCheck = drifted.length ? null : await verifyPackageModules(payload.package_modules || null, shippedDeps.packages);
    if (drifted.length) fail("dependencies_pinned", `shipped versions differ for ${drifted.map((p) => `${p.name}@${p.version}`).join(", ")}`);
    else if (!modulesCheck.ok) fail("dependencies_pinned", `package modules: ${modulesCheck.error}`);
    else pass("dependencies_pinned", `${shippedDeps.package_count} package(s) pinned at ${shippedDeps.dependency_fingerprint}, ${modulesCheck.count || 0} module digest(s) verified`);
  }

  // Workflows: every workflow the ARTIFACT ships must be executable in THIS deployed version.
  // The definitions are read from the immutable artifact payload, never from a mutable
  // WorkflowDefinition row, so what is verified is exactly what the deployment will execute. The
  // existing contract validator owns the rules (step references, primitives, function references,
  // triggers, reachability, acyclicity); this check only supplies the deployed function list and
  // the runtime dependencies a deployed workflow additionally needs. A project that ships no
  // workflows has nothing to verify and passes cleanly.
  const shippedWorkflows = Array.isArray(payload.workflows) ? payload.workflows : [];
  if (!shippedWorkflows.length) pass("workflows_executable", "this version ships no workflows");
  else {
    const deployedFunctions = payload.functions.map((f) => f.name);
    const problems = [];
    const seenKeys = new Map();
    for (const wf of shippedWorkflows) {
      // A document that did not parse at build time travels as a stated error, never a default.
      if (wf.error || !wf.workflow_key) { problems.push(`${wf.path}: ${wf.error || "has no workflow identity"}`); continue; }
      if (seenKeys.has(wf.workflow_key)) { problems.push(`${wf.path}: resolves to the same workflow as ${seenKeys.get(wf.workflow_key)}`); continue; }
      seenKeys.set(wf.workflow_key, wf.path);
      const report = validateWorkflow(wf, { functionNames: deployedFunctions });
      if (!report.ok) { problems.push(`${wf.path}: ${report.errors.join("; ")}`); continue; }
      // Runtime dependency of a scheduled workflow: the function its trigger runs under must be
      // packaged in this artifact too, or the deployed schedule could never execute.
      const scheduleFn = String(wf.trigger?.type) === "schedule" ? String(wf.trigger.function_name || "") : "";
      if (scheduleFn && !deployedFunctions.includes(scheduleFn)) {
        problems.push(`${wf.path}: schedule trigger runs "${scheduleFn}", which this version does not ship`);
      }
    }
    if (problems.length) fail("workflows_executable", problems.slice(0, 3).join(" | "));
    else pass("workflows_executable", `${shippedWorkflows.length} workflow(s) executable against ${deployedFunctions.length} deployed function(s)`);
  }

  // Routing identity: this environment's address must resolve to this project and version.
  const env = normalizeEnvironment(deployment.environment || DEFAULT_ENVIRONMENT);
  if (!project.slug) fail("routing_correct", "project has no public slug");
  else if (artifact.project_id !== project.id) fail("routing_correct", "artifact belongs to another project");
  else if (artifact.version_id !== deployment.version_id) fail("routing_correct", "artifact does not match the deployment version");
  else pass("routing_correct", `${deploymentPath(project.slug, env)} (${env}) → version ${artifact.version_number}`);

  return { ok: checks.every((c) => c.ok), checks };
}

// --- the deployment worker ---------------------------------------------------
const deployFail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/**
 * THE authorized "deploy a version" request: the ONE place a plain user deployment is created.
 * Shared by the deployProject endpoint and the CLI, so both apply the same authorization
 * (deploy.manage), the same per-caller rate limit, the same one-at-a-time-per-environment guard
 * and the same cross-project version check. Returns the QUEUED deployment; the executor drives it.
 */
export async function requestDeployment(base44, user, { project_id, environment: env = "production", version_id = null } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "deploy.manage");
  const svc = base44.asServiceRole || base44;
  await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspace.id }), action: "deploy", workspace_id: workspace.id });
  // Plan entitlement (P-10.5), fail-closed and BEFORE any request state is read or written:
  // a non-active workspace lifecycle and an exhausted daily deployment ceiling both refuse the
  // request outright, so no in-progress guard or validation error can mask the entitlement
  // verdict. Limits come only from the server-side plan; the request supplies none of them.
  if (workspace.status && workspace.status !== "active") {
    throw deployFail(402, "WORKSPACE_NOT_ENTITLED", `Workspace is ${workspace.status}; deployments are suspended`);
  }
  await assertDeploymentQuota(base44, workspace);
  const environment = normalizeEnvironment(env || "production");

  const recent = await svc.entities.Deployment.filter({ project_id: project.id }, { sort: "-created_date", limit: 40 }).then((p) => p.items || []);
  const active = recent.find((d) => DEPLOY_ACTIVE.includes(d.status) && (d.environment || "production") === environment);
  if (active) throw deployFail(409, "DEPLOYMENT_IN_PROGRESS", `A ${environment} deployment is already in progress for this project`, { deployment_id: active.id });

  let version;
  if (version_id) {
    version = await svc.entities.ProjectVersion.get(version_id).catch(() => null);
    if (!version || version.project_id !== project.id) throw deployFail(404, "VERSION_NOT_FOUND", "Version not found in this project");
  } else {
    version = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, { sort: "-number", limit: 1 }).then((p) => p.items || []))[0] || null;
    if (!version) throw deployFail(400, "NO_VERSION", "This project has no versions yet — build it first");
  }

  const slug = await ensureProjectSlug(svc, project);
  const now = new Date().toISOString();
  // createDeploymentWithinLimit re-derives today's count after the row exists, so racing
  // requests that both passed the early quota check cannot land past the ceiling.
  const deployment = await createDeploymentWithinLimit(base44, workspace, {
    project_id: project.id, workspace_id: workspace.id, version_id: version.id, version_number: version.number,
    environment, status: "QUEUED", trigger: "user",
    deployment_url: deploymentPath(slug, environment), deployed_by: user.id,
    cancel_requested: false, recovery_count: 0, started_at: now, heartbeat_at: now,
  });
  // The audit row is written with the service role: the trail is the platform's, not the caller's,
  // so a caller who may deploy but holds no direct AuditLog write still gets an audited deployment.
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "deployment.requested", resource: "Deployment", resource_id: deployment.id,
    metadata: { version: version.number, environment, rollback_of: null, promoted_from: null },
  });
  // Converge the check-then-create race: if an earlier deployment of this environment is
  // already active, this request loses deterministically — its row is cancelled and the
  // caller sees the same in-progress error the guard above already produces.
  const converged = await convergeDeploymentRequest(svc, { project_id: project.id, environment, deployment });
  if (converged.cancelled) {
    throw deployFail(409, "DEPLOYMENT_IN_PROGRESS", `A ${environment} deployment is already in progress for this project`, { deployment_id: converged.winner.id });
  }
  return { deployment: converged.deployment, project, workspace, version, slug, environment };
}

// Advances one deployment as far as it can inside a single request, persisting every
// phase transition. A killed worker resumes exactly where it stopped.
export async function runDeploymentStep(svc, deploymentId) {
  let deployment = await svc.entities.Deployment.get(deploymentId);
  if (!deployment) throw new Error(`Deployment not found: ${deploymentId}`);
  if (DEPLOY_TERMINAL.includes(deployment.status)) return { deployment_id: deploymentId, done: true, status: deployment.status };

  const token = await claimLease(svc, deployment);
  if (!token) return { deployment_id: deploymentId, done: false, busy: true, status: deployment.status };
  const started = Date.now();

  const patch = async (data) => {
    const payload = { ...data, heartbeat_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString() };
    // Ownership-checked write: only THIS worker's lease may advance the deployment, so a
    // zombie whose lease expired and was reclaimed cannot keep mutating phases or extending
    // the new owner's lease.
    const claim = await svc.entities.Deployment.updateMany({ id: deployment.id, lease_token: token }, { $set: payload });
    if (!Number(claim?.updated || 0)) throw ownershipLost();
    Object.assign(deployment, payload);
    return deployment;
  };

  const project = await svc.entities.Project.get(deployment.project_id);

  const finish = async (status, extra) => {
    const startedMs = Date.parse(deployment.started_at || deployment.created_date);
    // Ownership-checked TERMINAL write (LIVE / FAILED / CANCELLED): the compare-and-set on
    // the lease token makes a terminal transition single-writer — a worker whose lease
    // expired and was reclaimed updates zero rows and reports the loss instead of writing
    // an outcome behind the new owner's back.
    const claim = await svc.entities.Deployment.updateMany(
      { id: deployment.id, lease_token: token },
      { $set: {
        status, completed_at: new Date().toISOString(),
        duration_ms: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
        heartbeat_at: new Date().toISOString(), lease_token: null, lease_expires_at: null, ...extra,
      } },
    );
    if (!Number(claim?.updated || 0)) return { deployment_id: deploymentId, done: false, busy: true, ownership_lost: true, status: "skipped" };
    await audit(svc, {
      workspace_id: deployment.workspace_id, project_id: deployment.project_id, user_id: deployment.deployed_by,
      action: `deployment.${status.toLowerCase()}`, resource: "Deployment", resource_id: deployment.id,
      metadata: { version: deployment.version_number, artifact: deployment.artifact_checksum || null, failure_code: extra?.failure_code || null },
    });
    return { deployment_id: deploymentId, done: true, status };
  };

  try {
    while (Date.now() - started < ITERATION_BUDGET_MS) {
      deployment = await svc.entities.Deployment.get(deploymentId);
      if (DEPLOY_TERMINAL.includes(deployment.status)) return { deployment_id: deploymentId, done: true, status: deployment.status };
      if (deployment.lease_token !== token) return { deployment_id: deploymentId, done: false, busy: true, status: deployment.status };

      // Cancellation is only honoured before the production switch: once a deployment is
      // LIVE it is history, and history is never rewritten.
      if (deployment.cancel_requested) {
        return await finish("CANCELLED", { failure_code: "CANCELLED", failure_summary: "Cancelled before going live; production was left untouched." });
      }

      if (deployment.status === "QUEUED") {
        await patch({ status: "BUILDING", started_at: deployment.started_at || new Date().toISOString() });
        const version = await svc.entities.ProjectVersion.get(deployment.version_id).catch(() => null);
        if (!version || version.project_id !== project.id) {
          return await finish("FAILED", { failure_code: "ARTIFACT_ERROR", failure_summary: "The version being deployed does not belong to this project." });
        }
        // PROMOTION: the artifact was decided at request time and is reused byte-for-byte —
        // no rebuild, so the bits that were verified in the source environment are exactly
        // the bits that go live here. It still goes through the full verification pass.
        if (deployment.artifact_id) {
          const preset = await svc.entities.DeploymentArtifact.get(deployment.artifact_id).catch(() => null);
          if (!preset || preset.project_id !== project.id || preset.version_id !== version.id) {
            return await finish("FAILED", { failure_code: "ARTIFACT_ERROR", failure_summary: "The artifact being promoted does not belong to this project version." });
          }
          await patch({ status: "DEPLOYING", artifact_checksum: preset.checksum, build_error_count: 0, secret_scan: "pass", build_diagnostics: [] });
          continue;
        }
        const result = await buildArtifact(svc, { project, version, userId: deployment.deployed_by });
        if (!result.ok) {
          // Build/scan failure is terminal for THIS deployment only: production keeps
          // serving whatever was already live, and no version is created.
          return await finish("FAILED", {
            failure_code: result.code,
            failure_summary: result.code === "SECRET_LEAK"
              ? `Blocked: ${result.diagnostics.length} credential finding(s) in client code. Nothing was deployed.`
              : `Production build failed with ${result.build?.errors || result.diagnostics.length} error(s). Nothing was deployed.`,
            build_error_count: result.build?.errors || result.diagnostics.length,
            build_diagnostics: result.diagnostics.slice(0, 20),
            secret_scan: result.code === "SECRET_LEAK" ? "fail" : "unknown",
          });
        }
        await patch({
          status: "DEPLOYING", artifact_id: result.artifact.id, artifact_checksum: result.artifact.checksum,
          build_error_count: 0, secret_scan: "pass", build_diagnostics: [],
        });
        continue;
      }

      if (deployment.status === "DEPLOYING") {
        // "Deploying" is publishing the immutable artifact to the platform's public
        // runtime route for THIS environment. No second runtime is provisioned: the runtime
        // resolves the environment's current deployment and serves that artifact.
        const slug = await ensureProjectSlug(svc, project);
        const env = normalizeEnvironment(deployment.environment || DEFAULT_ENVIRONMENT);
        await patch({ status: "VERIFYING", deployment_url: deploymentPath(slug, env) });
        continue;
      }

      if (deployment.status === "VERIFYING") {
        const artifact = await svc.entities.DeploymentArtifact.get(deployment.artifact_id).catch(() => null);
        if (!artifact) return await finish("FAILED", { failure_code: "ARTIFACT_ERROR", failure_summary: "The build artifact could not be loaded." });
        const { ok, checks } = await verifyDeployment(svc, { project, deployment, artifact });
        const failed = checks.filter((c) => !c.ok);
        if (!ok) {
          return await finish("FAILED", {
            failure_code: "VERIFICATION_FAILED",
            failure_summary: `Health verification failed: ${failed.map((c) => c.name).join(", ")}. Production was not changed.`,
            build_diagnostics: failed.map((c) => `${c.name}: ${c.detail}`),
            verification: `${checks.length - failed.length}/${checks.length} checks passed`,
            secret_scan: failed.some((c) => c.name === "no_secret_leak") ? "fail" : "pass",
          });
        }

        // PRODUCTION SWITCH. Two rows must change, so the ORDER is what makes an
        // interrupted switch safe:
        //   1. this deployment becomes LIVE
        //   2. the previous one is stamped superseded
        //   3. the project's production pointer is updated (a cache of 1+2)
        // Die anywhere in here and production is still coherent, because the servable
        // deployment is DERIVED (see currentLiveDeployment): the newest LIVE deployment
        // that has not been superseded. The reverse order could leave the pointer aimed
        // at a deployment that is not yet LIVE, which would take the app offline.
        const env = normalizeEnvironment(deployment.environment || DEFAULT_ENVIRONMENT);
        const fields = pointerFields(env);
        const liveOut = await finish("LIVE", {
          verification: `${checks.length}/${checks.length} checks passed`, secret_scan: "pass",
          failure_code: null, failure_summary: null,
        });
        // Lost the lease at the moment of the switch: the new owner owns the deployment —
        // no supersede stamp, no pointer write.
        if (!liveOut.done) return liveOut;
        // ENVIRONMENT ACTIVATION CONVERGENCE: at most one unsuperseded LIVE per environment.
        // Two requests that raced past the request-time convergence can both reach their
        // switch; the deployment that ACTIVATES LATER wins the environment, exactly like a
        // sequential redeploy. Every EARLIER unsuperseded deployment of THIS environment is
        // stamped superseded through a compare-and-set (superseded_at still absent), so for
        // any racing pair exactly one direction of the stamp ever matches — the workers
        // converge on the same single unsuperseded LIVE row whatever the interleaving. A
        // row that was itself already stamped by a later activation writes nothing: the
        // pointer already follows the winner (and the reconciler repairs the cache
        // otherwise). Only THIS environment's rows are touched, so a staging switch can
        // never disturb production.
        const freshSelf = await svc.entities.Deployment.get(deployment.id).catch(() => null);
        if (freshSelf && !freshSelf.superseded_at) {
          const envRows = await svc.entities.Deployment.filter({ project_id: project.id }, { sort: "-created_date", limit: 60 }).then((p) => p.items || []);
          const mine = deploymentOrderKey(freshSelf);
          const earlier = envRows.filter((d) =>
            d.id !== deployment.id && !d.superseded_at &&
            normalizeEnvironment(d.environment || DEFAULT_ENVIRONMENT) === env &&
            deploymentOrderKey(d) < mine);
          for (const r of earlier) {
            await svc.entities.Deployment.updateMany(
              // null-or-absent: a stored row normalizes an absent stamp to null, so $exists
              // alone never matched and the stamp was silently lost. A row already stamped
              // (non-null) matches neither, so the single-writer guarantee is unchanged.
              { id: r.id, superseded_at: null },
              { $set: { superseded_at: new Date().toISOString() } },
            ).catch(() => {});
          }
          await svc.entities.Project.update(project.id, {
            [fields.deployment]: deployment.id, [fields.version]: deployment.version_number,
          }).catch(() => {});
        }
        // Referral (Slice 2), fail-safe: this production LIVE switch is the publish condition
        // of the referrer reward. Never breaks the deployment outcome.
        if (env === "production") {
          try {
            await maybeGrantReferrerReward(svc, {
              user_id: deployment.deployed_by || null, workspace_id: deployment.workspace_id,
              project_id: project.id, event: "publish",
            });
          } catch {}
          // app_publish (DOCUMENTED Base44 workflow trigger), fail-safe: fires on the project's
          // successful production LIVE publication. The deployment id is the idempotency key;
          // a dispatch failure never breaks the deployment outcome.
          await emitAppPublish(svc, {
            project, workspace_id: deployment.workspace_id, deployment_id: deployment.id,
            version_number: deployment.version_number || null, deployment_url: deployment.deployment_url || null,
          });
        }
        return { deployment_id: deploymentId, done: true, status: "LIVE" };
      }

      // BUILDING with no artifact yet means a worker died mid-build: restart that phase.
      if (deployment.status === "BUILDING") { await patch({ status: "QUEUED" }); continue; }
      return { deployment_id: deploymentId, done: false, status: deployment.status };
    }
    return { deployment_id: deploymentId, done: false, status: deployment.status };
  } catch (e) {
    // A worker that lost lease ownership writes NOTHING further — not even a failure: the
    // lease's current owner owns the deployment's outcome.
    if (e?.code === DEPLOY_OWNERSHIP_LOST) {
      return { deployment_id: deploymentId, done: false, busy: true, ownership_lost: true, status: "skipped" };
    }
    return await finish("FAILED", { failure_code: "DEPLOY_ERROR", failure_summary: trunc(e.message, 400) });
  } finally {
    await releaseLease(svc, deploymentId, token);
  }
}
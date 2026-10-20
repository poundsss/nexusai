// CERTIFICATION for the NexusAI Dependency / Package System (#26).
//
//   declare → validate → resolve → install → build → version → deploy → verify
//
// Runs against the REAL modules and the REAL data layer: the real manifest/lockfile reader, the real
// resolver, the real dependency mutation path (which commits through the existing versioning path),
// the real sandbox install command, the real build engine, the real artifact builder, the real
// deployment worker and verification pass, the real shared execution contract, the real type-emission
// path and the real #25 architecture graph. Nothing is stubbed, and this suite introduces no second
// dependency manager, resolver, registry, build dependency system or dependency graph.
//
// Scope: this suite certifies the BUILD / ARTIFACT / DEPLOYMENT-VERIFICATION half of #26 that
// dependenciesTest (mutation, resolution, tracing) and packageSupplyTest (supply chain) do not cover.
// Assertions state the REQUIRED behaviour; a requirement the platform does not yet implement is
// reported as a failing check rather than softened.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  listDependencies, addDependency, removeDependency, updateDependency, applyDependencyChange,
  validateDependencies, inspectDependencyTree, readManifest, readLockfile,
  MANIFEST_FILE, LOCKFILE_FILE, LOCKFILE_VERSION,
} from "../../shared/dependencies.ts";
import { installedPackages, resolvedDependencyState } from "../../shared/packageLock.ts";
import { resolveDependencies, RUNTIME_TARGET } from "../../shared/packageRegistry.ts";
import { loadProjectState } from "../../shared/authz.ts";
import { createFs, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { unpackSnapshot } from "../../shared/blobStore.ts";
import { sandboxRun } from "../../shared/sandbox.ts";
import {
  buildArtifact, verifyDeployment, loadArtifactPayload, ensureProjectSlug,
  currentLiveDeployment, runDeploymentStep, deploymentPath,
} from "../../shared/deploy.ts";
import { createExecutionContext } from "../../shared/executionContract.ts";
import { emitProjectTypes } from "../../shared/typeEmit.ts";
import { reconcileArchitecture } from "../../shared/architecture.ts";
import { ENTRY_FILE, RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const ENTRY_SOURCE = `import { html, render } from "runtime";
export default function App() { return html\`<div>dependency certification</div>\`; }
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const USES_PACKAGE = `import { formatMoney } from "@nexus/currency";
export function line(value) { return formatMoney(value); }
`;
const PKG = "@nexus/currency";
const TRANSITIVE = "@nexus/decimal";

export default async function (req) {
  const harness = createHarness();
  // Lazy assertion: a condition thunk that throws records a FAILED check carrying the error, so the
  // suite always reports every declared check instead of aborting on one missing value.
  const certify = (name, condition, detail = "") => {
    let ok;
    try { ok = typeof condition === "function" ? condition() : condition; }
    catch (e) { return harness.check(name, false, `assertion threw ${e.name}: ${e.message}`); }
    let text;
    try { text = typeof detail === "function" ? detail() : detail; } catch (e) { text = `detail unavailable: ${e.message}`; }
    return harness.check(name, ok, text);
  };
  const report = (thrown = null) => {
    const s = harness.summary();
    return Response.json({
      ok: s.ok && !thrown,
      error: thrown?.message || null,
      stack: thrown ? String(thrown.stack || "").slice(0, 700) : null,
      passed: s.passed, failed: s.failed,
      first_failing_check: s.failures[0] || null,
      failures: s.failures, checks_run: s.results.length,
    }, { status: thrown ? 500 : 200 });
  };

  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const scratch = { workspaces: [], projects: [] };
  const projectFiles = async (pid) => (await svc.entities.ProjectFile.filter({ project_id: pid }, "path", 100)).map((f) => ({ path: f.path, content: f.content }));
  const dependencyRows = (pid) => svc.entities.ProjectDependency.filter({ project_id: pid }, "package_name", 50);
  const refusalOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const stamp = Date.now();
    const trace_id = `tr_deppkg_${stamp}`;

    // ------------------------------------------------------------------ fixtures
    const ws = await svc.entities.Workspace.create({ name: `deppkg-${stamp}`, owner_id: user.id, status: "active" });
    scratch.workspaces.push(ws.id);
    const seedProject = async (name, files) => {
      const p = await svc.entities.Project.create({ workspace_id: ws.id, name, framework: "preact-htm", status: "draft", version_count: 0 });
      scratch.projects.push(p.id);
      for (const [path, content] of Object.entries(files)) await svc.entities.ProjectFile.create({ project_id: p.id, path, content });
      return p;
    };
    const project = await seedProject(`dep main ${stamp}`, { [ENTRY_FILE]: ENTRY_SOURCE, "src/components/report.js": USES_PACKAGE });
    // A project that declares NO dependencies at all — the legacy shape that must stay untouched.
    const legacy = await seedProject(`dep legacy ${stamp}`, { [ENTRY_FILE]: ENTRY_SOURCE });
    // A project in a workspace this caller is NOT a member of.
    const foreignWs = await svc.entities.Workspace.create({ name: `deppkg-foreign-${stamp}`, owner_id: `not-${user.id}`, status: "active" });
    scratch.workspaces.push(foreignWs.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 0 });
    scratch.projects.push(foreign.id);
    await svc.entities.ProjectFile.create({ project_id: foreign.id, path: ENTRY_FILE, content: ENTRY_SOURCE });

    // Deployment through the REAL worker: create the row the control plane creates, then advance it.
    const goLive = async (proj, version) => {
      const slug = await ensureProjectSlug(svc, proj);
      const now = new Date().toISOString();
      const row = await svc.entities.Deployment.create({
        project_id: proj.id, workspace_id: proj.workspace_id, version_id: version.id, version_number: version.number,
        environment: "production", status: "QUEUED", trigger: "user", deployment_url: deploymentPath(slug, "production"),
        deployed_by: user.id, cancel_requested: false, recovery_count: 0, started_at: now, heartbeat_at: now,
      });
      for (let i = 0; i < 8; i++) { if ((await runDeploymentStep(svc, row.id)).done) break; }
      const settled = await svc.entities.Deployment.get(row.id);
      const live = settled.status === "LIVE" ? settled : await currentLiveDeployment(svc, await svc.entities.Project.get(proj.id), "production");
      const artifact = live?.artifact_id ? await svc.entities.DeploymentArtifact.get(live.artifact_id) : null;
      const verification = artifact
        ? await verifyDeployment(svc, { project: await svc.entities.Project.get(proj.id), deployment: live, artifact })
        : { ok: false, checks: [] };
      return { deployment: settled, live, artifact, verification, payload: artifact ? await loadArtifactPayload(artifact) : { client_files: [], config: {} } };
    };

    // ============================================================ 1. manifest loads
    const initial = await listDependencies(base44, user, { project_id: project.id });
    certify("1 the package manifest surface loads, and an absent manifest is a valid empty state",
      () => initial.count === 0 && initial.manifest_present === false && initial.lockfile_present === false &&
        initial.runtime_target === RUNTIME_TARGET && initial.install_scripts_blocked === true &&
        initial.validation.status !== "error",
      () => `no ${MANIFEST_FILE} / ${LOCKFILE_FILE} · runtime ${initial.runtime_target} · validation ${initial.validation.status}`);

    // ============================================================ 2. valid declaration
    const declared = await addDependency(base44, user, { project_id: project.id, package_name: PKG, version: "^1.0.0", trace_id });
    const afterDeclare = await projectFiles(project.id);
    const manifest = readManifest(afterDeclare);
    const lock = readLockfile(afterDeclare);
    certify("2 a valid dependency declaration is accepted and becomes the project's authoritative state",
      () => declared.applied === true && declared.build.status === "success" &&
        manifest.exists === true && manifest.dependencies[PKG] === "^1.0.0" &&
        lock.exists === true && lock.lockfile_version === LOCKFILE_VERSION &&
        lock.fingerprint === declared.dependency_fingerprint &&
        lock.packages.length >= 2 && lock.packages.every((p) => /^\d+\.\d+\.\d+$/.test(p.version) && p.integrity),
      () => `${Object.keys(manifest.dependencies).length} declared · ${lock.packages.length} pinned · ${lock.fingerprint}`);

    // ============================================================ 3. invalid package name
    const badNames = ["../evil", "Not Valid", "a".repeat(200), "pkg/../x", ""];
    const nameRefusals = [];
    for (const n of badNames) nameRefusals.push(await refusalOf(() => addDependency(base44, user, { project_id: project.id, package_name: n, version: "^1.0.0", trace_id })));
    const repeatRefusal = await refusalOf(() => addDependency(base44, user, { project_id: project.id, package_name: "../evil", version: "^1.0.0", trace_id }));
    const manifestAfterBadNames = readManifest(await projectFiles(project.id));
    certify("3 an invalid package name is refused deterministically and writes nothing",
      () => nameRefusals.every((e) => e && e.status >= 400 && typeof e.code === "string") &&
        nameRefusals[0].code === repeatRefusal.code &&
        // A refused name must never reach the manifest, and the good declaration must survive.
        Object.keys(manifestAfterBadNames.dependencies).join(",") === PKG,
      () => `${nameRefusals.length} refusals: ${nameRefusals.map((e) => e?.code).join(",")} · manifest still ${Object.keys(manifestAfterBadNames.dependencies).join(",")}`);

    // ============================================================ 4. malformed documents
    const badManifestFiles = (await projectFiles(project.id)).map((f) => (f.path === MANIFEST_FILE ? { ...f, content: "{ not json" } : f));
    const badLockFiles = (await projectFiles(project.id)).map((f) => (f.path === LOCKFILE_FILE ? { ...f, content: "{oops" } : f));
    let manifestReadError = null, lockReadError = null;
    try { readManifest(badManifestFiles); } catch (e) { manifestReadError = e.code; }
    try { readLockfile(badLockFiles); } catch (e) { lockReadError = e.code; }
    const buildBadManifest = runBuild(createFs(badManifestFiles), [], []);
    const buildBadLock = runBuild(createFs(badLockFiles), [], []);
    certify("4 a malformed dependency document is rejected — by the reader AND by the build",
      () => manifestReadError === "MANIFEST_INVALID" && lockReadError === "LOCKFILE_INVALID" &&
        buildBadManifest.status === "failed" && buildBadLock.status === "failed",
      () => `reader: ${manifestReadError}/${lockReadError} · build: manifest ${buildBadManifest.status}, lockfile ${buildBadLock.status}`);

    // ============================================================ 5. version validation
    const badRange = await refusalOf(() => addDependency(base44, user, { project_id: project.id, package_name: TRANSITIVE, version: "not-a-range", trace_id }));
    const emptyRange = await refusalOf(() => updateDependency(base44, user, { project_id: project.id, package_name: PKG, version: "1.x", trace_id }));
    const validation = await validateDependencies(base44, user, { project_id: project.id });
    certify("5 dependency versions are validated: an unsupported range is refused, pinned state validates",
      () => badRange?.code === "INVALID_VERSION" && emptyRange?.code === "INVALID_VERSION" &&
        validation.passed === true && validation.drift.length === 0 &&
        validation.checks.some((c) => c.name === "exact_versions_recorded" && c.ok) &&
        validation.checks.some((c) => c.name === "lockfile_integrity" && c.ok),
      () => `ranges refused ${badRange?.code}/${emptyRange?.code} · validation ${validation.status}`);

    // ============================================================ 6. resolve + install
    const tree = await inspectDependencyTree(base44, user, { project_id: project.id });
    const install = await sandboxRun(base44, user, { project_id: project.id, command: "install" });
    const installedNow = installedPackages(await projectFiles(project.id));
    certify("6 dependencies resolve and install through the existing resolver and install command",
      () => tree.ok === true && tree.lockfile_matches === true &&
        tree.direct.includes(PKG) && tree.transitive.includes(TRANSITIVE) &&
        install.ok === true && install.exit_status === 200 &&
        install.packages.length === installedNow.length && install.packages.some((p) => p.name === PKG) &&
        installedNow.every((p) => /^\d+\.\d+\.\d+$/.test(p.version)),
      () => `resolved ${tree.count} · installed ${install.packages.map((p) => `${p.name}@${p.version}`).join(", ")}`);

    // ============================================================ 7. missing dependency
    const withoutLock = (await projectFiles(project.id)).filter((f) => f.path !== LOCKFILE_FILE);
    const missing1 = runBuild(createFs(withoutLock), [], []);
    const missing2 = runBuild(createFs(withoutLock), [], []);
    const legacyInstall = await sandboxRun(base44, user, { project_id: legacy.id, command: "install" });
    certify("7 a missing dependency fails deterministically — never a runtime surprise",
      () => missing1.status === "failed" && missing2.status === "failed" &&
        missing1.errors === missing2.errors &&
        missing1.logs.some((l) => l.includes(PKG) && l.startsWith("error")) &&
        // A project that declares nothing is NOT a failure: the absent files are its valid state.
        legacyInstall.ok === true && legacyInstall.packages.length === 0,
      () => `missing lockfile → ${missing1.status} (${missing1.errors} error(s)), identical on repeat · legacy install ok=${legacyInstall.ok}`);

    // ============================================================ 8. deterministic state
    const state1 = resolvedDependencyState(await projectFiles(project.id));
    const state2 = resolvedDependencyState(await projectFiles(project.id));
    const r1 = resolveDependencies(manifest.dependencies, { runtime_target: RUNTIME_TARGET });
    const r2 = resolveDependencies({ [PKG]: "^1.0.0" }, { runtime_target: RUNTIME_TARGET });
    certify("8 the resolved dependency state is deterministic and content-addressed",
      () => state1.dependency_fingerprint === state2.dependency_fingerprint &&
        JSON.stringify(state1.packages) === JSON.stringify(state2.packages) &&
        r1.fingerprint === r2.fingerprint && r1.fingerprint === state1.dependency_fingerprint &&
        state1.runtime_target === RUNTIME_TARGET && state1.install_scripts_blocked === true,
      () => `${state1.package_count} package(s) @ ${state1.dependency_fingerprint}`);

    // ============================================================ 9. build consumes state
    const currentFiles = await projectFiles(project.id);
    const goodBuild = runBuild(createFs(currentFiles), [], []);
    certify("9 the build consumes the resolved dependency state and links imports against it",
      () => goodBuild.status === "success" &&
        goodBuild.logs.some((l) => l.startsWith("[dependencies]") && l.includes(`${PKG}@`)) &&
        goodBuild.logs.some((l) => l.startsWith("[dependencies]") && l.includes(`${installedNow.length} resolved package`)),
      () => `${goodBuild.status} · ${goodBuild.logs.filter((l) => l.startsWith("[dependencies]")).join(" | ")}`);

    // ============================================================ 10. build rejects bad state
    // Drift: the manifest declares a package the lockfile does not pin. The build must refuse it —
    // otherwise an uninstalled dependency reaches an artifact.
    const driftFiles = currentFiles.map((f) => (f.path === MANIFEST_FILE
      ? { ...f, content: JSON.stringify({ ...JSON.parse(f.content), dependencies: { [PKG]: "^1.0.0", "@nexus/slugify": "^1.0.0" } }, null, 2) }
      : f));
    const driftBuild = runBuild(createFs(driftFiles), [], []);
    certify("10 the build rejects an invalid or drifted dependency state",
      () => missing1.status === "failed" && buildBadManifest.status === "failed" &&
        driftBuild.status === "failed" &&
        driftBuild.logs.some((l) => l.startsWith("error") && l.includes("@nexus/slugify")),
      () => `missing=${missing1.status} malformed=${buildBadManifest.status} drift=${driftBuild.status} (${driftBuild.logs.filter((l) => l.startsWith("error")).slice(0, 2).join(" | ") || "no drift error reported"})`);

    // ============================================================ 11-13. artifact + deploy
    const version = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1))[0];
    const artifactResult = await buildArtifact(svc, { project: await svc.entities.Project.get(project.id), version, userId: user.id });
    const payload = artifactResult.ok ? await loadArtifactPayload(artifactResult.artifact) : { client_files: [], config: {} };
    const artifactDeps = payload.config?.dependencies || null;
    const shippedState = resolvedDependencyState(payload.client_files);
    certify("11 the deployment artifact records the resolved dependency state it was built from",
      () => artifactResult.ok === true &&
        // The lockfile itself ships, so the deployed app carries its own pinned set…
        shippedState.lockfile_present === true &&
        shippedState.dependency_fingerprint === state1.dependency_fingerprint &&
        // …and the artifact records that state explicitly, rather than leaving it implicit.
        !!artifactDeps && artifactDeps.dependency_fingerprint === state1.dependency_fingerprint &&
        artifactDeps.runtime_target === RUNTIME_TARGET &&
        Array.isArray(artifactDeps.packages) && artifactDeps.packages.length === state1.package_count &&
        artifactResult.artifact.dependency_fingerprint === state1.dependency_fingerprint,
      () => `artifact ${artifactResult.artifact?.checksum?.slice(0, 12)} · shipped lockfile ${shippedState.dependency_fingerprint} · recorded ${artifactDeps ? artifactDeps.dependency_fingerprint : "ABSENT (config carries no dependency block)"} · row ${artifactResult.artifact?.dependency_fingerprint ?? "ABSENT"}`);

    const launched = await goLive(await svc.entities.Project.get(project.id), version);
    const pinnedCheck = launched.verification.checks.find((c) => c.name === "dependencies_pinned");
    certify("12 deployment verification reports dependencies_pinned against the shipped lockfile",
      () => !!pinnedCheck && pinnedCheck.ok === true &&
        String(pinnedCheck.detail).includes(state1.dependency_fingerprint),
      () => pinnedCheck
        ? `dependencies_pinned=${pinnedCheck.ok} · ${pinnedCheck.detail}`
        : `no dependencies_pinned check exists; verification ran ${launched.verification.checks.map((c) => c.name).join(", ")}`);

    certify("13 a project with valid dependencies builds, deploys and goes live",
      () => launched.deployment.status === "LIVE" &&
        launched.deployment.artifact_checksum === launched.artifact.checksum &&
        (launched.deployment.build_diagnostics || []).length === 0 &&
        launched.deployment.secret_scan === "pass" && launched.verification.ok === true &&
        resolvedDependencyState(launched.payload.client_files).dependency_fingerprint === state1.dependency_fingerprint,
      () => `deployment ${launched.deployment.status}${launched.deployment.failure_code ? ` (${launched.deployment.failure_code}: ${launched.deployment.failure_summary} · ${(launched.deployment.build_diagnostics || []).join(" | ")})` : ""} · verification ok=${launched.verification.ok}`);

    // ============================================================ 14. mutation updates
    const updated = await updateDependency(base44, user, { project_id: project.id, package_name: PKG, version: "1.0.0", trace_id });
    const afterUpdate = await projectFiles(project.id);
    const rows = await dependencyRows(project.id);
    certify("14 a dependency mutation updates the authoritative and projected state together",
      () => updated.applied === true &&
        updated.impact.packages_changed.some((c) => c.package_name === PKG && c.to_version === "1.0.0") &&
        readManifest(afterUpdate).dependencies[PKG] === "1.0.0" &&
        readLockfile(afterUpdate).fingerprint === updated.dependency_fingerprint &&
        updated.dependency_fingerprint !== declared.dependency_fingerprint &&
        rows.some((r) => r.package_name === PKG && r.resolved_version === "1.0.0" && r.dependency_fingerprint === updated.dependency_fingerprint),
      () => `→ 1.0.0 · fingerprint ${updated.dependency_fingerprint} · ${rows.length} projection row(s)`);

    // ============================================================ 15. version / snapshot
    const history = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 50);
    const declareVersion = history.find((v) => v.message === `Add dependency ${PKG}@^1.0.0`);
    const declareSnapshot = declareVersion ? await unpackSnapshot(declareVersion) : { files: [] };
    const latestSnapshot = await unpackSnapshot(history[history.length - 1]);
    certify("15 dependency state survives versioning: every snapshot keeps what it shipped with",
      () => history.length >= 2 &&
        readManifest(declareSnapshot.files).dependencies[PKG] === "^1.0.0" &&
        readLockfile(declareSnapshot.files).exists === true &&
        readManifest(latestSnapshot.files).dependencies[PKG] === "1.0.0" &&
        readLockfile(latestSnapshot.files).fingerprint === updated.dependency_fingerprint &&
        history.some((v) => (v.changed_files || []).some((c) => c.path === LOCKFILE_FILE)),
      () => `${history.length} versions · historical snapshot pins ^1.0.0, latest pins 1.0.0`);

    // ============================================================ 16. reload persistence
    const reloaded = await loadProjectState(base44, project.id);
    const reloadedState = resolvedDependencyState(reloaded.files);
    const reloadedList = await listDependencies(base44, user, { project_id: project.id });
    const reloadedValidation = await validateDependencies(base44, user, { project_id: project.id });
    certify("16 dependency state survives a reload — every reader resolves the same pinned set",
      () => reloadedState.dependency_fingerprint === updated.dependency_fingerprint &&
        reloadedList.dependency_fingerprint === updated.dependency_fingerprint &&
        reloadedList.manifest_present === true && reloadedList.lockfile_present === true &&
        reloadedValidation.passed === true && reloadedValidation.drift.length === 0,
      () => `reloaded ${reloadedState.dependency_fingerprint} · validation ${reloadedValidation.status}`);

    // ============================================================ 17. SDK compatibility
    const previewCtx = createExecutionContext({ environment: "preview", project, files: reloaded.files, entities: [] });
    const productionCtx = createExecutionContext({ environment: "production", project, files: launched.payload.client_files, entities: [] });
    certify("17 every SDK runtime loads the SAME resolved dependency state through one contract",
      () => previewCtx.dependency_fingerprint === updated.dependency_fingerprint &&
        previewCtx.dependencies.runtime_target === RUNTIME_TARGET &&
        previewCtx.dependencies.install_scripts_blocked === true &&
        productionCtx.dependencies.package_count === state1.package_count &&
        ["sdk", "db", "server", "auth"].every((n) => RUNTIME_EXPORTS.includes(n)),
      () => `preview ${previewCtx.dependencies.package_count} pkg @ ${previewCtx.dependency_fingerprint} · production ${productionCtx.dependencies.package_count} pkg`);

    // ============================================================ 18. generated types
    const typeFs = createFs(reloaded.files);
    const emitted = emitProjectTypes(typeFs, reloaded.entities);
    const emittedAgain = emitProjectTypes(createFs(activeFiles(typeFs)), reloaded.entities);
    certify("18 generated declarations stay valid and deterministic for a project with dependencies",
      () => typeof emitted === "string" && emitted.length > 0 && emitted === emittedAgain &&
        // Declarations describe PLATFORM resources; a package is never emitted as one.
        !emitted.includes(PKG),
      () => `${emitted.length} chars · deterministic=${emitted === emittedAgain}`);

    // ============================================================ 19. architecture sees it
    const arch = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id });
    const depNodes = await svc.entities.ArchitectureNode.filter({ architecture_id: arch.architecture.architecture_id, node_type: "external_dependency" }, "node_key", 100);
    const pkgNode = depNodes.find((n) => n.key === PKG);
    certify("19 Architecture Intelligence sees the installed dependency, with lockfile provenance",
      () => !!pkgNode && pkgNode.provenance_state === "verified" && pkgNode.provenance_reference === LOCKFILE_FILE &&
        pkgNode.metadata.kind === "package" && pkgNode.metadata.resolved_version === "1.0.0" &&
        depNodes.some((n) => n.key === TRANSITIVE && n.metadata.relation === "transitive"),
      () => `${depNodes.length} external dependency node(s) · ${PKG} pinned at ${pkgNode?.metadata?.resolved_version} from ${pkgNode?.provenance_reference}`);

    // ============================================================ 20. impact analysis
    const preview = await applyDependencyChange(base44, user, { project_id: project.id, operation: "update", package_name: PKG, version: "^1.0.0", dry_run: true, trace_id });
    const impact = preview.impact.architecture_impact;
    const lockAfterPreview = readLockfile(await projectFiles(project.id));
    certify("20 a dependency change appears in impact analysis through the existing graph",
      () => impact.available === true &&
        impact.package_nodes.includes(`external_dependency:${PKG}`) &&
        impact.affected_files.includes("src/components/report.js") &&
        impact.verification_surfaces.includes("build") &&
        // A dry run reports the impact and writes nothing.
        preview.applied === false && preview.version === null &&
        lockAfterPreview.fingerprint === updated.dependency_fingerprint,
      () => `${impact.affected_nodes.length} affected node(s) · risk ${impact.risk_level} · dry run wrote nothing`);

    // ============================================================ 21. authorization
    const anonRead = await refusalOf(() => listDependencies(base44, null, { project_id: project.id }));
    const anonWrite = await refusalOf(() => addDependency(base44, null, { project_id: project.id, package_name: "@nexus/slugify", version: "^1.0.0" }));
    const foreignRead = await refusalOf(() => listDependencies(base44, user, { project_id: foreign.id }));
    const foreignWrite = await refusalOf(() => addDependency(base44, user, { project_id: foreign.id, package_name: "@nexus/slugify", version: "^1.0.0" }));
    certify("21 dependency mutation is authorized through the existing path",
      () => anonRead?.code === "AUTH_REQUIRED" && anonWrite?.code === "AUTH_REQUIRED" &&
        foreignRead?.code === "NOT_A_MEMBER" && foreignWrite?.code === "NOT_A_MEMBER",
      () => `anon ${anonRead?.code}/${anonWrite?.code} · foreign ${foreignRead?.code}/${foreignWrite?.code}`);

    // ============================================================ 22. project isolation
    const foreignFiles = await projectFiles(foreign.id);
    const legacyFiles = await projectFiles(legacy.id);
    const legacyList = await listDependencies(base44, user, { project_id: legacy.id });
    const legacyRows = await dependencyRows(legacy.id);
    certify("22 dependency state is project-scoped — no other project gains or loses one",
      () => foreignFiles.every((f) => f.path !== MANIFEST_FILE && f.path !== LOCKFILE_FILE) &&
        legacyFiles.every((f) => f.path !== MANIFEST_FILE && f.path !== LOCKFILE_FILE) &&
        legacyList.count === 0 && legacyList.lockfile_present === false &&
        legacyRows.length === 0 && installedPackages(legacyFiles).length === 0,
      () => "foreign and legacy projects carry no manifest, no lockfile and no dependency rows");

    // ============================================================ 23. legacy compatibility
    const legacyBuild = runBuild(createFs(legacyFiles), [], []);
    const legacyVersion = await svc.entities.ProjectVersion.create({
      project_id: legacy.id, number: 1, message: "legacy v1",
      snapshot: { files: legacyFiles, entities: [], secrets: [] }, changed_files: [],
    });
    await svc.entities.Project.update(legacy.id, { version_count: 1 });
    const legacyLaunched = await goLive(await svc.entities.Project.get(legacy.id), legacyVersion);
    const legacyPinned = legacyLaunched.verification.checks.find((c) => c.name === "dependencies_pinned");
    certify("23 a legacy project with no dependencies builds, deploys and verifies exactly as before",
      () => legacyBuild.status === "success" && !legacyBuild.logs.some((l) => l.startsWith("error")) &&
        legacyLaunched.deployment.status === "LIVE" && legacyLaunched.verification.ok === true &&
        // Its artifact carries no dependency state at all, and verification still states the fact.
        !("dependencies" in (legacyLaunched.payload.config || {})) &&
        resolvedDependencyState(legacyLaunched.payload.client_files).lockfile_present === false &&
        !!legacyPinned && legacyPinned.ok === true,
      () => `legacy build ${legacyBuild.status} · deployment ${legacyLaunched.deployment.status}${legacyLaunched.deployment.failure_code ? ` (${legacyLaunched.deployment.failure_code}: ${legacyLaunched.deployment.failure_summary})` : ""} · pinned check ${legacyPinned ? `"${legacyPinned.detail}"` : "ABSENT"}`);

    // ============================================================ 24. full lifecycle
    const lcProject = await seedProject(`dep lifecycle ${stamp}`, { [ENTRY_FILE]: ENTRY_SOURCE, "src/components/report.js": USES_PACKAGE });
    const lc = {};
    lc.declare = await addDependency(base44, user, { project_id: lcProject.id, package_name: PKG, version: "^1.0.0", trace_id });
    lc.validate = await validateDependencies(base44, user, { project_id: lcProject.id });
    lc.resolve = await inspectDependencyTree(base44, user, { project_id: lcProject.id });
    lc.install = await sandboxRun(base44, user, { project_id: lcProject.id, command: "install" });
    const lcFiles = await projectFiles(lcProject.id);
    lc.build = runBuild(createFs(lcFiles), [], []);
    lc.version = (await svc.entities.ProjectVersion.filter({ project_id: lcProject.id }, "-number", 1))[0];
    lc.launched = await goLive(await svc.entities.Project.get(lcProject.id), lc.version);
    const lcServedState = resolvedDependencyState(lc.launched.payload.client_files);
    const lcPinned = lc.launched.verification.checks.find((c) => c.name === "dependencies_pinned");
    certify("24 the complete lifecycle succeeds: declare → validate → resolve → install → build → version → deploy → verify",
      () => lc.declare.applied === true &&
        lc.validate.passed === true && lc.validate.drift.length === 0 &&
        lc.resolve.ok === true && lc.resolve.lockfile_matches === true &&
        lc.install.ok === true && lc.install.packages.length === lc.resolve.count &&
        lc.build.status === "success" && lc.version.number >= 1 &&
        lc.launched.deployment.status === "LIVE" && lc.launched.verification.ok === true &&
        !!lcPinned && lcPinned.ok === true &&
        // What is SERVED pins exactly what was declared, resolved and verified.
        lcServedState.dependency_fingerprint === lc.declare.dependency_fingerprint &&
        (lc.launched.payload.config?.dependencies?.dependency_fingerprint || null) === lc.declare.dependency_fingerprint &&
        lc.launched.artifact.dependency_fingerprint === lc.declare.dependency_fingerprint,
      () => `declare=${lc.declare.dependency_fingerprint} validate=${lc.validate.status} resolve=${lc.resolve.count} install=${lc.install.packages?.length} build=${lc.build.status} v${lc.version?.number} deploy=${lc.launched.deployment.status} verify=${lc.launched.verification.ok} pinned=${lcPinned ? lcPinned.ok : "ABSENT"} served=${lcServedState.dependency_fingerprint} recorded=${lc.launched.payload.config?.dependencies?.dependency_fingerprint ?? "ABSENT"}`);

    // Cleanliness: removing the last dependency returns the project to a valid no-dependency state.
    const reportRow = (await svc.entities.ProjectFile.filter({ project_id: lcProject.id, path: "src/components/report.js" }, "path", 1))[0];
    if (reportRow) await svc.entities.ProjectFile.delete(reportRow.id);
    const removed = await removeDependency(base44, user, { project_id: lcProject.id, package_name: PKG, trace_id });
    const lcFinal = await projectFiles(lcProject.id);
    const lcFinalRows = await dependencyRows(lcProject.id);
    certify("24b removing the last dependency returns the project to a valid no-dependency state",
      () => removed.applied === true &&
        readLockfile(lcFinal).exists === false &&
        Object.keys(readManifest(lcFinal).dependencies).length === 0 &&
        runBuild(createFs(lcFinal), [], []).status === "success" &&
        lcFinalRows.length === 0,
      () => "lockfile removed · manifest empty · project still builds · no stale projection rows");

    return report();
  } catch (error) {
    return report(error);
  } finally {
    for (const pid of scratch.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ProjectDependency", "PackageFetch", "Deployment", "DeploymentArtifact", "TraceEvent", "AuditLog", "Build", "ProjectVersion", "ProjectFile", "AppEntity", "AppRecord"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of scratch.workspaces) {
      await cleanupWorkspace(svc, wid, ["ProjectDependency", "Architecture", "ArchitectureNode", "ArchitectureEdge", "AuditLog", "TraceEvent", "RateLimitBucket", "Project"]);
    }
  }
}
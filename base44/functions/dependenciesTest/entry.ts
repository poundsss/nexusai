// E2E certification for the NexusAI Dependency / Package System (#26).
//
// Runs against the REAL modules and the REAL data layer: the real curated registry and resolver, the
// real manifest/lockfile project files, the real dependency mutation path (which commits through the
// existing project-versioning path), the real build engine, the real shared execution contract and
// the real #25 architecture graph. Nothing is stubbed and no second dependency mechanism exists.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  listDependencies, inspectDependencyTree, validateDependencies, dependencyCatalog,
  addDependency, removeDependency, updateDependency, applyDependencyChange,
  readManifest, readLockfile, validateDependencyState,
  MANIFEST_FILE, LOCKFILE_FILE, LOCKFILE_VERSION,
} from "../../shared/dependencies.ts";
import { resolveDependencies, RUNTIME_TARGET, REGISTRY_VERSION, REGISTRY_SOURCE } from "../../shared/packageRegistry.ts";
import { installedPackages, resolvedDependencyState } from "../../shared/packageLock.ts";
import { createExecutionContext } from "../../shared/executionContract.ts";
import { createFs } from "../../shared/projectFs.ts";
import { withFailingOp, captureError } from "../../shared/failingClient.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { reconcileArchitecture } from "../../shared/architecture.ts";

const SECRET = "sk_live_DEPENDENCYLEAK1234567890";
const nowIso = () => new Date().toISOString();

const ENTRY_SOURCE = `import { html } from "runtime";
export default function App() { return html\`<div>dependency fixture</div>\`; }
`;
const REPORT_SOURCE = `import { formatMoney } from "@nexus/currency";
export function line(value) { return formatMoney(value); }
`;

// Compact report: counts plus only the failing checks, so a long suite's failures are never
// truncated away by the caller.
const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({ ok: s.ok && !error, error: error?.message || null, passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `dep-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "dependency-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.create({ project_id: project.id, path: ENTRY_FILE, content: ENTRY_SOURCE });

    // A project in a workspace this caller is NOT a member of.
    const wsForeign = await svc.entities.Workspace.create({ name: `dep-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreign = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreign.id);
    await svc.entities.ProjectFile.create({ project_id: foreign.id, path: ENTRY_FILE, content: ENTRY_SOURCE });
    await svc.entities.ProjectDependency.create({ project_id: foreign.id, workspace_id: wsForeign.id, package_name: "@nexus/slugify", resolved_version: "1.0.0" });

    const trace_id = `tr_dep_${Date.now()}`;

    // ------------------------------------------------------------ 1. inspection
    const catalog = dependencyCatalog();
    const empty = await listDependencies(base44, user, { project_id: project.id });
    h.check("1 the curated registry is inspectable", catalog.registry_version === REGISTRY_VERSION && catalog.source === REGISTRY_SOURCE && catalog.packages.length >= 8 && catalog.packages.every((p) => p.versions.length >= 1),
      `${catalog.packages.length} packages in ${catalog.source} @ ${catalog.registry_version}`);
    h.check("1b a project with no dependencies inspects cleanly", empty.count === 0 && empty.manifest_present === false && empty.lockfile_present === false && empty.runtime_target === RUNTIME_TARGET,
      "no manifest, no lockfile, no dependency rows");

    // ------------------------------------------------------------------- 2. add
    const added = await addDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", version: "^1.0.0", trace_id });
    const filesAfterAdd = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50);
    const manifest = readManifest(filesAfterAdd);
    const lock = readLockfile(filesAfterAdd);
    h.check("2 a dependency can be added", added.applied === true && added.ok === true && added.impact.packages_added.some((p) => p.package_name === "@nexus/currency") && added.build.status === "success",
      `added ${added.impact.packages_added.map((p) => `${p.package_name}@${p.resolved_version}`).join(", ")}`);
    h.check("2b a transitive dependency is resolved and recorded", added.dependencies.some((d) => d.package_name === "@nexus/decimal" && d.relation === "transitive"),
      `@nexus/decimal pulled in by @nexus/currency`);
    h.check("3 the manifest and lockfile are the authoritative state",
      manifest.exists && manifest.dependencies["@nexus/currency"] === "^1.0.0" &&
      lock.exists && lock.lockfile_version === LOCKFILE_VERSION && lock.fingerprint === added.dependency_fingerprint &&
      lock.packages.every((p) => /^\d+\.\d+\.\d+$/.test(p.version) && p.integrity),
      `${MANIFEST_FILE} + ${LOCKFILE_FILE} with ${lock.packages.length} pinned package(s)`);

    // -------------------------------------------------- 4. deterministic resolution
    const r1 = resolveDependencies(manifest.dependencies, { runtime_target: RUNTIME_TARGET });
    const r2 = resolveDependencies({ "@nexus/currency": "^1.0.0" }, { runtime_target: RUNTIME_TARGET });
    const tree = await inspectDependencyTree(base44, user, { project_id: project.id });
    h.check("4 resolution is deterministic", r1.fingerprint === r2.fingerprint && r1.fingerprint === lock.fingerprint && JSON.stringify(r1.packages) === JSON.stringify(r2.packages),
      `identical fingerprint ${r1.fingerprint} from identical inputs`);
    h.check("4b the resolved tree explains who required what", tree.ok === true && tree.lockfile_matches === true && tree.direct.includes("@nexus/currency") && tree.transitive.includes("@nexus/decimal") &&
      tree.tree.find((t) => t.package_name === "@nexus/decimal").required_by.some((r) => r.startsWith("@nexus/currency@")),
      `${tree.count} packages · ${tree.direct.length} direct, ${tree.transitive.length} transitive`);

    // ------------------------------------------------------------- 5. validation
    const valid = await validateDependencies(base44, user, { project_id: project.id });
    h.check("5 manifest/lockfile integrity validates", valid.passed === true && valid.status !== "error" && valid.drift.length === 0 && valid.dependency_fingerprint === lock.fingerprint &&
      valid.checks.some((c) => c.name === "lockfile_integrity" && c.ok) && valid.checks.some((c) => c.name === "exact_versions_recorded" && c.ok),
      `status ${valid.status}, no drift`);

    // A lockfile edited behind the project's back is DETECTED, not silently loaded.
    const lockRow = filesAfterAdd.find((f) => f.path === LOCKFILE_FILE) || (await svc.entities.ProjectFile.filter({ project_id: project.id, path: LOCKFILE_FILE }, "path", 1))[0];
    const goodLock = lockRow.content;
    await svc.entities.ProjectFile.update(lockRow.id, { content: goodLock.replace(/"integrity": "sha256-[^"]+"/, '"integrity": "sha256-tampered"') });
    const tampered = await validateDependencies(base44, user, { project_id: project.id });
    await svc.entities.ProjectFile.update(lockRow.id, { content: goodLock });
    const restored = await validateDependencies(base44, user, { project_id: project.id });
    h.check("5b a tampered lockfile is detected", tampered.passed === false && tampered.status === "error" && tampered.failure_class === "integrity_mismatch" && tampered.drift.some((d) => d.type === "integrity_mismatch") && restored.passed === true,
      `${tampered.failure_class}; state validates again once restored`);
    h.check("5c vulnerability posture is three-valued, never an unfounded safe claim",
      validateDependencyState({ manifest: { exists: true, dependencies: { "@nexus/markdown": "1.0.0", "@nexus/slugify": "^1.0.0" }, raw: null }, lock: { exists: false, packages: [], fingerprint: null } })
        .vulnerabilities.some((v) => v.package_name === "@nexus/markdown" && v.advisory_id === "NEXUS-ADV-0001") &&
      validateDependencyState({ manifest: { exists: true, dependencies: { "@nexus/slugify": "^1.0.0" }, raw: null }, lock: { exists: false, packages: [], fingerprint: null } })
        .unknown_advisory_packages.some((p) => p.startsWith("@nexus/slugify@")),
      "a known advisory is reported; a package with no advisory data stays 'unknown'");

    // ------------------------------------------- 6. conflict / version validation
    await h.expectThrow("6 an unsatisfiable version conflict is refused", () => addDependency(base44, user, { project_id: project.id, package_name: "@nexus/strict-decimal", version: "^1.0.0" }), "PACKAGE_CONFLICT");
    await h.expectThrow("6b a missing peer dependency is refused", () => addDependency(base44, user, { project_id: project.id, package_name: "@nexus/charts", version: "^1.0.0" }), "PEER_DEPENDENCY_MISSING");
    await h.expectThrow("6c a runtime-incompatible package is refused", () => addDependency(base44, user, { project_id: project.id, package_name: "@nexus/legacy-runtime", version: "^1.0.0" }), "RUNTIME_INCOMPATIBLE");
    await h.expectThrow("6d an unsupported version range is refused", () => addDependency(base44, user, { project_id: project.id, package_name: "@nexus/decimal", version: "not-a-range" }), "INVALID_VERSION");
    await h.expectThrow("6e a package outside the curated registry is refused", () => addDependency(base44, user, { project_id: project.id, package_name: "left-pad", version: "^1.0.0" }), "PACKAGE_NOT_FOUND");
    await h.expectThrow("6f removing a package the project does not declare is refused", () => removeDependency(base44, user, { project_id: project.id, package_name: "@nexus/slugify" }), "DEPENDENCY_NOT_FOUND");
    const afterRefusals = await svc.entities.ProjectFile.filter({ project_id: project.id, path: MANIFEST_FILE }, "path", 1);
    h.check("6g a refused operation leaves no partial state", afterRefusals[0].content === (filesAfterAdd.find((f) => f.path === MANIFEST_FILE)?.content ?? afterRefusals[0].content) &&
      Object.keys(readManifest(await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).dependencies).join(",") === "@nexus/currency",
      "the manifest still declares exactly the one dependency that succeeded");

    // ------------------------------------------------------------- 7. update
    const updated = await updateDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", version: "1.0.0", trace_id });
    h.check("7 a dependency can be updated to a new resolved version",
      updated.applied === true && updated.impact.packages_changed.some((c) => c.package_name === "@nexus/currency" && c.from_version === "1.1.0" && c.to_version === "1.0.0") && updated.dependency_fingerprint !== added.dependency_fingerprint,
      `@nexus/currency ${updated.impact.packages_changed[0]?.from_version} → ${updated.impact.packages_changed[0]?.to_version}`);

    // -------------------------------------------------- 8. build integration
    // Project code that imports the installed package: the build links the package's real exports.
    await svc.entities.ProjectFile.create({ project_id: project.id, path: "src/components/report.js", content: REPORT_SOURCE });
    const stateNow = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50);
    const buildOk = runBuild(createFs(stateNow), [], []);
    const buildMissing = runBuild(createFs(stateNow.filter((f) => f.path !== LOCKFILE_FILE)), [], []);
    h.check("8 the build links imports against the lockfile", buildOk.status === "success" && buildOk.logs.some((l) => l.startsWith("[dependencies]") && l.includes("@nexus/currency@1.0.0")),
      `build success with the pinned package set`);
    h.check("8b an import of a package that is not installed fails the build", buildMissing.status === "failed" && buildMissing.logs.some((l) => l.includes("@nexus/currency") && l.includes("not allowed")),
      "an unresolved package import is a build error, never a runtime surprise");
    await h.expectThrow("8c a change that breaks the build is refused and rolled back",
      () => removeDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", trace_id }), "BUILD_FAILED");
    const afterBuildFailure = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50);
    h.check("8d a failed build leaves the previous dependency state exactly as it was",
      readManifest(afterBuildFailure).dependencies["@nexus/currency"] === "1.0.0" && readLockfile(afterBuildFailure).fingerprint === updated.dependency_fingerprint &&
      (await svc.entities.Project.get(project.id)).version_count === (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1))[0].number,
      "manifest, lockfile and version history untouched by the refused removal");
    // 8e-8f. PA-42 (provisional R-9/R-10): build-history write fails.
    const buildsBefore = (await svc.entities.Build.filter({ project_id: project.id }, "-created_date", 100)).length;
    const savedErr = await captureError(() => removeDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency" }));
    const lostErr = await captureError(() => removeDependency(withFailingOp(base44, "Build", "create"), user, { project_id: project.id, package_name: "@nexus/currency" }));
    const buildsAfter = (await svc.entities.Build.filter({ project_id: project.id }, "-created_date", 100)).length;
    const lostDetails = JSON.stringify(lostErr?.details ?? lostErr ?? {});
    h.check("8e history saved: the build error is unchanged and no history warning is shown",
      savedErr?.code === "BUILD_FAILED" && /does not build/.test(savedErr.message) && !/could not be saved/.test(savedErr.message),
      String(savedErr?.message || "").slice(0, 140));
    h.check("8f history NOT saved: the original build error is preserved and the lost history is reported",
      lostErr?.code === "BUILD_FAILED" && lostErr.message.startsWith(savedErr?.message || "\u0000") && /could not be saved to build history/.test(lostErr.message)
        && /"build_history_saved":false/.test(lostDetails) && buildsAfter === buildsBefore + 1,
      JSON.stringify({ msg: String(lostErr?.message || "").slice(0, 160), buildsBefore, buildsAfter }));

    // -------------------------------------------------- 9. runtime integration
    const runtimeState = resolvedDependencyState(afterBuildFailure);
    const ctx = createExecutionContext({ environment: "preview", project, files: afterBuildFailure, entities: [] });
    h.check("9 every runtime loads the same resolved dependency state",
      ctx.dependencies.package_count === runtimeState.package_count && ctx.dependency_fingerprint === updated.dependency_fingerprint &&
      ctx.dependencies.runtime_target === RUNTIME_TARGET && installedPackages(afterBuildFailure).some((p) => p.name === "@nexus/currency" && p.version === "1.0.0"),
      `preview context resolves ${ctx.dependencies.package_count} package(s) at fingerprint ${ctx.dependency_fingerprint}`);

    // ---------------------------------------------- 10. architecture integration
    const arch = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id });
    const archNodes = await svc.entities.ArchitectureNode.filter({ architecture_id: arch.architecture.architecture_id, node_type: "external_dependency" }, "node_key", 50);
    const pkgNode = archNodes.find((n) => n.key === "@nexus/currency");
    const preview = await applyDependencyChange(base44, user, { project_id: project.id, operation: "update", package_name: "@nexus/currency", version: "^1.0.0", dry_run: true, trace_id });
    h.check("10 installed packages appear in the architecture graph with provenance",
      !!pkgNode && pkgNode.provenance_state === "verified" && pkgNode.provenance_reference === LOCKFILE_FILE && pkgNode.metadata.resolved_version === "1.0.0" && pkgNode.metadata.kind === "package",
      `external_dependency:@nexus/currency pinned at ${pkgNode?.metadata?.resolved_version} from the lockfile`);
    h.check("10b a dependency change reports its architecture impact",
      preview.impact.architecture_impact.available === true && preview.impact.architecture_impact.package_nodes.includes("external_dependency:@nexus/currency") &&
      preview.impact.architecture_impact.affected_files.includes("src/components/report.js"),
      `impact via the existing #25 graph: ${preview.impact.architecture_impact.affected_nodes.length} affected node(s)`);
    h.check("10c a dry run mutates nothing", preview.applied === false && preview.version === null &&
      readLockfile(await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).fingerprint === updated.dependency_fingerprint,
      "the preview returns the full impact summary without writing");

    // ----------------------------------------------------------- 11. idempotency
    const versionsBefore = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 50);
    const repeat = await addDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", version: "1.0.0", trace_id });
    const repeat2 = await addDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", version: "1.0.0", trace_id });
    const versionsAfter = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 50);
    const rows = await svc.entities.ProjectDependency.filter({ project_id: project.id }, "package_name", 50);
    h.check("11 repeating an operation is idempotent",
      repeat.unchanged === true && repeat.applied === false && repeat2.unchanged === true &&
      versionsAfter.length === versionsBefore.length && rows.length === new Set(rows.map((r) => r.package_name)).size && rows.length === 2,
      `no new version, ${rows.length} projection rows with no duplicates`);

    // ------------------------------------------------------ 12. concurrency safety
    const current = (await svc.entities.Project.get(project.id)).version_count;
    await h.expectThrow("12 a stale dependency change is refused",
      () => updateDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", version: "^1.0.0", expected_version_number: current - 1, trace_id }), "VERSION_CONFLICT");
    h.check("12b the refused concurrent change wrote nothing",
      readLockfile(await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).fingerprint === updated.dependency_fingerprint &&
      (await svc.entities.Project.get(project.id)).version_count === current,
      `project still at version ${current}`);

    // -------------------------------------------- 13. rollback / version history
    await svc.entities.ProjectFile.delete((await svc.entities.ProjectFile.filter({ project_id: project.id, path: "src/components/report.js" }, "path", 1))[0].id);
    const removed = await removeDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", trace_id });
    const finalFiles = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50);
    const history = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 50);
    const addVersion = history.find((v) => v.message === "Add dependency @nexus/currency@^1.0.0");
    const snapshotManifest = readManifest(addVersion?.snapshot?.files || []);
    h.check("13 a dependency can be removed", removed.applied === true && removed.impact.packages_removed.map((p) => p.package_name).sort().join(",") === "@nexus/currency,@nexus/decimal" &&
      !readManifest(finalFiles).dependencies["@nexus/currency"] && readLockfile(finalFiles).exists === false,
      "manifest cleared and the lockfile removed with the last package");
    h.check("13b every package change is a versioned, rollback-safe project mutation",
      history.length >= 3 && history.every((v) => Array.isArray(v.changed_files)) &&
      history.some((v) => (v.changed_files || []).some((c) => c.path === LOCKFILE_FILE)) &&
      snapshotManifest.dependencies["@nexus/currency"] === "^1.0.0",
      `${history.length} versions; the historical snapshot still holds its own manifest`);
    h.check("13c the projection follows the authoritative lockfile",
      (await svc.entities.ProjectDependency.filter({ project_id: project.id }, "package_name", 50)).length === 0,
      "removing the last package leaves no stale dependency rows");

    // ------------------------------------------------- 14. authorization / isolation
    await h.expectThrow("14 unauthenticated access is rejected", () => listDependencies(base44, null, { project_id: project.id }), "AUTH_REQUIRED");
    await h.expectThrow("14b unauthenticated mutation is rejected", () => addDependency(base44, null, { project_id: project.id, package_name: "@nexus/slugify" }), "AUTH_REQUIRED");
    await h.expectThrow("14c cross-workspace reads are rejected", () => listDependencies(base44, user, { project_id: foreign.id }), "NOT_A_MEMBER");
    await h.expectThrow("14d cross-workspace mutation is rejected", () => addDependency(base44, user, { project_id: foreign.id, package_name: "@nexus/slugify", version: "^1.0.0" }), "NOT_A_MEMBER");
    const foreignRows = await svc.entities.ProjectDependency.filter({ project_id: foreign.id }, "package_name", 10);
    h.check("14e another project's dependency state is untouched", foreignRows.length === 1 && foreignRows[0].package_name === "@nexus/slugify" &&
      (await svc.entities.ProjectFile.filter({ project_id: foreign.id }, "path", 20)).every((f) => f.path !== MANIFEST_FILE),
      "the foreign project has no manifest and keeps its own row");

    // --------------------------------------------------------- 15. secret scrubbing
    await h.expectThrow("15 a credential in an input never reaches stored state",
      () => addDependency(base44, user, { project_id: project.id, package_name: "@nexus/slugify", version: `^1.0.0 ${SECRET}`, trace_id }), "INVALID_VERSION");
    const spans = await svc.entities.TraceEvent.filter({ trace_id }, "at", 100);
    const audits = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 100);
    const stored = JSON.stringify([spans, audits, await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)]);
    h.check("15b secrets are scrubbed from traces, audits and project state", !stored.includes(SECRET) && spans.some((s) => JSON.stringify(s.metadata || {}).includes("[REDACTED]")),
      "the credential appears nowhere; the trace records it redacted");

    // --------------------------------------------------------- 16. tracing / audit
    const depSpans = spans.filter((s) => String(s.name || "").startsWith("dependency."));
    const depAudits = audits.filter((a) => String(a.action || "").startsWith("dependency."));
    h.check("16 every operation is traced on the existing trace", depSpans.length >= 4 &&
      depSpans.some((s) => s.name === "dependency.add" && s.status === "ok" && s.project_id === project.id) &&
      depSpans.some((s) => s.status === "error"),
      `${depSpans.length} spans on trace ${trace_id}, successes and refusals both recorded`);
    h.check("16b every applied change is audited with its fingerprint",
      depAudits.some((a) => a.action === "dependency.add" && a.metadata?.dependency_fingerprint && a.metadata?.version_number) &&
      depAudits.some((a) => a.action === "dependency.update") && depAudits.some((a) => a.action === "dependency.remove") &&
      depAudits.every((a) => a.workspace_id === ws.id),
      `${depAudits.length} audit entries (add/update/remove)`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ProjectDependency", "TraceEvent", "AuditLog", "Build", "ProjectVersion", "ProjectFile", "AppEntity"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ProjectDependency", "Architecture", "ArchitectureNode", "ArchitectureEdge", "AuditLog", "Project"]);
    }
  }
}
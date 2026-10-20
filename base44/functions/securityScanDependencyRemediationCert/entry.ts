// Targeted certification for the Security Scan dependency-vulnerability REMEDIATION surface.
//
// Certifies ONLY the parity gap that was closed: dependency findings now carry optional
// remediation metadata (recommended_version, fix_available, fix_type); the UI offers a "Fix"
// action when a direct safe remediation exists and a "Resolve with AI" fallback otherwise;
// ignore/restore is unchanged; and running a scan NEVER mutates packages. It drives the REAL
// engine (runSecurityScanEngine via executeSecurityScan) over the REAL curated catalog — nothing
// is stubbed. The existing securityScanCert continues to certify the scan lifecycle as a whole.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { executeSecurityScan, SEVERITIES } from "../../shared/securityScan.ts";
import { mkScanProject, scanSurface } from "../../shared/securityScanTestFixtures.ts";

// Mirror of the UI action-selection contract in SecurityScanSection.jsx: a dependency finding with
// fix_available true → "Fix"; otherwise → "Resolve with AI". Both reuse the existing onFixWithAI
// builder-chat mechanism; no package-update infrastructure is invented.
const uiAction = (f) => (f.fix_available === true ? { action: "fix", fix_type: f.fix_type, recommended_version: f.recommended_version } : { action: "resolve_with_ai" });
const hasVersionBadge = (f) => !!f.recommended_version;
const depFindings = (row) => ((row && row.result && row.result.dependency_vulnerabilities) || []);
const firstDep = (row) => depFindings(row)[0] || null;

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = scanSurface(svc);
  const mkProject = (wsId, name) => mkScanProject(svc, projects, wsId, name, stamp);

  try {
    const ws = await svc.entities.Workspace.create({ name: `secremed-${stamp}`, owner_id: `owner_${stamp}` });
    workspaces.push(ws.id);
    const user = { id: `owner_${stamp}`, email: "r@example.com" };

    // ---- Project D: a floating catalog dependency + a locked vulnerable dependency ----------
    const projD = await mkProject(ws.id, "D");
    const filesD = [
      { path: "index.html", content: "<!doctype html><title>ok</title>\n" },
      { path: "package.json", content: JSON.stringify({ dependencies: { "@nexus/decimal": "latest", "@nexus/markdown": "^1.0.0" } }) },
      // A lockfile that pins @nexus/markdown at the VULNERABLE 1.0.0 (NEXUS-ADV-0001, patched in 1.1.0).
      { path: "package.lock.json", content: JSON.stringify({ packages: [{ name: "@nexus/markdown", version: "1.0.0" }] }) },
    ];
    for (const f of filesD) await svc.entities.ProjectFile.create({ project_id: projD.id, ...f });
    await svc.entities.ProjectVersion.create({ project_id: projD.id, number: 1, message: "initial" });

    // 1 · dependency finding renders recommended_version (pin + upgrade)
    await surface(projD, ws, user, { action: "run", language: "en" });
    let rowD = (await svc.entities.SecurityScan.filter({ project_id: projD.id }, "-created_date", 1))[0];
    rowD = await executeSecurityScan(svc, rowD.id);
    const depsD = depFindings(rowD);
    const floating = depsD.find((d) => d.package === "@nexus/decimal") || null;
    const advisory = depsD.find((d) => d.package === "@nexus/markdown") || null;
    harness.check("1 a floating-version finding renders recommended_version (pin_version) and a vulnerable locked finding renders the fixed version (upgrade)",
      !!floating && floating.severity === "Low" && floating.fix_available === true && floating.fix_type === "pin_version" &&
      typeof floating.recommended_version === "string" && floating.recommended_version.length > 0 &&
      !!advisory && SEVERITIES.includes(advisory.severity) && advisory.fix_available === true && advisory.fix_type === "upgrade" &&
      advisory.recommended_version === "1.1.0" && String(advisory.message).includes("NEXUS-ADV-0001"),
      JSON.stringify({ floating: floating ? { v: floating.recommended_version, t: floating.fix_type } : null, advisory: advisory ? { v: advisory.recommended_version, t: advisory.fix_type, sev: advisory.severity } : null }));

    // 2 · fix metadata persists in the stored scan result (round-tripped through the row)
    const storedD = await svc.entities.SecurityScan.get(rowD.id);
    const storedFloating = depFindings(storedD).find((d) => d.package === "@nexus/decimal") || null;
    const storedAdvisory = depFindings(storedD).find((d) => d.package === "@nexus/markdown") || null;
    harness.check("2 remediation metadata (fix_available / fix_type / recommended_version) persists in the stored scan result",
      !!storedFloating && storedFloating.fix_available === true && storedFloating.fix_type === "pin_version" && storedFloating.recommended_version === floating.recommended_version &&
      !!storedAdvisory && storedAdvisory.fix_available === true && storedAdvisory.fix_type === "upgrade" && storedAdvisory.recommended_version === "1.1.0",
      JSON.stringify({ persisted: depFindings(storedD).map((d) => `${d.package}:${d.fix_type}:${d.recommended_version}`) }));

    // ---- Project E: a non-floating dependency with NO lockfile → lockfile remediation ---------
    const projE = await mkProject(ws.id, "E");
    for (const f of [{ path: "index.html", content: "<!doctype html><title>ok</title>\n" }, { path: "package.json", content: JSON.stringify({ dependencies: { "@nexus/date-format": "^1.0.0" } }) }]) {
      await svc.entities.ProjectFile.create({ project_id: projE.id, ...f });
    }
    await surface(projE, ws, user, { action: "run" });
    const rowE = (await svc.entities.SecurityScan.filter({ project_id: projE.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowE.id);
    const storedE = await svc.entities.SecurityScan.get(rowE.id);
    const lockfileFinding = firstDep(storedE);
    harness.check("2b a missing-lockfile finding offers a lockfile remediation with no recommended version",
      !!lockfileFinding && lockfileFinding.package === "@nexus/date-format" && lockfileFinding.severity === "Medium" &&
      lockfileFinding.fix_available === true && lockfileFinding.fix_type === "lockfile" && lockfileFinding.recommended_version === null,
      JSON.stringify({ lockfile: lockfileFinding ? { t: lockfileFinding.fix_type, v: lockfileFinding.recommended_version } : null }));

    // ---- Project F: a floating dependency NOT in the catalog → no remediation → Resolve with AI
    const projF = await mkProject(ws.id, "F");
    for (const f of [{ path: "index.html", content: "<!doctype html><title>ok</title>\n" }, { path: "package.json", content: JSON.stringify({ dependencies: { "left-pad": "latest" } }) }]) {
      await svc.entities.ProjectFile.create({ project_id: projF.id, ...f });
    }
    await surface(projF, ws, user, { action: "run" });
    const rowF = (await svc.entities.SecurityScan.filter({ project_id: projF.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowF.id);
    const storedF = await svc.entities.SecurityScan.get(rowF.id);
    const noRemediation = firstDep(storedF);
    harness.check("3 a finding with no direct remediation (fix_available false) resolves to the 'Resolve with AI' UI action",
      !!noRemediation && noRemediation.package === "left-pad" && noRemediation.fix_available === false && noRemediation.fix_type === null &&
      uiAction(noRemediation).action === "resolve_with_ai" && !hasVersionBadge(noRemediation),
      JSON.stringify({ finding: noRemediation ? { fix_available: noRemediation.fix_available, fix_type: noRemediation.fix_type } : null, action: uiAction(noRemediation || {}).action }));

    // 3b · UI action contract mirror: fix_available true → "Fix"; false → "Resolve with AI"
    harness.check("3b the UI action contract maps fix_available to Fix and its absence to Resolve with AI (recommended_version gates the badge)",
      uiAction({ fix_available: true, fix_type: "upgrade", recommended_version: "1.1.0" }).action === "fix" &&
      uiAction({ fix_available: true, fix_type: "pin_version", recommended_version: "2.0.0" }).action === "fix" &&
      uiAction({ fix_available: true, fix_type: "lockfile", recommended_version: null }).action === "fix" &&
      uiAction({ fix_available: false, fix_type: null, recommended_version: null }).action === "resolve_with_ai" &&
      hasVersionBadge({ recommended_version: "1.1.0" }) === true && hasVersionBadge({ recommended_version: null }) === false,
      "fix_available true → Fix; false → Resolve with AI; recommended_version gates the badge");

    // 4 · no automatic package mutation occurs (scan never writes ProjectDependency or versions)
    const depCountBefore = (await svc.entities.ProjectDependency.filter({ project_id: projD.id }, "package_name", 50)).length;
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: projD.id }, "-number", 50)).length;
    // Re-run the scan (cache-miss path → a second execute over the same row) and re-measure.
    await svc.entities.ProjectVersion.create({ project_id: projD.id, number: 2, message: "change" });
    await surface(projD, ws, user, { action: "run" });
    const rowD2 = (await svc.entities.SecurityScan.filter({ project_id: projD.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowD2.id);
    const depCountAfter = (await svc.entities.ProjectDependency.filter({ project_id: projD.id }, "package_name", 50)).length;
    const versionsAfter = (await svc.entities.ProjectVersion.filter({ project_id: projD.id }, "-number", 50)).length;
    harness.check("4 running a scan never mutates packages — no ProjectDependency rows are written and no extra versions are created by the scan",
      depCountBefore === 0 && depCountAfter === 0 && versionsBefore === 1 && versionsAfter === 2,
      JSON.stringify({ deps: { before: depCountBefore, after: depCountAfter }, versions: { before: versionsBefore, after: versionsAfter } }));

    // 5 · ignore / restore still works on a dependency finding
    const fp = advisory.fingerprint;
    const ignored = await surface(projD, ws, user, { action: "ignore", fingerprint: fp });
    const ignoredDeps = ignored.body.result.dependency_vulnerabilities || [];
    harness.check("5 ignoring a dependency finding removes it from the projection and records the fingerprint",
      ignored.body.status === "up_to_date" && !ignoredDeps.some((d) => d.fingerprint === fp) &&
      ignored.body.result.ignored_fingerprints.includes(fp),
      JSON.stringify({ remaining: ignoredDeps.map((d) => d.package), ignored: ignored.body.result.ignored_fingerprints.length }));
    const restored = await surface(projD, ws, user, { action: "restore", fingerprint: fp });
    const restoredDeps = restored.body.result.dependency_vulnerabilities || [];
    harness.check("5b restoring the dependency finding puts it back and clears the fingerprint",
      restoredDeps.some((d) => d.fingerprint === fp) && restored.body.result.ignored_fingerprints.length === 0,
      JSON.stringify({ back: restoredDeps.map((d) => d.package), left: restored.body.result.ignored_fingerprints.length }));
    // The restored finding still carries its remediation metadata after the ignore/restore round trip.
    const restoredAdvisory = restoredDeps.find((d) => d.fingerprint === fp) || null;
    harness.check("5c remediation metadata survives the ignore/restore round trip",
      !!restoredAdvisory && restoredAdvisory.fix_available === true && restoredAdvisory.fix_type === "upgrade" && restoredAdvisory.recommended_version === "1.1.0",
      JSON.stringify({ restored: restoredAdvisory ? { t: restoredAdvisory.fix_type, v: restoredAdvisory.recommended_version } : null }));

    // 5d · ignoring/restoring an unknown fingerprint is still refused
    const unknownIgnore = await captureCall(() => surface(projD, ws, user, { action: "ignore", fingerprint: "deadbeef" }));
    harness.check("5d ignore/restore of an unknown fingerprint is still refused (lifecycle unchanged)",
      unknownIgnore.threw && unknownIgnore.code === "FINGERPRINT_NOT_FOUND", JSON.stringify({ code: unknownIgnore.code }));

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "SecurityScan", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "ProjectVersion", { project_id: pid });
      await purgeBy(svc, "ProjectFile", { project_id: pid });
      await purgeBy(svc, "ProjectDependency", { project_id: pid });
      await purgeBy(svc, "AppEntity", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await purgeBy(svc, "Budget", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}
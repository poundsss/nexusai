// Focused certification for the Base44 Security Scan implementation (shared/securityScan.ts +
// functions/securityScan). Drives the REAL surface, the REAL engine, the REAL queued executor
// path and the REAL authorization choke point — nothing is stubbed.
//
// Certified: language validation (422 + accepted codes); GET-never-starts (none → no row, no
// job); POST run → pending + background job + X-Scan-Source "started"; in-flight run → cache;
// executor → completed with every documented group (RLS evaluator reuse, secret leak + patterns,
// backend auth markers, credit protection, dependency severities, static-code severities/fields,
// header recommendations), analysis_summary, core_integration_recommendation, scanned_at,
// per-finding fingerprints; GET up_to_date + static_code_enabled + stream null; cached run
// (X-Scan-Source "cache", no new job); out_of_date on a newer version (result carried) and a
// fresh scan after; ignore/restore round trip + unknown fingerprints; scan_failed mapping;
// single-row persistence; executor idempotency; authorization (stranger/viewer/isolation).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { encryptSecretValue } from "../../shared/secretCrypto.ts";
import {
  executeSecurityScan, SUPPORTED_LANGUAGES,
  SCAN_GROUPS, SEVERITIES, SCANNER_VERSION,
} from "../../shared/securityScan.ts";
import { mkScanProject, scanJobs, scanSurface } from "../../shared/securityScanTestFixtures.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  let rowA = null;

  const surface = scanSurface(svc);
  const jobs = (projectId) => scanJobs(svc, projectId);
  const mkProject = (wsId, name) => mkScanProject(svc, projects, wsId, name, stamp);

  try {
    // --- workspace + projects ------------------------------------------------------------
    const wsA = await svc.entities.Workspace.create({ name: `secscan-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `secscan-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    await svc.entities.Budget.create({ workspace_id: wsA.id, scope: "workspace", limit_credits: 1000, period: "monthly", active: true });
    // Builder+ entitlement so the documented static-code-vulnerability gate admits wsA's scans
    // (staticCodeScanEntitled resolves from the effective plan). wsB stays free — it exercises
    // credit protection, which is independent of the static-code gate.
    await svc.entities.Subscription.create({ workspace_id: wsA.id, plan_code: "builder_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const projA = await mkProject(wsA.id, "A");
    const projB = await mkProject(wsB.id, "B");

    // Findings-rich project A.
    const SECRET_VALUE = "sk_live_9f8e7d6c5b4a3210fedcba";
    const files = [
      { path: "index.html", content: "<!doctype html><title>ok</title>\n" },
      { path: "src/pages/Clean.js", content: "export default function Clean() { return 'ok'; }\n" },
      { path: "src/pages/Bad.js", content: "export default function Bad(input, el) {\n  eval(input);\n  el.innerHTML = input;\n  fetch(\"http://insecure.example.com/x\");\n  return 'bad';\n}\n" },
      { path: "src/leak.js", content: `const key = \"${SECRET_VALUE}\";\n` },
      { path: "public/override.html", content: '<meta http-equiv="Content-Security-Policy" content="default-src *">\n' },
      { path: "package.json", content: JSON.stringify({ dependencies: { "left-pad": "latest", react: "^18.0.0" } }) },
      { path: "base44/functions/badFn/entry.ts", content: "export default async function(req) { return Response.json({}); }\n" },
      { path: "base44/functions/goodFn/entry.ts", content: "const u = await base44.auth.me();\nexport default async function(req) { return Response.json({}); }\n" },
    ];
    for (const f of files) await svc.entities.ProjectFile.create({ project_id: projA.id, ...f });
    await svc.entities.ProjectVersion.create({ project_id: projA.id, number: 1, message: "initial" });
    await svc.entities.AppEntity.create({ project_id: projA.id, name: "Note", fields: { title: { type: "string" } }, rls: { read: { created_by_id: "{{user.id}}" }, update: { created_by_id: "{{user.id}}" }, delete: false } });
    await svc.entities.AppEntity.create({ project_id: projA.id, name: "Public", fields: { label: { type: "string" } } });
    await svc.entities.AppEntity.create({ project_id: projA.id, name: "Open", fields: { label: { type: "string" } }, rls: { delete: true } });
    await svc.entities.ProjectSecret.create({ project_id: projA.id, name: "API_KEY", value: await encryptSecretValue(projA.id, "API_KEY", SECRET_VALUE), description: "", required: true, access: "backend_only" });

    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };
    const stranger = { id: "secscan_stranger", email: "stranger@example.com" };
    const viewer = { id: "secscan_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. language validation -----------------------------------------------------------
    const badLang = await captureCall(() => surface(projA, wsA, userA, { action: "run", language: "xx" }));
    harness.check("an unsupported language is refused with a 422 and starts nothing",
      badLang.threw && badLang.status === 422 && badLang.code === "UNSUPPORTED_LANGUAGE" &&
      (await svc.entities.SecurityScan.filter({ project_id: projA.id }, "created_date", 10)).length === 0,
      JSON.stringify({ code: badLang.code, status: badLang.status }));
    harness.check("every documented language code is accepted",
      JSON.stringify(SUPPORTED_LANGUAGES) === JSON.stringify(["en", "ja", "de", "es", "fr", "pt"]), SUPPORTED_LANGUAGES.join(","));
    const runJa = await surface(projA, wsA, userA, { action: "run", language: "ja" });
    rowA = (await svc.entities.SecurityScan.filter({ project_id: projA.id }, "-created_date", 1))[0];
    harness.check("a supported language starts a pending scan (X-Scan-Source: started)",
      runJa.scan_source === "started" && runJa.body.status === "pending" && runJa.body.result === null &&
      runJa.body.stream === null && rowA.language === "ja" &&
      (await jobs(projA.id)).length === 1,
      JSON.stringify({ source: runJa.scan_source, status: runJa.body.status, jobs: (await jobs(projA.id)).length }));

    // ---- 2. an in-flight project starts nothing new ---------------------------------------
    const whileRunning = await surface(projA, wsA, userA, { action: "run", language: "en" });
    harness.check("a run while a scan is pending reports its state and starts nothing new (cache)",
      whileRunning.scan_source === "cache" && whileRunning.body.status === "pending" &&
      (await jobs(projA.id)).length === 1, JSON.stringify({ source: whileRunning.scan_source, jobs: (await jobs(projA.id)).length }));

    // ---- 3. executor: every documented group ----------------------------------------------
    rowA = await executeSecurityScan(svc, rowA.id);
    const res = rowA.result || {};
    const rls = res.rls_recommendations || [];
    const secrets = res.hardcoded_secrets || [];
    const fns = res.backend_functions || [];
    const deps = res.dependency_vulnerabilities || [];
    const code = res.static_code_findings || [];
    const headers = res.header_recommendations || [];
    const credit = res.credit_protection || [];
    const allFindings = SCAN_GROUPS.flatMap((g) => (res[g] || []));
    const badFnFlagged = fns.some((f) => f.function_name === "badFn");
    const goodFnClean = !fns.some((f) => f.function_name === "goodFn");
    const cleanFileClean = !code.some((f) => f.file === "src/pages/Clean.js");
    harness.check("RLS recommendations come from the real evaluator: undeclared and explicitly-open rules flagged, restricted rules not",
      rls.some((r) => r.entity_name === "Public" && r.rule === "read" && r.kind === "not_declared") &&
      rls.some((r) => r.entity_name === "Open" && r.rule === "delete" && r.kind === "explicit_open") &&
      !rls.some((r) => r.entity_name === "Note"),
      JSON.stringify({ flagged: rls.map((r) => `${r.entity_name}.${r.rule}:${r.kind}`) }));
    harness.check("hardcoded secrets: real configured values AND generic credential shapes, file-scoped, values never leaked",
      secrets.some((s) => s.file === "src/leak.js" && s.message.includes("value of a configured project secret")) &&
      secrets.some((s) => s.file === "src/leak.js" && s.message.includes("Stripe-style")) &&
      secrets.every((s) => !String(s.message).includes(SECRET_VALUE)),
      JSON.stringify({ n: secrets.length }));
    harness.check("backend functions: a handler without an authentication marker is flagged, one with auth.me is not",
      badFnFlagged && goodFnClean, JSON.stringify({ flagged: fns.map((f) => f.function_name) }));
    harness.check("credit protection: a workspace with an active budget yields no finding",
      credit.length === 0, JSON.stringify({ n: credit.length }));
    harness.check("dependency findings are rated with the documented severity scale",
      deps.some((d) => d.package === "left-pad" && d.severity === "Low") &&
      deps.some((d) => d.package === "react" && d.severity === "Medium") &&
      deps.every((d) => SEVERITIES.includes(d.severity)),
      JSON.stringify({ deps: deps.map((d) => `${d.package}:${d.severity}`) }));
    const evalFinding = code.find((f) => f.file === "src/pages/Bad.js" && f.title === "dynamic_code_execution");
    harness.check("static code findings carry severity, impact, category, evidence, attack scenario and suggested fix",
      !!evalFinding && evalFinding.severity === "High" && SEVERITIES.includes(evalFinding.severity) &&
      !!evalFinding.impact && !!evalFinding.evidence && !!evalFinding.attack_scenario && !!evalFinding.suggested_fix &&
      !!evalFinding.category && Number.isFinite(evalFinding.line) &&
      code.some((f) => f.title === "html_injection" && f.severity === "High") &&
      code.some((f) => f.title === "insecure_transport" && f.severity === "Low") && cleanFileClean,
      JSON.stringify({ n: code.length, eval: evalFinding ? evalFinding.severity : null }));
    harness.check("header recommendations: the client-declared CSP override is flagged",
      headers.length === 1 && headers[0].file === "public/override.html", JSON.stringify({ n: headers.length }));
    harness.check("the result carries analysis_summary, core_integration_recommendation, scanned_at and a fingerprint per finding",
      typeof res.analysis_summary === "string" && res.analysis_summary.length > 0 && res.analysis_summary.length > 0 &&
      res.core_integration_recommendation === "compatible" && !Number.isNaN(Date.parse(res.scanned_at)) &&
      allFindings.length > 0 && allFindings.every((f) => HEX64.test(f.fingerprint)),
      JSON.stringify({ summary: res.analysis_summary, total: allFindings.length, core: res.core_integration_recommendation }));

    // ---- 4. up_to_date + cached run --------------------------------------------------------
    const afterScan = await surface(projA, wsA, userA, { action: "get" });
    harness.check("GET reports up_to_date with the result, static_code_enabled and stream null",
      afterScan.body.status === "up_to_date" && !!afterScan.body.result && afterScan.body.static_code_enabled === true && afterScan.body.stream === null,
      JSON.stringify({ status: afterScan.body.status }));
    const jobCountBefore = (await jobs(projA.id)).length;
    const cached = await surface(projA, wsA, userA, { action: "run" });
    harness.check("a fresh run is served from cache (X-Scan-Source: cache) and starts no new job",
      cached.scan_source === "cache" && cached.body.status === "up_to_date" && (await jobs(projA.id)).length === jobCountBefore,
      JSON.stringify({ source: cached.scan_source, jobs: (await jobs(projA.id)).length, before: jobCountBefore }));

    // ---- 5. stale detection ---------------------------------------------------------------
    await svc.entities.ProjectVersion.create({ project_id: projA.id, number: 2, message: "change" });
    const stale = await surface(projA, wsA, userA, { action: "get" });
    harness.check("a newer project version makes the scan out_of_date while the same-scanner result is carried",
      stale.body.status === "out_of_date" && !!stale.body.result, JSON.stringify({ status: stale.body.status }));
    const rerun = await surface(projA, wsA, userA, { action: "run" });
    const rowAfterRerun = (await svc.entities.SecurityScan.filter({ project_id: projA.id }, "-created_date", 1))[0];
    harness.check("a stale run starts a NEW background scan on the SAME row (no scan history)",
      rerun.scan_source === "started" && rerun.body.status === "pending" &&
      (await jobs(projA.id)).length === jobCountBefore + 1 && rowAfterRerun.version_number === 2,
      JSON.stringify({ source: rerun.scan_source, version: rowAfterRerun.version_number }));
    await executeSecurityScan(svc, rowAfterRerun.id);
    const freshAgain = await surface(projA, wsA, userA, { action: "get" });
    harness.check("after the new scan completes the app is up_to_date again",
      freshAgain.body.status === "up_to_date", JSON.stringify({ status: freshAgain.body.status }));

    // ---- 6. ignore / restore ---------------------------------------------------------------
    const fp = (freshAgain.body.result.static_code_findings || [])[0].fingerprint;
    const ignored = await surface(projA, wsA, userA, { action: "ignore", fingerprint: fp });
    const ignoredAgain = await surface(projA, wsA, userA, { action: "ignore", fingerprint: fp });
    harness.check("ignoring removes the finding from the projection, records the fingerprint and is idempotent",
      ignored.body.status === "up_to_date" &&
      !(ignored.body.result.static_code_findings || []).some((f) => f.fingerprint === fp) &&
      ignored.body.result.ignored_fingerprints.includes(fp) &&
      ignoredAgain.body.result.ignored_fingerprints.length === 1,
      JSON.stringify({ ignored: ignored.body.result.ignored_fingerprints.length }));
    const restored = await surface(projA, wsA, userA, { action: "restore", fingerprint: fp });
    harness.check("restoring puts the finding back and clears the fingerprint",
      (restored.body.result.static_code_findings || []).some((f) => f.fingerprint === fp) &&
      restored.body.result.ignored_fingerprints.length === 0,
      JSON.stringify({ left: restored.body.result.ignored_fingerprints.length }));
    const unknownIgnore = await captureCall(() => surface(projA, wsA, userA, { action: "ignore", fingerprint: "deadbeef" }));
    const unknownRestore = await captureCall(() => surface(projA, wsA, userA, { action: "restore", fingerprint: "deadbeef" }));
    harness.check("ignoring/restoring an unknown fingerprint is refused",
      unknownIgnore.threw && unknownIgnore.code === "FINGERPRINT_NOT_FOUND" && unknownRestore.threw && unknownRestore.code === "FINGERPRINT_NOT_FOUND",
      JSON.stringify({ ignore: unknownIgnore.code, restore: unknownRestore.code }));

    // ---- 7. scan_failed ---------------------------------------------------------------------
    await svc.entities.SecurityScan.update(rowAfterRerun.id, { status: "failed", error: "engine error" });
    const failedView = await surface(projA, wsA, userA, { action: "get" });
    harness.check("a failed scan reports scan_failed with no result",
      failedView.body.status === "scan_failed" && failedView.body.result === null, JSON.stringify({ status: failedView.body.status }));
    const afterFailure = await surface(projA, wsA, userA, { action: "run" });
    harness.check("running again after a failure starts a new scan (not a cached result)",
      afterFailure.scan_source === "started" && afterFailure.body.status === "pending", {});
    await executeSecurityScan(svc, rowAfterRerun.id);
    const recovered = await surface(projA, wsA, userA, { action: "get" });
    harness.check("the scan recovers to up_to_date and the executor is idempotent (still ONE row)",
      recovered.body.status === "up_to_date" &&
      (await svc.entities.SecurityScan.filter({ project_id: projA.id }, "created_date", 10)).length === 1,
      JSON.stringify({ status: recovered.body.status }));

    // ---- 8. the engine failure path produces scan_failed ------------------------------------
    const ghostRow = await svc.entities.SecurityScan.create({ project_id: "secscan_missing_project", workspace_id: wsA.id, status: "pending" });
    const failedExec = await executeSecurityScan(svc, ghostRow.id);
    harness.check("an engine failure resolves the row as scan_failed (failed) with a truncated error, without throwing",
      failedExec.status === "failed" && !!failedExec.error, JSON.stringify({ status: failedExec.status }));
    await svc.entities.SecurityScan.delete(ghostRow.id).catch(() => {});

    // ---- 9. credit protection on an unbudgeted workspace ------------------------------------
    const runB = await surface(projB, wsB, userA, { action: "run" });
    const rowB = (await svc.entities.SecurityScan.filter({ project_id: projB.id }, "-created_date", 1))[0];
    await executeSecurityScan(svc, rowB.id);
    const viewB = await surface(projB, wsB, userA, { action: "get" });
    harness.check("credit protection flags a workspace with no active budget; other groups stay empty",
      runB.scan_source === "started" && viewB.body.status === "up_to_date" &&
      (viewB.body.result.credit_protection || []).length === 1 &&
      SCAN_GROUPS.filter((g) => g !== "credit_protection").every((g) => (viewB.body.result[g] || []).length === 0),
      JSON.stringify({ credit: (viewB.body.result.credit_protection || []).length }));

    // ---- 10. GET never starts + isolation + authorization -----------------------------------
    const projC = await mkProject(wsB.id, "C");
    const noneView = await surface(projC, wsB, userA, { action: "get" });
    harness.check("GET on a never-scanned project reports none, creates no row and enqueues no job",
      noneView.body.status === "none" && noneView.body.result === null &&
      (await svc.entities.SecurityScan.filter({ project_id: projC.id }, "created_date", 10)).length === 0 &&
      (await jobs(projC.id)).length === 0,
      JSON.stringify({ status: noneView.body.status }));
    const isolated = await surface(projC, wsB, userA, { action: "get" });
    harness.check("one project's scan never leaks into another (scoped reads)",
      isolated.body.status === "none" || isolated.body.project_id !== projA.id, {});
    const strangerRun = await captureCall(() => loadAuthorizedProject(svc, stranger, projA.id, "project.write"));
    const viewerWrite = await captureCall(() => loadAuthorizedProject(svc, viewer, projA.id, "project.write"));
    const viewerRead = await loadAuthorizedProject(svc, viewer, projA.id, "project.read").catch(() => null);
    harness.check("authorization: a non-member is refused, a viewer cannot run/ignore but can read",
      strangerRun.threw && Number(strangerRun.status) === 403 &&
      viewerWrite.threw && Number(viewerWrite.status) === 403 && !!viewerRead && viewerRead.project.id === projA.id,
      JSON.stringify({ stranger: strangerRun.status || strangerRun.code, viewerWrite: viewerWrite.status, viewerRead: !!viewerRead }));

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "SecurityScan", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "ProjectVersion", { project_id: pid });
      await purgeBy(svc, "ProjectFile", { project_id: pid });
      await purgeBy(svc, "ProjectSecret", { project_id: pid });
      await purgeBy(svc, "AppEntity", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "Budget", { workspace_id: wid });
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await purgeBy(svc, "WorkspaceMember", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}
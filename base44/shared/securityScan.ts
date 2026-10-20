// Base44 Security Scan — the audited implementation over the DOCUMENTED contract.
//
// DOCUMENTED (Base44): docs.base44.com "Running a security scan" + API beta
// "Run security scan" (POST /api/apps/{app_id}/security/scan) and
// "Get security scan" (GET /api/apps/{app_id}/security/scan).
//
// Pinned by the docs (parity):
//   • statuses  none | pending | scanning | up_to_date | out_of_date | scan_failed;
//   • POST returns either a cached result or starts a scan in the background; the
//     X-Scan-Source header distinguishes the two cases; `language` is a lowercase
//     two-letter code (en, ja, de, es, fr, pt) rejected with a 422 otherwise;
//   • GET NEVER starts a scan — it is the read-only status/result surface to poll
//     while pending/scanning;
//   • result: analysis_summary, rls_recommendations, hardcoded_secrets,
//     backend_functions, dependency_vulnerabilities, static_code_findings,
//     header_recommendations, core_integration_recommendation, ignored_fingerprints,
//     scanned_at; plus static_code_enabled on the envelope;
//   • pending/scanning can carry an earlier result while you wait; out_of_date means
//     the app changed since the last scan (result stale or absent — ABSENT when the
//     last scan came from a different version of the scanner); scan_failed means the
//     last scan died, so run another;
//   • findings for dependency and code groups are rated Critical | High | Medium | Low;
//   • findings can be ignored and restored (ignored_fingerprints); fixes are NEVER
//     applied automatically.
//
// UNKNOWN in Base44's contract — every choice below is NEXUSAI-DERIVED / NON-PARITY and
// never claimed as Base44 behavior:
//   • the check CONTENTS of each group (only group NAMES are published), the severity
//     MAPPING for rated groups, the finding field schema beyond the severity note, the
//     fingerprint ALGORITHM (only the concept of ignored_fingerprints is documented),
//   • core_integration_recommendation values/semantics ("compatible" is the only
//     value shown in the docs),
//   • progressive stream/sections content (the documented stream appears only during
//     scanning for rollout callers; this implementation runs the scan in one queued
//     step and reports stream: null),
//   • the exact staleness source (this implementation: the project's latest
//     ProjectVersion number plus the newest ProjectFile updated_date),
//   • plan gating for scans (none documented — scans are free for every plan),
//   • generated-text engine (deterministic per-language summary templates are used
//     instead of an LLM, so scans cost no credits and stay reproducible).

import { audit } from "./authz.ts";
import { gateFor } from "./rls.ts";
import { scanForSecrets } from "./deploy.ts";
import { resolveSecretValues } from "./secretCrypto.ts";
import { readManifest, readLockfile } from "./dependencies.ts";
import { availableVersions, vulnerabilityStatus } from "./packageRegistry.ts";
import { resolveScanFiles } from "./seoScan.ts";
import { enqueue } from "./jobQueue.ts";
import { log } from "./observability.ts";
import { staticCodeScanEntitled } from "./planLimits.ts";

export const SUPPORTED_LANGUAGES = ["en", "ja", "de", "es", "fr", "pt"];
export const SCANNER_VERSION = "1";
export const SECURITY_SCAN_JOB_TYPE = "security.scan";
export const SCAN_STATUSES = ["none", "pending", "scanning", "up_to_date", "out_of_date", "scan_failed"];
export const SEVERITIES = ["Critical", "High", "Medium", "Low"];

// The finding-group keys of the result document. `credit_protection` is one of the seven
// DOCUMENTED check types whose group name the API docs do not spell out ("including …"),
// so the name here is NexusAI-derived.
export const SCAN_GROUPS = [
  "rls_recommendations", "hardcoded_secrets", "backend_functions", "credit_protection",
  "dependency_vulnerabilities", "static_code_findings", "header_recommendations",
];

const nowIso = () => new Date().toISOString();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The one fingerprint machine: a deterministic hash over the finding's identity
// (group | file/subject | title). NEXUSAI-DERIVED — Base44 documents the
// ignored_fingerprints concept, not its algorithm.
function fingerprintOf(group, subject, title) {
  return sha256Hex(`${group}|${String(subject || "")}|${String(title || "")}`);
}

// Deterministic per-language summary templates (NEXUSAI-DERIVED — Base44 generates this
// text with a model; the shape "one analysis_summary string" is what is documented).
const SUMMARY_TEMPLATES = {
  en: (n, g) => n === 0 ? "No security findings were detected in this app." : `${n} security finding(s) across ${g} area(s); review the recommendations before applying any fixes.`,
  ja: (n, g) => n === 0 ? "セキュリティ上の問題は検出されませんでした。" : `${n}件のセキュリティ上の問題が${g}領域で検出されました。修正を適用する前に推奨事項を確認してください。`,
  de: (n, g) => n === 0 ? "Keine Sicherheitsprobleme gefunden." : `${n} Sicherheitsproblem(e) in ${g} Bereich(en); Empfehlungen prüfen, bevor Korrekturen angewendet werden.`,
  es: (n, g) => n === 0 ? "No se detectaron hallazgos de seguridad." : `${n} hallazgo(s) de seguridad en ${g} área(s); revise las recomendaciones antes de aplicar correcciones.`,
  fr: (n, g) => n === 0 ? "Aucun problème de sécurité détecté." : `${n} problème(s) de sécurité dans ${g} domaine(s); examinez les recommandations avant d'appliquer des correctifs.`,
  pt: (n, g) => n === 0 ? "Nenhum problema de segurança detectado." : `${n} problema(s) de segurança em ${g} área(s); revise as recomendações antes de aplicar correções.`,
};

// A synthetic user for the RLS evaluator: enough for gateFor to resolve templates
// ({{user.id}} → null) without throwing, so a rule-bound gate is reported as
// restricted, exactly as it would be for an anonymous caller.
const SCAN_USER = { id: null, email: null, role: null };

// --- deterministic static-code patterns -------------------------------------------
// NEXUSAI-DERIVED check set and severity mapping (UNKNOWN in Base44; the documented
// contract pins only that code findings carry a Critical/High/Medium/Low rating).
const CODE_PATTERNS = [
  { id: "dynamic_code_execution", severity: "High", category: "code_execution", re: /\beval\s*\(|new\s+Function\s*\(/, impact: "untrusted input can execute as code inside the app", attack: "an attacker-controlled string reaches eval/Function and runs", fix: "replace dynamic evaluation with explicit logic or a safe parser" },
  { id: "html_injection", severity: "High", category: "xss", re: /\.innerHTML\s*=|\.outerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/, impact: "injected markup runs in the victim's browser", attack: "untrusted data assigned to innerHTML executes as HTML/script", fix: "render text nodes, or sanitize markup before injecting it" },
  { id: "command_execution", severity: "Critical", category: "command_execution", re: /child_process|\bexecSync\s*\(|\bexec\s*\(\s*["'`]|\bspawn\s*\(/, impact: "operating-system commands may be constructed from input", attack: "unsanitized input is concatenated into a command string", fix: "avoid shelling out; use platform APIs instead" },
  { id: "wide_open_cors", severity: "Medium", category: "cors", re: /Access-Control-Allow-Origin["'\s:,]+\*/, impact: "any origin can read the responses of a credentialed caller", attack: "a malicious site reads authenticated responses cross-origin", fix: "restrict CORS to the known origins that need it" },
  { id: "insecure_transport", severity: "Low", category: "transport", re: /["'`]http:\/\/(?!localhost|127\.0\.0\.1)/, impact: "traffic can be read or modified in transit", attack: "credentials or session data travel over plaintext http://", fix: "use https:// endpoints" },
];
const AUTH_MARKERS = ["auth.me", "requireWorkerAuth", "verifyWebhookRequest", "requireAdmin", "verifyWorkerAuth", "requirePlatformAdmin"];
const FLOATING_VERSIONS = new Set(["latest", "*", ""]);

// --- the pure engine ---------------------------------------------------------------
// One deterministic pass over the project's resolved inputs. Same inputs → same result.

async function checkRls(svc, projectId) {
  const entities = await svc.entities.AppEntity.filter({ project_id: projectId }, "name", 200).catch(() => []);
  const out = [];
  for (const e of entities) {
    for (const op of ["read", "update", "delete"]) {
      const declared = e.rls && e.rls[op] !== undefined && e.rls[op] !== null;
      const gate = gateFor(e, op, SCAN_USER); // THE RLS evaluator — reused, not reinterpreted
      if (!gate.open) continue;
      const kind = declared ? "explicit_open" : "not_declared";
      const message = declared
        ? `${e.name}.${op} is explicitly open — every app user (and an anonymous caller) passes the rule`
        : `${e.name}.${op} has no row-level rule — access falls back to the project's default posture`;
      out.push({ entity_name: e.name, rule: op, kind, message, fingerprint: await fingerprintOf("rls_recommendations", `${e.name}.${op}`, kind) });
    }
  }
  return out;
}

async function checkSecrets(files, secretRows, projectId) {
  const { values } = await resolveSecretValues(secretRows, projectId);
  const leaked = scanForSecrets(files, [...values.values()]);
  return Promise.all(leaked.map(async (line) => {
    const idx = line.indexOf(": ");
    const file = idx > 0 ? line.slice(0, idx) : line;
    const message = idx > 0 ? line.slice(idx + 2) : "contains a credential";
    return { file, message, fingerprint: await fingerprintOf("hardcoded_secrets", file, message) };
  }));
}

function checkBackendFunctions(files) {
  const out = [];
  for (const f of files) {
    const m = String(f.path || "").match(/^base44\/functions\/([^/]+)\/entry\.ts$/);
    if (!m) continue;
    const has = AUTH_MARKERS.some((k) => String(f.content || "").includes(k));
    if (!has) {
      out.push({ function_name: m[1], message: "no authentication check detected in the handler" });
    }
  }
  return out;
}

async function checkCreditProtection(svc, workspaceId) {
  const budgets = await svc.entities.Budget.filter({ workspace_id: workspaceId, active: true }, "created_date", 50).catch(() => []);
  if (budgets.length) return [];
  return [{ scope: "workspace", message: "no active credit budget is configured for this workspace — AI operations can consume unbounded credits" }];
}

// Optional remediation metadata for a dependency finding (NEXUSAI-DERIVED — Base44 documents the
// finding group but not its remediation surface). `fix_available` means a direct, safe remediation
// path exists (pin a floating range, regenerate the lockfile, upgrade to a known-fixed version);
// `fix_type` names it; `recommended_version` is the target version when one is known. Findings
// with no direct remediation (fix_available false) fall back to "Resolve with AI" in the UI.
// Nothing here mutates packages — the metadata only describes the remediation the EXISTING
// dependency mutation path (applyDependencyChange) would apply; no package is auto-patched.
const normSeverity = (s) => SEVERITIES.find((x) => x.toLowerCase() === String(s || "").toLowerCase()) || "Medium";
const bestSafeVersion = (name) => availableVersions(name).find((v) => {
  const p = vulnerabilityStatus(name, v);
  return p.advisory_data_available && p.vulnerability_status === "none_known";
}) || null;

function checkDependencies(files) {
  const manifest = readManifest(files);
  const lock = readLockfile(files);
  const out = [];
  if (!manifest.exists) return out;
  const locked = new Map((lock.packages || []).map((p) => [p.name, p]));
  for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    const vers = String(version).trim();
    if (FLOATING_VERSIONS.has(vers)) {
      const latest = availableVersions(name).slice(-1)[0] || null;
      out.push({
        package: name, version: vers, severity: "Low",
        message: "floating version range — builds are not reproducible and a compromised registry publish would be picked up",
        fix_available: !!latest, fix_type: latest ? "pin_version" : null, recommended_version: latest,
      });
      continue;
    }
    // Advisory posture over the exact locked version (curated catalog; pure, no network). A
    // vulnerable package with a known-fixed catalog version offers a direct upgrade; otherwise
    // the finding carries no remediation and the UI falls back to "Resolve with AI".
    if (locked.has(name)) {
      const resolved = String(locked.get(name).version || "");
      const posture = vulnerabilityStatus(name, resolved);
      if (posture.advisory_data_available && posture.vulnerability_status === "vulnerable" && (posture.vulnerabilities || []).length) {
        const worst = (posture.vulnerabilities || []).reduce((acc, v) =>
          SEVERITIES.indexOf(normSeverity(v.severity)) < SEVERITIES.indexOf(normSeverity(acc.severity)) ? v : acc
        , posture.vulnerabilities[0]);
        const safe = bestSafeVersion(name);
        out.push({
          package: name, version: resolved, severity: normSeverity(worst.severity),
          message: `${posture.vulnerabilities.length} known advisories: ${(posture.vulnerabilities || []).map((v) => v.advisory_id).join(", ")}`,
          fix_available: !!safe, fix_type: safe ? "upgrade" : null, recommended_version: safe,
        });
        continue;
      }
    }
    if (!lock.exists || !locked.has(name)) {
      out.push({
        package: name, version: vers, severity: "Medium",
        message: lock.exists ? "declared in the manifest but not pinned by the lockfile" : "the project pins no lockfile, so the declared version is never verified",
        fix_available: true, fix_type: "lockfile", recommended_version: null,
      });
    }
  }
  return out;
}

async function checkStaticCode(files) {
  const out = [];
  for (const f of files) {
    const content = String(f.content || "");
    for (const p of CODE_PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(content);
      if (!m) continue;
      const line = content.slice(0, m.index).split("\n").length;
      const evidence = (content.split("\n")[line - 1] || "").trim().slice(0, 140) || m[0];
      out.push({
        file: f.path, line, title: p.id, category: p.category, severity: p.severity,
        impact: p.impact, attack_scenario: p.attack, suggested_fix: p.fix, evidence,
        fingerprint: await fingerprintOf("static_code_findings", f.path, p.id),
      });
    }
  }
  return out;
}

function checkHeaders(files) {
  const out = [];
  for (const f of files) {
    if (/<meta[^>]+http-equiv=["']?Content-Security-Policy/i.test(String(f.content || ""))) {
      out.push({ file: f.path, message: "a client-declared CSP meta tag may conflict with the server-owned deployed policy" });
    }
  }
  return out;
}

/** Runs every documented group over the resolved inputs and assembles the result document. */
export async function runSecurityScanEngine(svc, row) {
  const project = await svc.entities.Project.get(row.project_id);
  const files = await resolveScanFiles(svc, row.project_id);
  const secretRows = await svc.entities.ProjectSecret.filter({ project_id: row.project_id }, "name", 200).catch(() => []);
  const groups = {
    rls_recommendations: await checkRls(svc, row.project_id),
    hardcoded_secrets: await checkSecrets(files, secretRows, row.project_id),
    backend_functions: checkBackendFunctions(files),
    credit_protection: await checkCreditProtection(svc, row.workspace_id),
    dependency_vulnerabilities: checkDependencies(files),
    // Code-vulnerability scanning is gated to Builder+ (DOCUMENTED Base44). A below-Builder
    // workspace has static_code_enabled=false (stamped at run start), so no code findings are
    // produced — every other group still runs. Findings are never invented for an unentitled plan.
    static_code_findings: row.static_code_enabled === false ? [] : await checkStaticCode(files),
    header_recommendations: checkHeaders(files),
  };
  // Every finding carries a fingerprint (the ignore/restore key): a deterministic hash
  // over the group and the finding's identifying fields.
  for (const [group, findings] of Object.entries(groups)) {
    for (const f of findings) {
      if (!f.fingerprint) {
        f.fingerprint = await fingerprintOf(group, f.file || f.entity_name || f.function_name || f.package || f.scope || "", f.message || f.title || "");
      }
    }
  }
  const total = SCAN_GROUPS.reduce((n, g) => n + (groups[g] || []).length, 0);
  const template = SUMMARY_TEMPLATES[row.language] || SUMMARY_TEMPLATES.en;
  return {
    analysis_summary: template(total, SCAN_GROUPS.filter((g) => (groups[g] || []).length > 0).length),
    ...groups,
    core_integration_recommendation: "compatible", // the only documented value; semantics UNKNOWN
    ignored_fingerprints: [...(row.ignored_fingerprints || [])],
    scanned_at: nowIso(),
  };
}

// --- persistence + lifecycle --------------------------------------------------------

const newestRow = async (svc, projectId) =>
  (await svc.entities.SecurityScan.filter({ project_id: projectId }, "-created_date", 1))[0] || null;

// The one-row invariant (the docs document only a "latest result"). A concurrent POST that
// lost the create race deletes its loser.
async function enforceSingleRow(svc, projectId, keepId) {
  // The storage layer does not honor `$ne` in a deleteMany filter (a broad query would wipe
  // every row, the kept one included), so the losers are resolved by id first and deleted
  // explicitly — the kept row is never named, it can only be lost by a filter bug.
  try {
    const others = (await svc.entities.SecurityScan.filter({ project_id: projectId }, "created_date", 100))
      .filter((r) => r.id !== keepId);
    for (const r of others) await svc.entities.SecurityScan.delete(r.id);
  } catch { /* a failed dedup must not fail the run */ }
}

// The staleness markers captured at scan START.
async function captureStaleMarkers(svc, project) {
  const latestVersion = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1).catch(() => []))[0] || null;
  const fileRow = (await svc.entities.ProjectFile.filter({ project_id: project.id }, "-updated_date", 1).catch(() => []))[0] || null;
  return {
    version_number: latestVersion ? Number(latestVersion.number) : 0,
    content_updated_at: fileRow ? String(fileRow.updated_date) : nowIso(),
    production_version_number: project.production_version_number != null ? Number(project.production_version_number) : null,
    production_deployment_id: project.production_deployment_id || null,
  };
}

async function isFresh(svc, project, row) {
  const latest = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1).catch(() => []))[0] || null;
  if (Number(row.version_number || 0) < (latest ? Number(latest.number) : 0)) return false;
  const fileRow = (await svc.entities.ProjectFile.filter({ project_id: project.id }, "-updated_date", 1).catch(() => []))[0] || null;
  if (fileRow && row.content_updated_at && String(fileRow.updated_date) > String(row.content_updated_at)) return false;
  return true;
}

/** COMPUTED (never stored): the documented status surface for one project. */
export async function computeScanStatus(svc, project, row) {
  if (!row) return "none";
  if (row.status === "pending" || row.status === "scanning") return row.status;
  if (row.status === "failed") return "scan_failed";
  if (String(row.scanner_version || SCANNER_VERSION) !== SCANNER_VERSION) return "out_of_date";
  return (await isFresh(svc, project, row)) ? "up_to_date" : "out_of_date";
}

// Projection: the stored result with ignored findings filtered out of the groups.
export function projectResult(row) {
  const ignored = new Set(row.ignored_fingerprints || []);
  const result = row.result;
  if (!result) return null;
  const projected = { ...result };
  for (const g of SCAN_GROUPS) {
    if (Array.isArray(result[g])) projected[g] = result[g].filter((f) => !f.fingerprint || !ignored.has(f.fingerprint));
  }
  projected.ignored_fingerprints = [...(row.ignored_fingerprints || [])];
  return projected;
}

// The read-only status/result body — GET parity: it NEVER starts a scan.
export async function securityScanStatusBody(svc, project) {
  const row = await newestRow(svc, project.id);
  const status = await computeScanStatus(svc, project, row);
  let result = null;
  if (status === "up_to_date") result = projectResult(row);
  else if (status === "out_of_date" && row && String(row.scanner_version || "") === SCANNER_VERSION) result = projectResult(row); // stale but same scanner → carried
  else if ((status === "pending" || status === "scanning") && row) result = projectResult(row); // documented: may carry an earlier result
  return { status, result, static_code_enabled: row ? !!row.static_code_enabled : true, stream: null };
}

// The queued executor: the engine, the terminal row update and the audit — one shared path
// for the worker and the certification, idempotent (a retry re-runs the scan and converges).
export async function executeSecurityScan(svc, scanId) {
  const row = await svc.entities.SecurityScan.get(scanId).catch(() => null);
  if (!row) throw Object.assign(new Error("Security scan not found"), { status: 404, code: "SECURITY_SCAN_NOT_FOUND" });
  const started = Date.now();
  await svc.entities.SecurityScan.update(row.id, { status: "scanning", started_at: nowIso() });
  try {
    const result = await runSecurityScanEngine(svc, { ...row });
    const duration_ms = Date.now() - started;
    const updated = await svc.entities.SecurityScan.update(row.id, { status: "completed", result, duration_ms, completed_at: nowIso(), error: null });
    await audit(svc, {
      workspace_id: row.workspace_id, project_id: row.project_id, user_id: row.user_id || null,
      action: "security.scan.completed", resource: "SecurityScan", resource_id: row.id,
      metadata: { duration_ms, language: row.language || "en", version_number: row.version_number },
    });
    log("info", "security.scan.completed", { scan_id: row.id, duration_ms });
    return updated;
  } catch (e) {
    const duration_ms = Date.now() - started;
    await svc.entities.SecurityScan.update(row.id, {
      status: "failed", error: String(e.message || e).slice(0, 300), duration_ms, completed_at: nowIso(),
    }).catch(() => {});
    await audit(svc, {
      workspace_id: row.workspace_id, project_id: row.project_id, user_id: row.user_id || null,
      action: "security.scan.failed", resource: "SecurityScan", resource_id: row.id,
      metadata: { error: String(e.message || e).slice(0, 160) },
    }).catch(() => {});
    // Engine failures are deterministic (bad project state), so the job must NOT retry.
    return { id: row.id, status: "failed", error: String(e.message || e).slice(0, 300) };
  }
}

// The POST surface: cached up_to_date when the latest scan is fresh; otherwise a background
// scan starts through the EXISTING job queue. Returns { body, scan_source } — the HTTP layer
// turns scan_source into the documented X-Scan-Source header.
export async function securityScanSurface(svc, project, workspace, user, input) {
  const action = String(input.action || "get");

  if (action === "get") {
    return { body: await securityScanStatusBody(svc, project), scan_source: null };
  }

  if (action === "run") {
    const language = input.language === undefined || input.language === null || input.language === "" ? "en" : String(input.language);
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw Object.assign(new Error(`unsupported language "${language}" — supported: ${SUPPORTED_LANGUAGES.join(", ")}`), { status: 422, code: "UNSUPPORTED_LANGUAGE" });
    }
    let row = await newestRow(svc, project.id);
    if (row && row.status === "completed" && String(row.scanner_version || "") === SCANNER_VERSION && (await isFresh(svc, project, row))) {
      // Cached: the result already reflects the app as it is now. No scan starts.
      return { body: { status: "up_to_date", result: projectResult(row), static_code_enabled: !!row.static_code_enabled, stream: null }, scan_source: "cache" };
    }
    if (row && (row.status === "pending" || row.status === "scanning")) {
      // A scan is already in flight for this project — report its state, start nothing new.
      return { body: { status: row.status, result: projectResult(row), static_code_enabled: !!row.static_code_enabled, stream: null }, scan_source: "cache" };
    }
    // Code-vulnerability scanning is gated to Builder or higher (DOCUMENTED Base44). Resolved
    // server-side from the workspace's effective plan; a below-Builder workspace gets
    // static_code_enabled=false and the engine produces no static_code_findings. The scan itself
    // and every other group remain available on every plan.
    const staticCodeEnabled = await staticCodeScanEntitled(svc, workspace);
    const markers = await captureStaleMarkers(svc, project);
    const patch = { status: "pending", language, scanner_version: SCANNER_VERSION, static_code_enabled: staticCodeEnabled, ...markers, started_at: null, completed_at: null, duration_ms: null, error: null };
    if (row) {
      row = await svc.entities.SecurityScan.update(row.id, patch);
    } else {
      row = await svc.entities.SecurityScan.create({
        project_id: project.id, workspace_id: workspace.id, user_id: user.id,
        status: "pending", language, scanner_version: SCANNER_VERSION, static_code_enabled: staticCodeEnabled,
        ignored_fingerprints: [], ...markers,
      });
      // Post-create dedup keeps the one-row invariant under a concurrent POST.
      await enforceSingleRow(svc, project.id, row.id);
    }
    await enqueue(svc, {
      queue: "default", job_type: SECURITY_SCAN_JOB_TYPE, payload: { scan_id: row.id },
      // Per-occurrence key: the scan's staleness markers, not just the row id. A retry of
      // THIS run reuses the same key (dedup safe), but a re-scan after the app changed
      // carries new markers and may enqueue a new job even though the row is the same.
      idempotency_key: `security.scan:${row.id}:${markers.version_number}:${markers.content_updated_at}`, max_attempts: 3,
      workspace_id: workspace.id, project_id: project.id,
    });
    return { body: { status: "pending", result: projectResult(row), static_code_enabled: staticCodeEnabled, stream: null }, scan_source: "started" };
  }

  if (action === "ignore" || action === "restore") {
    const fingerprint = String(input.fingerprint || "").trim();
    if (!fingerprint) throw Object.assign(new Error("fingerprint is required"), { status: 400, code: "FINGERPRINT_REQUIRED" });
    const row = await newestRow(svc, project.id);
    if (!row || !row.result) throw Object.assign(new Error("No scan result to modify"), { status: 409, code: "SECURITY_SCAN_NOT_COMPLETE" });
    const ignored = [...(row.ignored_fingerprints || [])];
    const known = new Set();
    for (const g of SCAN_GROUPS) for (const f of (row.result[g] || [])) if (f.fingerprint) known.add(f.fingerprint);
    if (action === "ignore") {
      if (!known.has(fingerprint)) throw Object.assign(new Error("fingerprint does not match any finding of the latest result"), { status: 404, code: "FINGERPRINT_NOT_FOUND" });
      if (!ignored.includes(fingerprint)) ignored.push(fingerprint);
    } else {
      if (!ignored.includes(fingerprint)) throw Object.assign(new Error("fingerprint is not ignored"), { status: 404, code: "FINGERPRINT_NOT_FOUND" });
      ignored.splice(ignored.indexOf(fingerprint), 1);
    }
    const updated = await svc.entities.SecurityScan.update(row.id, { ignored_fingerprints: ignored });
    return { body: { status: await computeScanStatus(svc, project, updated), result: projectResult(updated), static_code_enabled: !!updated.static_code_enabled, stream: null }, scan_source: null };
  }

  throw Object.assign(new Error(`Unknown action "${action}"`), { status: 400, code: "UNKNOWN_ACTION" });
}
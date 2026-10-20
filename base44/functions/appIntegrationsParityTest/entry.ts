// Certification for INTEGRATIONSMODULE PARITY: the SDK's `base44.integrations` client surface
// — Core.InvokeLLM / GenerateImage / UploadFile / SendEmail / ExtractDataFromUploadedFile /
// UploadPrivateFile / CreateFileSignedUrl and custom.call — exposed to generated apps through
// the bridge and dispatched onto the EXISTING certified server primitives.
//
// Runs against the REAL systems end to end: the real build + deployment worker, the real
// public runtime (appRuntime, invoked over its actual HTTP surface), the real builder-preview
// dispatch (previewIntegrations, over its real HTTP surface), the real primitive executor and
// AI-operation billing, the real file-storage and messaging primitives, the real
// custom-integration engine (executor → createIntegrationsApi → executeExternalTool) and the
// real canonical credit ledger. Only TWO boundaries are scripted, both following the
// established suite patterns:
//   • the custom integration's upstream host (globalThis.fetch, integrationEngineTest
//     pattern) — a controlled "crm" API, while every platform call passes through untouched;
//   • nothing else. InvokeLLM / GenerateImage / ExtractDataFromUploadedFile run REAL platform
//     provider calls through the whole deployed chain, so the upstream success shapes are
//     certified against what production actually serves.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { loadArtifactPayload, currentLiveDeployment } from "../../shared/deploy.ts";
import { normalizeIntegration, serializeIntegration, integrationPath } from "../../shared/integrations.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { handleAppIntegrations, webContextBlock } from "../../shared/appIntegrations.ts";
import { runWebSearch, isWebSearchConfigured, WEB_SEARCH_PROVIDER } from "../../shared/webSearch.ts";
import { getModel } from "../../shared/modelCatalog.ts";
import { RUNTIME_EXPORTS, ENTRY_FILE } from "../../shared/runtimeExports.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
// The app imports the NEW integrations export alongside the unified sdk object, so the build
// itself proves the runtime module ships it.
const APP = `import { html, sdk, integrations } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Integrations</h1>\${sdk && integrations ? '' : ''}</div>\`; }
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

// The project's own custom integration: a "crm" HTTP API whose upstream host is the scripted
// test host. Declared through the REAL normalizer, exactly as the builder writes it.
const CRM_DOC = normalizeIntegration({
  name: "crm",
  type: "http",
  description: "Parity CRM",
  // A PUBLIC IP LITERAL, not a resolvable hostname: the engine's DNS-rebinding guard
  // (assertResolvedUrl) resolves hostnames through node:dns BEFORE dispatch and fail-closes
  // where DNS is unavailable — a fetch stub cannot help because it sits after the guard.
  // IP literals are validated against the guard's blocklist and skip resolution entirely,
  // so the scripted fetch stub remains the reachable network boundary.
  base_url: "http://93.184.216.34",
  auth: { type: "none" },
  operations: [
    { name: "getContacts", method: "GET", path: "/contacts", parameters: [{ name: "limit", in: "query", type: "number" }] },
    { name: "getMissing", method: "GET", path: "/missing" },
    { name: "createUser", method: "POST", path: "/users/{id}", parameters: [{ name: "id", in: "path", required: true, type: "string" }] },
  ],
});
const CRM_PATH = integrationPath("crm");
const CRM_JSON = serializeIntegration(CRM_DOC);

const PASSWORD = "Sup3r-Secret-Integrations-1";
const TEST_HOST = "93.184.216.34";

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 700) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const created = { workspaces: [], projects: [], plans: [] };
  let plan = null;

  // The scripted upstream (network boundary only, integrationEngineTest pattern): a controlled
  // "crm" server. Every non-test-host fetch passes through to the real network.
  const realFetch = globalThis.fetch;
  const upstreamCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== TEST_HOST) return realFetch(url, options);
    const body = typeof options.body === "string" ? options.body : "";
    upstreamCalls.push({ url: u.toString(), method: options.method || "GET", query: options.query || null, body });
    if (u.pathname === "/contacts") return new Response(JSON.stringify({ contacts: [{ id: 1 }, { id: 2 }], count: 2 }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/missing") return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    if (u.pathname.startsWith("/users/")) return new Response(JSON.stringify({ created: true, id: u.pathname.split("/").pop() }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const stamp = Date.now();

    // ---------------------------------------------------------------- fixtures
    // ONE workspace owned by the calling user (so BOTH the slug-addressed deployed runtime and
    // the member-authorized preview surface reach it), subscribed to a hidden test plan with
    // unrestricted model access, and provisioned through the REAL ledger.
    plan = await svc.entities.BillingPlan.create({
      code: `intpar_${stamp}`, name: "Parity Plan", price_cents: 0, interval: "monthly", tier_rank: 1,
      visibility: "hidden", active: true, included_credits: 0, overage_policy: "allow_overage",
      limits: {}, usage_limits: {}, model_access: [], entitlements: {}, provider: "none",
    });
    created.plans.push(plan.id);
    const ws = await svc.entities.Workspace.create({ name: `intpar-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: plan.code, status: "active", provider: "none", current_period_start: new Date().toISOString(), entitlements: {} });
    await grantTestPool(svc, { workspace_id: ws.id, pool: "integration", amount: 500, key: `intpar-int-${stamp}`, reason: "Parity suite grant" });
    await grantTestPool(svc, { workspace_id: ws.id, pool: "message", amount: 500, key: `intpar-msg-${stamp}`, reason: "Parity suite grant" });
    // A SECOND workspace with NO credits: only the fail-closed refusals may touch it.
    const brokeWs = await svc.entities.Workspace.create({ name: `intpar-broke-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(brokeWs.id);

    const entities = [{ name: "Note", fields: { title: { type: "string" } } }];
    const mk = (name, slug, wid, withCrm) => createDeployedApp(svc, {
      rls_enabled: true,
      workspace_id: wid, name, slug, deployed_by: user.id, entities,
      files: withCrm
        ? [[ENTRY_FILE, MAIN], ["src/App.js", APP], ["styles.css", STYLES], [CRM_PATH, CRM_JSON]]
        : [[ENTRY_FILE, MAIN], ["src/App.js", APP], ["styles.css", STYLES]],
      on_project_created: (p) => created.projects.push(p.id),
    });
    const a = await mk(`Integrations A ${stamp}`, `int-a-${stamp}`, ws.id, true);
    const b = await mk(`Integrations B ${stamp}`, `int-b-${stamp}`, ws.id, false);
    const c = await mk(`Integrations C ${stamp}`, `int-c-${stamp}`, brokeWs.id, false);
    const projectA = await svc.entities.Project.get(a.project.id);
    const projectB = await svc.entities.Project.get(b.project.id);
    const projectC = await svc.entities.Project.get(c.project.id);
    const slugA = projectA.slug, slugB = projectB.slug, slugC = projectC.slug;

    // Real generated-app end-users, through the REAL #29 auth path.
    const userA = await signUpWithSession(svc, projectA.id, { email: `a-${stamp}@intparity.test`, password: PASSWORD, full_name: "User A" }, {});
    const userB = await signUpWithSession(svc, projectB.id, { email: `b-${stamp}@intparity.test`, password: PASSWORD, full_name: "User B" }, {});
    const userC = await signUpWithSession(svc, projectC.id, { email: `c-${stamp}@intparity.test`, password: PASSWORD, full_name: "User C" }, {});

    // The deployed surface, over the public runtime's real HTTP surface.
    const runtime = appRuntimeCaller(svc);
    const rt = (slug, op, args = {}, token = null) =>
      runtime({ action: "integrations", slug, op, args, ...(token ? { session_token: token } : {}) });
    // The builder-preview surface, over its real HTTP surface.
    const pv = (body) =>
      base44.functions.invoke("previewIntegrations", body)
        .then((r) => ({ ok: true, status: 200, data: r.data ?? r }))
        .catch((e) => {
          const d = (e && (e.response?.data ?? e.data)) || null;
          return { ok: false, status: e.status || e.response?.status || 0, code: d?.code || e.code || null, data: d || {}, error: d?.error || String(e.message || e) };
        });
    const b64 = (s) => btoa(s);
    // poolBalance returns the derived pool VIEW ({ balance, reserved, available }); the checks
    // assert on its balance number.
    const intBal = async () => (await poolBalance(svc, ws.id, "integration")).balance;
    const msgBal = async () => (await poolBalance(svc, ws.id, "message")).balance;
    const msgStart = await msgBal();

    // ------------------------------------------------ 1. the runtime exports the surface
    const liveA = await currentLiveDeployment(svc, projectA, "production");
    const artifactA = await svc.entities.DeploymentArtifact.get(liveA.artifact_id);
    const payloadA = await loadArtifactPayload(artifactA);
    h.check("1 the runtime module ships the integrations export alongside the sdk alias",
      RUNTIME_EXPORTS.includes("integrations") && RUNTIME_EXPORTS.includes("files") &&
      a.run.status === "LIVE" && payloadA.client_files.some((f) => f.path === "src/App.js" && f.content.includes("integrations") && f.content.includes("sdk")) &&
      // Server-side material never ships to the client bundle.
      !payloadA.client_files.some((f) => f.path === CRM_PATH),
      `deployment ${a.run.status} · integrations export=${RUNTIME_EXPORTS.includes("integrations")}`);

    // ------------------------------------------------ 2-4. Core.UploadFile (public)
    const beforeUpload = await intBal();
    const up1 = await rt(slugA, "UploadFile", { filename: "pub.txt", content_type: "text/plain", content_base64: b64("hello parity") }, userA.token);
    const afterUpload1 = await intBal();
    h.check("2 Core.UploadFile returns the upstream { file_url } shape and charges exactly 1 integration credit",
      up1.status === 200 && typeof up1.data.result?.file_url === "string" && up1.data.result.file_url.length > 0 &&
      beforeUpload - afterUpload1 === 1 && (await msgBal()) === msgStart,
      `status ${up1.status} · Δcredits ${beforeUpload - afterUpload1} · body ${JSON.stringify(up1.data).slice(0, 160)}`);
    const up2 = await rt(slugA, "UploadFile", { filename: "pub2.txt", content_type: "text/plain", content_base64: b64("second file") }, userA.token);
    const afterUpload2 = await intBal();
    h.check("3 a repeated UploadFile uploads a second file and charges again (no invented idempotency)",
      up2.status === 200 && typeof up2.data.result?.file_url === "string" &&
      up2.data.result?.file_url !== up1.data.result?.file_url && afterUpload1 - afterUpload2 === 1,
      `Δcredits ${afterUpload1 - afterUpload2}`);
    const badMime = await rt(slugA, "UploadFile", { filename: "x.exe", content_type: "application/x-msdownload", content_base64: b64("nope") }, userA.token);
    const afterBadMime = await intBal();
    h.check("4 a rejected upload type is refused before storage and charges nothing",
      badMime.status === 415 && badMime.data.code === "FILE_TYPE_REJECTED" && afterBadMime === afterUpload2,
      `status ${badMime.status} ${badMime.data.code} · Δcredits ${afterBadMime - afterUpload2}`);
    const publicUrl = up1.data.result.file_url;

    // ------------------------------------------------ 5-7. private upload + signed URL
    const priv = await rt(slugA, "UploadPrivateFile", { filename: "priv.txt", content_type: "text/plain", content_base64: b64("private bytes") }, userA.token);
    const afterPriv = await intBal();
    h.check("5 Core.UploadPrivateFile returns the existing handle model and never the storage handle",
      priv.status === 200 && !!priv.data.result?.id && priv.data.result.filename === "priv.txt" &&
      !JSON.stringify(priv.data.result).includes("file_uri") && afterBadMime - afterPriv === 1,
      `file ${priv.data.result?.id} · Δcredits ${afterBadMime - afterPriv}`);
    const signed = await rt(slugA, "CreateFileSignedUrl", { file_uri: priv.data.result.id }, userA.token);
    h.check("6 Core.CreateFileSignedUrl mints the existing ownership-checked signed URL",
      signed.status === 200 && typeof signed.data.result?.signed_url === "string" && signed.data.result.expires_in === 300,
      `expires_in ${signed.data.result?.expires_in}`);
    // DOCUMENTED (SDK 0.8.52): the optional `expires_in` (default 300) controls the signed URL's
    // validity. LIVE-VERIFIED (2026-10-03): the platform primitive serves the custom TTL (the
    // signed URL's exp claim tracks it) and enforces its own server-side bounds (<60 / >3600
    // refused) — the cert asserts the observed refusal class only, never invented bounds.
    const signedTtl = await rt(slugA, "CreateFileSignedUrl", { file_uri: priv.data.result.id, expires_in: 3600 }, userA.token);
    const signedTtl2 = await rt(slugA, "CreateFileSignedUrl", { file_uri: priv.data.result.id, expires_in: 120 }, userA.token);
    const signedSmall = await rt(slugA, "CreateFileSignedUrl", { file_uri: priv.data.result.id, expires_in: 30 }, userA.token);
    const signedBig = await rt(slugA, "CreateFileSignedUrl", { file_uri: priv.data.result.id, expires_in: 3601 }, userA.token);
    h.check("6a the documented expires_in is honored: custom TTLs forwarded and echoed, out-of-range TTLs refused fail-closed",
      signedTtl.status === 200 && signedTtl.data.result?.expires_in === 3600 && typeof signedTtl.data.result?.signed_url === "string" &&
      signedTtl2.status === 200 && signedTtl2.data.result?.expires_in === 120 &&
      signedSmall.status >= 400 && signedBig.status >= 400,
      `3600→${signedTtl.data.result?.expires_in} · 120→${signedTtl2.data.result?.expires_in} · 30→${signedSmall.status} · 3601→${signedBig.status}`);
    const anonUpload = await rt(slugA, "UploadFile", { filename: "anon.txt", content_type: "text/plain", content_base64: b64("x") });
    h.check("7 on an RLS app an anonymous integration caller is refused by the existing gate",
      anonUpload.status === 401 && anonUpload.data.code === "AUTH_REQUIRED",
      `${anonUpload.status} ${anonUpload.data.code}`);

    // ------------------------------------------------ 8-11. Core.InvokeLLM (REAL provider)
    const llm = await rt(slugA, "InvokeLLM", { prompt: "Reply with exactly: parity-ok" }, userA.token);
    h.check("8 Core.InvokeLLM returns the upstream string shape through the real deployed chain",
      llm.status === 200 && typeof llm.data.result === "string" && llm.data.result.length > 0,
      `${llm.status} · ${typeof llm.data.result} (${String(llm.data.result).slice(0, 40)})`);
    const llmJson = await rt(slugA, "InvokeLLM", { prompt: "Return a JSON object {\"ok\": true}", response_json_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }, userA.token);
    h.check("9 Core.InvokeLLM with response_json_schema returns an object",
      llmJson.status === 200 && typeof llmJson.data.result === "object" && llmJson.data.result !== null && llmJson.data.result.ok !== undefined,
      `${llmJson.status} · ${JSON.stringify(llmJson.data.result ?? null).slice(0, 60)}`);
    // The documented InvokeLLM parameters now ride the EXISTING certified paths. `model`
    // honors the router's preferred-model slot: capture the honored-model AIOperation delta
    // around the call so the assertion is about THIS call, not the automatic router's choice.
    const opsHonoredBefore = (await svc.entities.AIOperation.filter({ workspace_id: ws.id, model_id: "gemini-3-flash" }, "-created_date", 50)).length;
    const llmModel = await rt(slugA, "InvokeLLM", { prompt: "Reply with exactly: model-ok", model: "gemini-3-flash" }, userA.token);
    const opsHonoredAfter = (await svc.entities.AIOperation.filter({ workspace_id: ws.id, model_id: "gemini-3-flash" }, "-created_date", 50)).length;
    const llmUnknown = await rt(slugA, "InvokeLLM", { prompt: "Reply with exactly: fallback-ok", model: "not-a-real-model" }, userA.token);
    const llmEmpty = await rt(slugA, "InvokeLLM", {}, userA.token);
    h.check("10 the documented `model` parameter is accepted, HONORED through the existing router, an unknown preference falls back gracefully, and the empty-prompt contract still validates",
      llmModel.status === 200 && typeof llmModel.data.result === "string" &&
      opsHonoredAfter > opsHonoredBefore &&
      llmUnknown.status === 200 && typeof llmUnknown.data.result === "string" &&
      llmEmpty.status === 400 && llmEmpty.data.code === "PRIMITIVE_INPUT_INVALID",
      `honored Δ${opsHonoredAfter - opsHonoredBefore} · unknown fallback ${llmUnknown.status} · empty ${llmEmpty.status}`);

    // file_urls: the shared reference-image contract (http(s) only, de-duplicated, capped)
    // accepts the call, and routing lands on a VISION-capable model through the existing gateway.
    const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const imgRef = await rt(slugA, "UploadFile", { filename: "ref.png", content_type: "image/png", content_base64: pngB64 }, userA.token);
    const refUrl = imgRef.data?.result?.file_url;
    const opVisionBefore = (await svc.entities.AIOperation.filter({ workspace_id: ws.id }, "-created_date", 1))[0]?.id || null;
    const llmFile = refUrl ? await rt(slugA, "InvokeLLM", { prompt: "Reply with exactly: vision-ok", file_urls: [refUrl, "not-a-url"] }, userA.token) : { status: 0, data: {} };
    const newestOp = (await svc.entities.AIOperation.filter({ workspace_id: ws.id }, "-created_date", 1))[0] || null;
    const servedVision = newestOp && newestOp.id !== opVisionBefore
      ? (() => { try { return !!getModel(newestOp.model_id).supports_vision; } catch { return false; } })()
      : false;
    h.check("10b `file_urls` are accepted, normalized to http(s) entries, and the call routes to a VISION-capable model through the existing gateway",
      llmFile.status === 200 && typeof llmFile.data.result === "string" && servedVision,
      `status ${llmFile.status} · model ${newestOp?.model_id || "n/a"} · vision ${servedVision}`);

    // add_context_from_internet: only a web_search-capable catalog model may serve it, the
    // refusal happens BEFORE any search, and the configured path stays fail-closed without a key.
    const llmWebBad = await rt(slugA, "InvokeLLM", { prompt: "hi", model: "gpt-5-mini", add_context_from_internet: true }, userA.token);
    h.check("10c add_context_from_internet with a model lacking the web_search capability fails deterministically BEFORE any search",
      llmWebBad.status === 400 && llmWebBad.data.code === "INTEGRATION_INCOMPATIBLE_MODEL",
      `${llmWebBad.status} ${llmWebBad.data.code}`);
    const wsConfigured = isWebSearchConfigured();
    const llmWeb = await rt(slugA, "InvokeLLM", { prompt: "Reply with exactly: web-ok", add_context_from_internet: true }, userA.token);
    h.check("10d the web-context path stays fail-closed without a provider key and succeeds with one configured",
      wsConfigured ? (llmWeb.status === 200 && typeof llmWeb.data.result === "string") : (llmWeb.status === 503 && llmWeb.data.code === "WEB_SEARCH_NOT_CONFIGURED"),
      wsConfigured ? "provider key configured → real search" : `${llmWeb.status} ${llmWeb.data.code}`);
    const stubSearch = await runWebSearch({
      query: "base44 invoke llm",
      keyProvider: async () => "test-key",
      fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ title: "Base44 docs", url: "https://docs.base44.com", content: "Base44 docs explain integrations" }] }) }),
    });
    const block = webContextBlock(stubSearch.ok ? stubSearch.results : []);
    h.check("10e with a configured (stubbed) provider the bounded search succeeds and the context block is built deterministically",
      stubSearch.ok && stubSearch.provider === WEB_SEARCH_PROVIDER && block.includes("### Web search context") && block.includes("Base44 docs"),
      `ok ${stubSearch.ok} · provider ${stubSearch.provider} · block ${block.length} chars`);

    // ------------------------------------------------ 12. Core.GenerateImage (REAL provider)
    const beforeImg = await intBal();
    const img = await rt(slugA, "GenerateImage", { prompt: "A simple flat blue circle on white background" }, userA.token);
    const afterImg = await intBal();
    h.check("11 Core.GenerateImage returns the upstream { url } shape and charges the published rate",
      img.status === 200 && typeof img.data.result?.url === "string" && img.data.result.url.length > 0 && beforeImg - afterImg === 1,
      `status ${img.status} · Δcredits ${beforeImg - afterImg}`);

    // ------------------------------------------------ 13-15. Core.ExtractDataFromUploadedFile
    // The platform extractor supports csv/xlsx/json/html/images/pdf — text/plain is refused by
    // the platform itself, so the extraction checks run against a supported JSON upload.
    // The platform extractor's OWN contract: the schema must declare
    // properties (or items), and a JSON payload must contain an array property of objects.
    const EXTRACT_SCHEMA = { type: "object", properties: { items: { type: "array", items: { type: "object" } } } };
    const jsonUp = await rt(slugA, "UploadFile", { filename: "parity.json", content_type: "application/json", content_base64: b64(JSON.stringify({ items: [{ name: "Ada Lovelace", role: "engineer" }, { name: "Grace Hopper", role: "engineer" }] })) }, userA.token);
    const jsonUrl = jsonUp.data.result?.file_url;
    const extract = await rt(slugA, "ExtractDataFromUploadedFile", { file_url: jsonUrl, json_schema: EXTRACT_SCHEMA }, userA.token);
    h.check("12 ExtractDataFromUploadedFile returns the DOCUMENTED SUCCESS ENVELOPE for an object schema",
      extract.status === 200 && extract.data.result?.status === "success" && extract.data.result?.details === null &&
      typeof extract.data.result?.output === "object" && !Array.isArray(extract.data.result?.output) && Array.isArray(extract.data.result?.output?.items),
      `${extract.status} · ${JSON.stringify(extract.data?.result ?? null).slice(0, 140)}`);
    // DOCUMENTED + LIVE-VERIFIED (Base44 platform, 2026-10-03): a root-array schema extracts a
    // BARE LIST (not an { items } object); a supported file whose columns cannot satisfy the
    // schema returns the ERROR ENVELOPE as a normal response; an unsupported file type THROWS.
    const ARR_SCHEMA = { type: "array", items: { type: "object", properties: { title: { type: "string" }, total: { type: "number" } }, required: ["title", "total"] } };
    const csvUp = await rt(slugA, "UploadFile", { filename: "parity.csv", content_type: "text/csv", content_base64: b64("title,total\nInvoice A,42\nInvoice B,58\n") }, userA.token);
    const listExtract = await rt(slugA, "ExtractDataFromUploadedFile", { file_url: csvUp.data.result?.file_url, json_schema: ARR_SCHEMA }, userA.token);
    h.check("12a array-schema extraction returns the documented BARE-LIST output form",
      listExtract.status === 200 && listExtract.data.result?.status === "success" && listExtract.data.result?.details === null &&
      Array.isArray(listExtract.data.result?.output) && listExtract.data.result.output.length === 2 &&
      listExtract.data.result.output[0]?.title === "Invoice A",
      `${listExtract.status} · ${JSON.stringify(listExtract.data?.result ?? null).slice(0, 140)}`);
    // LIVE-VERIFIED probe (2026-10-03): the extractor DETERMINISTICALLY refuses a schema that
    // requires fields no column can map (e.g. name/age/email/city against title/total) with
    // "Could not map N required field(s): …" → the documented error envelope. A merely
    // RENAMED pair of columns is NOT a refusal: the platform coerces it and returns success —
    // so the fixture must be unmappable, not mismatched.
    const MISMATCH_SCHEMA = { type: "array", items: { type: "object", properties: { name: { type: "string" }, age: { type: "number" }, email: { type: "string" }, city: { type: "string" } }, required: ["name", "age", "email", "city"] } };
    const mismatchExtract = await rt(slugA, "ExtractDataFromUploadedFile", { file_url: csvUp.data.result?.file_url, json_schema: MISMATCH_SCHEMA }, userA.token);
    h.check("12b an extraction that runs but yields nothing returns the documented ERROR ENVELOPE",
      mismatchExtract.status === 200 && mismatchExtract.data.result?.status === "error" &&
      typeof mismatchExtract.data.result?.details === "string" && mismatchExtract.data.result.output === null,
      `${mismatchExtract.status} · ${JSON.stringify(mismatchExtract.data?.result ?? null).slice(0, 140)}`);
    const txtUp = await rt(slugA, "UploadFile", { filename: "parity-notes.txt", content_type: "text/plain", content_base64: b64("plain notes, not a table") }, userA.token);
    const unsupportedExtract = await rt(slugA, "ExtractDataFromUploadedFile", { file_url: txtUp.data.result?.file_url, json_schema: ARR_SCHEMA }, userA.token);
    h.check("12c unsupported file type stays a fail-closed HTTP refusal (Base44-verified: the platform throws)",
      unsupportedExtract.status >= 400 && /unsupported/i.test(String(unsupportedExtract.data?.error || unsupportedExtract.data?.message || unsupportedExtract.data?.code || "")),
      `${unsupportedExtract.status} · ${unsupportedExtract.data?.code || unsupportedExtract.data?.error || unsupportedExtract.data?.message || ""}`);
    const foreignExtract = await rt(slugB, "ExtractDataFromUploadedFile", { file_url: publicUrl, json_schema: { type: "object" } }, userB.token);
    const noSchemaExtract = await rt(slugA, "ExtractDataFromUploadedFile", { file_url: publicUrl }, userA.token);
    h.check("13 a foreign file_url fails closed and a missing json_schema is refused",
      foreignExtract.status === 404 && foreignExtract.data.code === "FILE_NOT_FOUND" &&
      noSchemaExtract.status === 400 && noSchemaExtract.data.code === "INTEGRATION_PARAM_REQUIRED",
      `cross-project → ${foreignExtract.status} ${foreignExtract.data.code} · no schema → ${noSchemaExtract.status}`);

    // ------------------------------------------------ 16-17. Core.SendEmail
    // DOCUMENTED (Base44) upstream contract: { to, subject, body? | html?, text?, from_name?,
    // attachments? } — `body` and `html` are one HTML body under two names; `text` alongside
    // body/html rides as the multipart/alternative plain-text part; on its own, `text` sends a
    // plain-text email; `attachments` — at most 5, ≤5 MB each / ≤10 MB total, documents and
    // images only, as [{filename, file_url}] for a file THIS app uploaded or [{filename,
    // content}] base64. Deployed-side validation/regression rides the real runtime HTTP surface
    // (the platform CAPTURES verification sends, never delivering); every NEW-parameter send is
    // exercised through the SAME handler the runtime dispatches to with the TEST transport
    // (custom.call pattern), so no real email is ever composed for delivery.
    const badEmail = await rt(slugA, "SendEmail", { to: "not-an-email", subject: "x", body: "y" }, userA.token);
    h.check("14 Core.SendEmail forwards the upstream params into the existing validator",
      badEmail.status === 400 && badEmail.data.code === "EMAIL_INVALID_RECIPIENT",
      `${badEmail.status} ${badEmail.data.code}`);
    const beforeEmail = await intBal();
    const email = await rt(slugA, "SendEmail", { to: `parity-${stamp}@example.com`, subject: "Parity", body: "hello", from_name: "Parity Sender" }, userA.token);
    const afterEmail = await intBal();
    h.check("15 to/subject/from_name regression: unchanged result shape, charged per delivery",
      email.status === 200 && email.data.result?.kind === "email" && email.data.result.recipients === 1 &&
      Array.isArray(email.data.result.results) && typeof email.data.result.results[0]?.to === "string" &&
      beforeEmail - afterEmail === Number(email.data.result.delivered) &&
      !JSON.stringify(email.data.result).toLowerCase().includes("secret"),
      `delivered ${email.data.result?.delivered} · Δcredits ${beforeEmail - afterEmail}`);

    const testEmail = (args) =>
      handleAppIntegrations(svc, { project: projectA, integrations: [], user, op: "SendEmail", args, transport: "test" })
        .then((r) => ({ ok: true, result: r }))
        .catch((e) => ({ ok: false, status: e.status || 0, code: e.code || null, message: String(e?.message || e).slice(0, 160) }));
    const textOnly = await testEmail({ to: `t-${stamp}@example.com`, subject: "Plain", text: "plain body" });
    const textAudit = textOnly.ok ? await svc.entities.AppRecord.get(textOnly.result.id).catch(() => null) : null;
    h.check("16 text-only send: the plain-text body passes validation, no html invented",
      textOnly.ok && textOnly.result?.transport === "test" && textOnly.result?.delivered === 0 &&
      textAudit && (textAudit.data || {}).has_html === false,
      textOnly.ok ? `transport ${textOnly.result.transport} · has_html ${(textAudit.data || {}).has_html}` : `${textOnly.status} ${textOnly.code} ${textOnly.message}`);
    const htmlOnly = await testEmail({ to: `h-${stamp}@example.com`, subject: "Html", html: "<b>bold</b>" });
    const htmlAudit = htmlOnly.ok ? await svc.entities.AppRecord.get(htmlOnly.result.id).catch(() => null) : null;
    h.check("17 html-only send: the html body passes validation and is audited as html",
      htmlOnly.ok && htmlOnly.result?.transport === "test" && htmlOnly.result?.delivered === 0 &&
      htmlAudit && (htmlAudit.data || {}).has_html === true,
      htmlOnly.ok ? `transport ${htmlOnly.result.transport} · has_html ${(htmlAudit.data || {}).has_html}` : `${htmlOnly.status} ${htmlOnly.code} ${htmlOnly.message}`);
    const multipart = await testEmail({ to: `m-${stamp}@example.com`, subject: "Multi", html: "<b>bold</b>", text: "bold" });
    h.check("17a html + text together: both ride the multipart path through the messaging primitive",
      multipart.ok && multipart.result?.transport === "test" && multipart.result?.delivered === 0,
      multipart.ok ? `transport ${multipart.result.transport} · delivered ${multipart.result.delivered}` : `${multipart.status} ${multipart.code} ${multipart.message}`);
    const attachSend = await testEmail({
      to: `a-${stamp}@example.com`, subject: "Att", html: "<p>report</p>",
      attachments: [{ filename: "note.txt", content: b64("attached bytes") }, { filename: "pub.txt", file_url: publicUrl }],
    });
    const attachAudit = attachSend.ok ? await svc.entities.AppRecord.get(attachSend.result.id).catch(() => null) : null;
    h.check("17b attachments: base64 content + this app's uploaded file validate and are audited by count only",
      attachSend.ok && attachSend.result?.transport === "test" &&
      attachAudit && (attachAudit.data || {}).attachment_count === 2 &&
      !JSON.stringify(attachAudit.data || {}).includes("attached bytes") && !JSON.stringify(attachAudit.data || {}).includes("file_url"),
      attachSend.ok ? `attachment_count ${(attachAudit.data || {}).attachment_count}` : `${attachSend.status} ${attachSend.code} ${attachSend.message}`);
    const tooMany = await testEmail({ to: `x1-${stamp}@example.com`, subject: "s", text: "b", attachments: Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.txt`, content: b64("x") })) });
    const badExt = await testEmail({ to: `x2-${stamp}@example.com`, subject: "s", text: "b", attachments: [{ filename: "virus.exe", content: b64("x") }] });
    const traversal = await testEmail({ to: `x3-${stamp}@example.com`, subject: "s", text: "b", attachments: [{ filename: "../a.txt", content: b64("x") }] });
    const foreignAtt = await testEmail({ to: `x4-${stamp}@example.com`, subject: "s", text: "b", attachments: [{ filename: "e.pdf", file_url: "https://attacker.example/e.pdf" }] });
    const bothSources = await testEmail({ to: `x5-${stamp}@example.com`, subject: "s", text: "b", attachments: [{ filename: "a.txt", content: b64("x"), file_url: publicUrl }] });
    const badB64 = await testEmail({ to: `x6-${stamp}@example.com`, subject: "s", text: "b", attachments: [{ filename: "a.txt", content: "!!!not base64!!!" }] });
    const noBody = await testEmail({ to: `x7-${stamp}@example.com`, subject: "s" });
    h.check("17c attachment + body validation fails closed (count, extension, traversal, foreign file, double source, bad base64, no body)",
      tooMany.code === "EMAIL_TOO_MANY_ATTACHMENTS" && badExt.code === "EMAIL_ATTACHMENT_TYPE_REJECTED" &&
      traversal.code === "EMAIL_ATTACHMENT_TYPE_REJECTED" && foreignAtt.code === "EMAIL_ATTACHMENT_FOREIGN_FILE" &&
      bothSources.code === "EMAIL_ATTACHMENT_INVALID" && badB64.code === "EMAIL_ATTACHMENT_INVALID" &&
      noBody.status === 400 && noBody.code === "EMAIL_NO_BODY",
      `many ${tooMany.code} · ext ${badExt.code} · path ${traversal.code} · foreign ${foreignAtt.code} · both ${bothSources.code} · b64 ${badB64.code} · body ${noBody.code}`);

    // ------------------------------------------------ 18-24. custom.call
    // The engine executes in the INVOKED process — the deployed runtime and the preview each run
    // in their own invocation, where a process-local fetch stub can never apply. The scripted
    // upstream boundary (integrationEngineTest pattern) is therefore certified IN-PROCESS through
    // the SAME handler the runtime dispatches to; the deployed runtime's dispatch/refusal paths
    // stay certified through rt below (checks 20 and 22).
    const localCall = async (args, user = null) => {
      try {
        const r = await handleAppIntegrations(svc, { project: projectA, integrations: [CRM_DOC], user, op: "custom_call", args, transport: "platform" });
        return { status: 200, result: r };
      } catch (e) {
        return { status: e.status || 500, code: e.code || null, result: null, error: e.message };
      }
    };
    const c1 = await localCall({ slug: "crm", operation_id: "getContacts", params: { queryParams: { limit: 10 } } }, userA.user);
    const c1Call = upstreamCalls[upstreamCalls.length - 1];
    h.check("16 custom.call executes through the existing engine and returns the upstream shape",
      c1.status === 200 && c1.result?.success === true && c1.result?.status_code === 200 &&
      Array.isArray(c1.result?.data?.contacts) &&
      (String(c1Call?.url).includes("limit=10") || Number(c1Call?.query?.limit) === 10),
      `status_code ${c1.result?.status_code} · forwarded query=${c1Call?.query?.limit ?? "in URL"}`);
    const c2 = await localCall({ slug: "crm", operation_id: "get:/contacts", params: { queryParams: { limit: 5 } } }, userA.user);
    h.check("17 the upstream method:path operationId form resolves the SAME registry entry",
      c2.status === 200 && c2.result?.success === true && c2.result?.status_code === 200,
      `get:/contacts → ${c2.status}`);
    const c3 = await localCall({ slug: "crm", operation_id: "createUser", params: { pathParams: { id: "42" }, payload: { name: "Ada" } } }, userA.user);
    const c3Call = upstreamCalls[upstreamCalls.length - 1];
    h.check("18 pathParams and payload are forwarded to the upstream URL and body",
      c3.status === 200 && c3.result?.success === true && String(c3Call?.url).includes("/users/42") &&
      String(c3Call?.body || "").includes("Ada") && c3.result?.data?.created === true,
      `${c3Call?.url} · body ${String(c3Call?.body || "").slice(0, 40)}`);
    const c4 = await localCall({ slug: "crm", operation_id: "getMissing" }, userA.user);
    h.check("19 a non-2xx upstream answer maps onto { success:false, status_code, data }",
      c4.status === 200 && c4.result?.success === false && c4.result?.status_code === 404 &&
      typeof c4.result?.data === "string" && c4.result.data.includes("not found"),
      `status_code ${c4.result?.status_code} · data ${JSON.stringify(c4.result?.data).slice(0, 80)}`);
    const noSlug = await rt(slugA, "custom_call", { slug: "", operation_id: "getContacts" }, userA.token);
    const noInteg = await rt(slugA, "custom_call", { slug: "absent", operation_id: "getContacts" }, userA.token);
    const noOp = await rt(slugA, "custom_call", { slug: "crm", operation_id: "nopeOp" }, userA.token);
    h.check("20 unknown slug / operation are 404 and missing arguments are 400",
      noSlug.status === 400 && noSlug.data.code === "INTEGRATION_PARAM_REQUIRED" &&
      noInteg.status === 404 && noInteg.data.code === "INTEGRATION_NOT_FOUND" &&
      noOp.status === 404 && noOp.data.code === "OPERATION_NOT_FOUND",
      `${noSlug.status} / ${noInteg.status} ${noInteg.data.code} / ${noOp.status} ${noOp.data.code}`);
    const hitsBefore = upstreamCalls.length;
    const c5 = await localCall({ slug: "crm", operation_id: "getContacts" }, userA.user);
    h.check("21 a repeated custom.call performs a second upstream call (no invented idempotency)",
      c5.status === 200 && upstreamCalls.length === hitsBefore + 1,
      `upstream hits ${upstreamCalls.length - hitsBefore}`);
    const bCall = await rt(slugB, "custom_call", { slug: "crm", operation_id: "getContacts" }, userB.token);
    h.check("22 custom.call is project-isolated: an integration another project never declared is 404",
      bCall.status === 404 && bCall.data.code === "INTEGRATION_NOT_FOUND",
      `${bCall.status} ${bCall.data.code}`);

    // ------------------------------------------------ 23-25. runtime-level fail-closed
    const unknownOp = await rt(slugA, "DefinitelyNotAnOp", {}, userA.token);
    const brokeUpload = await rt(slugC, "UploadFile", { filename: "broke.txt", content_type: "text/plain", content_base64: b64("x") }, userC.token);
    const brokeBal = (await poolBalance(svc, brokeWs.id, "integration")).balance;
    h.check("23 unknown operations are refused, and a workspace without credits is refused fail-closed before storage",
      unknownOp.status === 400 &&
      brokeUpload.status >= 400 && brokeUpload.data.code === "INSUFFICIENT_CREDITS" && brokeBal === 0,
      `unknown op → ${unknownOp.status} · broke ws → ${brokeUpload.status} ${brokeUpload.data.code} · balance ${brokeBal}`);

    // ------------------------------------------------ 26-30. builder-preview surface
    const pvUp = await pv({ project_id: projectA.id, scope: "files", op: "upload", args: { filename: "pv.txt", content_type: "text/plain", content_base64: b64("preview round-trip") }, session_token: userA.token });
    const pvAccess = pvUp.data?.result?.id
      ? await pv({ project_id: projectA.id, scope: "files", op: "access", args: { id: pvUp.data.result.id }, session_token: userA.token })
      : { status: 0, data: {} };
    h.check("24 the preview forwards files operations: upload → access round-trip works in the builder preview and keeps the standard 300s TTL",
      pvUp.status === 200 && !!pvUp.data?.result?.id && pvAccess.status === 200 && typeof pvAccess.data?.result?.url === "string" &&
      pvAccess.data?.result?.expires_in === 300 &&
      !JSON.stringify(pvUp.data.result).includes("file_uri"),
      `upload ${pvUp.status} → access ${pvAccess.status} · expires_in ${pvAccess.data?.result?.expires_in}`);
    const pvAnon = await pv({ project_id: projectA.id, scope: "files", op: "upload", args: { filename: "anon.txt", content_type: "text/plain", content_base64: b64("x") } });
    const pvBadFilesOp = await pv({ project_id: projectA.id, scope: "files", op: "read", args: {} });
    h.check("25 the preview files scope keeps the deployed RLS gate and refuses unknown ops",
      pvAnon.status === 401 && pvAnon.data.code === "AUTH_REQUIRED" && pvBadFilesOp.status === 400,
      `anonymous → ${pvAnon.status} ${pvAnon.data.code} · bad op → ${pvBadFilesOp.status}`);
    // The preview executes in its own invocation too, so its scripted-upstream success shape is
    // certified in-process above; here the preview proves it loads the project's WORKING
    // integration registry at all (an unknown operation resolves against it and is refused).
    const pvCustom = await pv({ project_id: projectA.id, scope: "integrations", op: "custom_call", args: { slug: "crm", operation_id: "nopeOp" }, session_token: userA.token });
    h.check("26 the preview loads the project's WORKING integration registry (unknown operation → 404)",
      pvCustom.status === 404 && pvCustom.data?.code === "OPERATION_NOT_FOUND",
      `${pvCustom.status} ${pvCustom.data?.code}`);
    const pvUpload = await pv({ project_id: projectA.id, scope: "integrations", op: "UploadFile", args: { filename: "pv-pub.txt", content_type: "text/plain", content_base64: b64("public from preview") }, session_token: userA.token });
    h.check("27 the preview Core.UploadFile returns the upstream { file_url } shape",
      pvUpload.status === 200 && typeof pvUpload.data?.result?.file_url === "string",
      `${pvUpload.status}`);
    const pvEmailBefore = await intBal();
    const pvEmail = await pv({ project_id: projectA.id, scope: "integrations", op: "SendEmail", args: { to: `pv-${stamp}@example.com`, subject: "Preview", body: "hello" }, session_token: userA.token });
    const pvEmailAfter = await intBal();
    h.check("28 the preview SendEmail rides the test transport: delivers nothing, charges nothing",
      pvEmail.status === 200 && pvEmail.data?.result?.transport === "test" && pvEmail.data?.result?.delivered === 0 &&
      pvEmailAfter === pvEmailBefore,
      `transport ${pvEmail.data?.result?.transport} · Δcredits ${pvEmailAfter - pvEmailBefore}`);
    const pvRichBefore = await intBal();
    const pvRich = await pv({ project_id: projectA.id, scope: "integrations", op: "SendEmail", args: { to: `pvr-${stamp}@example.com`, subject: "Preview rich", html: "<b>hi</b>", text: "hi", from_name: "Preview Sender", attachments: [{ filename: "pub.txt", file_url: pvUpload.data?.result?.file_url }] }, session_token: userA.token });
    const pvRichAfter = await intBal();
    h.check("28a the preview maps html/text/attachments identically: test transport, no delivery, no charge",
      pvRich.status === 200 && pvRich.data?.result?.transport === "test" && pvRich.data?.result?.delivered === 0 &&
      pvRichAfter === pvRichBefore,
      `transport ${pvRich.data?.result?.transport} · Δcredits ${pvRichAfter - pvRichBefore}`);
    const pvLlmModel = await pv({ project_id: projectA.id, scope: "integrations", op: "InvokeLLM", args: { prompt: "Reply with exactly: preview-model-ok", model: "gemini-3-flash" }, session_token: userA.token });
    const pvImg = await pv({ project_id: projectA.id, scope: "integrations", op: "GenerateImage", args: { prompt: "ab" }, session_token: userA.token });
    const pvExtract = await pv({ project_id: projectA.id, scope: "integrations", op: "ExtractDataFromUploadedFile", args: { file_url: "https://foreign.example.com/x" }, session_token: userA.token });
    const pvUnknown = await pv({ project_id: projectA.id, scope: "integrations", op: "DefinitelyNotAnOp" });
    h.check("29 every Core operation reaches the SAME preview dispatch: the accepted `model` parameter and the fail-closed paths",
      pvLlmModel.status === 200 && typeof pvLlmModel.data?.result === "string" &&
      pvImg.status === 400 && pvImg.data.code === "PRIMITIVE_INPUT_INVALID" &&
      pvExtract.status === 400 && pvExtract.data.code === "INTEGRATION_PARAM_REQUIRED" &&
      pvUnknown.status === 400,
      `llm ${pvLlmModel.status} · image ${pvImg.status} · extract ${pvExtract.status} · unknown ${pvUnknown.status}`);
    const pvCsvUp = await pv({ project_id: projectA.id, scope: "integrations", op: "UploadFile", args: { filename: "pv-parity.csv", content_type: "text/csv", content_base64: b64("title,total\nPV A,7\n") }, session_token: userA.token });
    const pvListExtract = await pv({ project_id: projectA.id, scope: "integrations", op: "ExtractDataFromUploadedFile", args: { file_url: pvCsvUp.data?.result?.file_url, json_schema: ARR_SCHEMA }, session_token: userA.token });
    h.check("29a the preview receives the SAME response envelope: success list form",
      pvListExtract.status === 200 && pvListExtract.data?.result?.status === "success" && pvListExtract.data?.result?.details === null &&
      Array.isArray(pvListExtract.data?.result?.output) && pvListExtract.data.result.output.length === 1,
      `${pvListExtract.status} · ${JSON.stringify(pvListExtract.data?.result ?? null).slice(0, 140)}`);
    const pvPrivate = await pv({ project_id: projectA.id, scope: "integrations", op: "UploadPrivateFile", args: { filename: "pv-priv.txt", content_type: "text/plain", content_base64: b64("pv private") }, session_token: userA.token });
    const pvSigned = pvPrivate.data?.result?.id
      ? await pv({ project_id: projectA.id, scope: "integrations", op: "CreateFileSignedUrl", args: { file_uri: pvPrivate.data.result.id }, session_token: userA.token })
      : { status: 0, data: {} };
    h.check("30 the preview private upload + signed URL pair behaves like the deployed surface",
      pvPrivate.status === 200 && !!pvPrivate.data?.result?.id && !JSON.stringify(pvPrivate.data.result).includes("file_uri") &&
      pvSigned.status === 200 && typeof pvSigned.data?.result?.signed_url === "string" && pvSigned.data?.result?.expires_in === 300,
      `upload ${pvPrivate.status} · signed ${pvSigned.status}`);
    const pvSignedTtl = pvPrivate.data?.result?.id
      ? await pv({ project_id: projectA.id, scope: "integrations", op: "CreateFileSignedUrl", args: { file_uri: pvPrivate.data.result.id, expires_in: 3600 }, session_token: userA.token })
      : { status: 0, data: {} };
    h.check("30a the preview forwards the documented expires_in: the custom TTL is echoed, like the deployed surface",
      pvSignedTtl.status === 200 && pvSignedTtl.data?.result?.expires_in === 3600 && typeof pvSignedTtl.data?.result?.signed_url === "string",
      `expires_in ${pvSignedTtl.data?.result?.expires_in}`);

    // ------------------------------------------------ 31. ledger + pool integrity
    const msgEnd = await msgBal();
    h.check("31 no integration operation ever touched the message pool, and no browser-visible result carried a credential",
      msgEnd === msgStart &&
      [priv, signed, c1, pvUp].every((r) => !JSON.stringify(r.data ?? r.result ?? {}).toLowerCase().includes("secret")),
      `message pool Δ0 · scrubbed responses`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    globalThis.fetch = realFetch;
    for (const pid of created.projects) {
      for (const entity of ["Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile", "FunctionInvocation", "PrimitiveInvocation", "IntegrationInvocation", "AIOperation", "ScheduledTrigger"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]);
    }
    for (const id of created.plans) await svc.entities.BillingPlan.delete(id).catch(() => {});
  }
}
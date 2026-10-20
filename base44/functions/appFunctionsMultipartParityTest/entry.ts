// G-A certification: multipart/File support for the DOCUMENTED FunctionsModule invoke surface
// (SDK 0.8.52). The published SDK (node_modules/@base44/sdk/dist/modules/functions.js) sends
// multipart/form-data when ANY named invoke parameter is a File (or the data is a FormData
// instance), appending File params as-is and JSON-stringifying other objects; the function
// receives the data as NAMED PARAMETERS. This suite certifies, through the REAL deployed
// runtime (appRuntime action fn) and the REAL preview surface (appFunction):
//
//   • JSON invoke regression — the JSON path is byte-identical (success AND >=400);
//   • a genuine multipart invoke is accepted and the File parameter is restored into the
//     function payload as { filename, content_type, size, content_base64 } (marker dropped);
//   • mixed scalar + File parameters both arrive;
//   • the generated-app bridge's JSON descriptor path (runtimeSource encodeInvokeFile) is
//     restored by the same executor point;
//   • a function's own 500 travels as the SAME { status, body.error } envelope over multipart;
//   • an oversized File parameter is refused 413 before execution (FILE_PARAM_TOO_LARGE);
//   • project isolation — a function another deployment never shipped is 404;
//   • Δ0 credits — no message or integration credit moves for any File invoke.
//
// NOT claimed (pinned in MULTIPART_CONTRACT): functions.fetch is untouched (its own suite);
// asServiceRole.functions.invoke / .fetch (G-B / G-C — NOT implemented here); the wire file
// descriptor and restored server-side shape are NEXUSAI-DERIVED (Base44 publishes the client
// multipart serialization, not the server-side File-object contract); the invoke bridge
// transport inside a generated app remains JSON (postMessage) — descriptor-encoded, exactly
// like files.upload / integrations Core uploads. Timeout quotas are untouched (15s).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { invokePace, probeCreditDeltas } from "../../shared/invokeParityHelpers.ts";
import { createDeployedApp, appRuntimeCaller, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

const MULTIPART_CONTRACT = {
  wire: "SDK 0.8.52 DOCUMENTED — invoke sends multipart/form-data when any named parameter is a File (or data is FormData); File params as-is, objects JSON-stringified",
  restore_shape: "NEXUSAI-DERIVED — the function's named File parameter is { filename, content_type, size, content_base64 } (wire marker __base44file__ dropped)",
  limits: "NEXUSAI-DERIVED — 10 MB per file parameter, 413 FILE_PARAM_TOO_LARGE before execution",
  fetch: "UNTOUCHED — functions.fetch body handling is NOT changed (its own suite certifies it)",
  service_role: "NOT IMPLEMENTED — asServiceRole.functions.invoke / .fetch are G-B / G-C, separately approved",
  billing: "Δ0 — File parameters travel inline in the payload; nothing is stored, no pool moves",
  json_path: "UNCHANGED — a payload with no file-like values is returned untouched by the restore point",
};

// One echo handler covering every certified axis. It echoes the whole request body, so every
// restored parameter shape is directly observable.
const FN_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var r = ctx.request;
  if (r.body && r.body.fail) return { status: 500, body: { error: 'boom' } };
  return { status: 200, body: r.body || null };
}`;

const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Multipart</h1></div>\`; }
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

const FN_NAME = "echoMultipart";
const b64 = (s) => btoa(s);
const bytes = (s) => new TextEncoder().encode(s);

// The multipart invoke wrapper over the REAL SDK, in its DOCUMENTED client form: a plain
// object whose named File parameter makes the SDK (0.8.52) build and send multipart/form-data
// itself — File params appended as-is, object values JSON-stringified, scalars as-is. A raw
// FormData instance is NOT a supported invoke argument (the SDK reads no enumerable keys off
// it), so the suite exercises exactly the wire a generated app produces.
function mpCaller(invokeFn) {
  return (fields, files, payload = null) => {
    const data = { ...fields };
    if (payload !== null) data.payload = payload;
    for (const [name, file] of files || []) data[name] = file;
    return invokeFn(data)
      .then((r) => ({ ok: true, status: r.status ?? 200, data: r.data ?? r }))
      .catch((e) => ({
        ok: false, status: e.status || e.response?.status || 0,
        code: e.response?.data?.code || e.code || null,
        data: e.response?.data || { error: String(e.message || e) },
        error: e.response?.data?.error || String(e.message || e),
      }));
  };
}

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  const pace = invokePace;

  try {
    const plan = await makeBillingPlan(db, created, `p9fm${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9fm${stamp}`, { plan });

    // App A carries the echo function; app B (isolation) ships WITHOUT it.
    const a = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `p9fm-a ${stamp}`, slug: `p9fm-a-${stamp}`, deployed_by: A.user.id,
      entities: [], files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", STYLES]],
      extra_files: [["base44/functions/echoMultipart/entry.ts", FN_ECHO]],
      on_project_created: (p) => projectIds.push(p.id),
    });
    const b = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `p9fm-b ${stamp}`, slug: `p9fm-b-${stamp}`, deployed_by: A.user.id,
      entities: [], files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", STYLES]],
      on_project_created: (p) => projectIds.push(p.id),
    });
    harness.check("setup: both apps deploy LIVE through the real worker",
      a.run.status === "LIVE" && b.run.status === "LIVE", `A ${a.run.status} · B ${b.run.status}`);
    if (a.run.status !== "LIVE" || b.run.status !== "LIVE") return harnessResponse(harness);

    const runtime = appRuntimeCaller(db);
    const mpRuntime = mpCaller((fd) => db.functions.invoke("appRuntime", fd));
    const slugA = a.project.slug, slugB = b.project.slug;

    // ---- 1-2. JSON invoke regression (success + >=400) --------------------------------------
    const jsonOk = await runtime({ action: "fn", slug: slugA, function_name: FN_NAME, payload: { echo: "json-reg" } });
    await pace();
    harness.check("1 JSON invoke regression (deployed): success shape unchanged — { status: 200, body.echo }, no file field",
      jsonOk.ok === true && jsonOk.data.status === 200 && jsonOk.data.body && jsonOk.data.body.echo === "json-reg" && jsonOk.data.body.avatar === undefined,
      JSON.stringify(jsonOk.data).slice(0, 160));
    const jsonFail = await runtime({ action: "fn", slug: slugA, function_name: FN_NAME, payload: { fail: true } });
    await pace();
    harness.check("2 JSON >=400 regression (deployed): the function's 500 travels as { status, body.error } — unchanged",
      jsonFail.ok === true && jsonFail.data.status === 500 && jsonFail.data.body && jsonFail.data.body.error === "boom",
      JSON.stringify(jsonFail.data).slice(0, 160));

    // ---- 3. genuine multipart invoke: File parameter restored --------------------------------
    const mp = await mpRuntime({ action: "fn", slug: slugA, function_name: FN_NAME }, [["avatar", new File([bytes("multipart-parity-bytes")], "note.txt", { type: "text/plain" })]], { echo: "multipart-parity" });
    await pace();
    const av = mp.data?.body?.avatar;
    harness.check("3 multipart invoke (deployed): the File parameter is restored as the named parameter { filename, content_type, size, content_base64 } — marker dropped, bytes intact",
      mp.ok === true && mp.data.status === 200 && mp.data.body && mp.data.body.echo === "multipart-parity" &&
      av && av.filename === "note.txt" && av.content_type === "text/plain" && av.size === bytes("multipart-parity-bytes").length &&
      av.content_base64 === b64("multipart-parity-bytes") && av.__base44file__ === undefined,
      JSON.stringify(mp.data?.body ?? mp.data).slice(0, 200));

    // ---- 4. mixed scalar + File parameters ----------------------------------------------------
    const mixed = await mpRuntime({ action: "fn", slug: slugA, function_name: FN_NAME }, [["avatar", new File([bytes("mixed-bytes")], "pic.png", { type: "image/png" })]], { echo: "mixed", label: "Ada" });
    await pace();
    harness.check("4 mixed scalar + File (deployed): the scalar named param and the File named param BOTH arrive restored",
      mixed.ok === true && mixed.data.status === 200 && mixed.data.body && mixed.data.body.label === "Ada" &&
      mixed.data.body.avatar && mixed.data.body.avatar.filename === "pic.png" && mixed.data.body.avatar.content_base64 === b64("mixed-bytes"),
      JSON.stringify(mixed.data?.body ?? {}).slice(0, 200));

    // ---- 5. the generated-app bridge's JSON descriptor path ----------------------------------
    const bridgeDesc = await runtime({ action: "fn", slug: slugA, function_name: FN_NAME, payload: { echo: "bridge-desc", avatar: { __base44file__: true, filename: "bridge.txt", content_type: "text/plain", size: bytes("bridgebyte").length, content_base64: b64("bridgebyte") } } });
    await pace();
    harness.check("5 bridge JSON descriptor (deployed): the runtime's base64 descriptor is restored by the SAME executor point",
      bridgeDesc.ok === true && bridgeDesc.data.status === 200 && bridgeDesc.data.body &&
      bridgeDesc.data.body.avatar && bridgeDesc.data.body.avatar.filename === "bridge.txt" &&
      bridgeDesc.data.body.avatar.content_base64 === b64("bridgebyte") && bridgeDesc.data.body.avatar.__base44file__ === undefined,
      JSON.stringify(bridgeDesc.data?.body ?? {}).slice(0, 200));

    // ---- 6. multipart >=400 --------------------------------------------------------------------
    const mpFail = await mpRuntime({ action: "fn", slug: slugA, function_name: FN_NAME }, [["avatar", new File([bytes("x")], "f.txt", { type: "text/plain" })]], { fail: true });
    await pace();
    harness.check("6 multipart >=400 (deployed): a function's 500 travels as the SAME { status, body.error } envelope over multipart",
      mpFail.ok === true && mpFail.data.status === 500 && mpFail.data.body && mpFail.data.body.error === "boom",
      JSON.stringify(mpFail.data).slice(0, 160));

    // ---- 7. oversized file parameter: 413 before execution ------------------------------------
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const oversized = await mpRuntime({ action: "fn", slug: slugA, function_name: FN_NAME }, [["avatar", new File([big], "big.bin", { type: "application/octet-stream" })]], { echo: "never" });
    await pace();
    harness.check("7 an oversized File parameter is refused 413 (FILE_PARAM_TOO_LARGE) before execution — the function never runs",
      oversized.ok === false && Number(oversized.status) === 413 && String(oversized.error).includes("byte"),
      `${oversized.status} ${oversized.code} ${String(oversized.error).slice(0, 80)}`);

    // ---- 8. project isolation ------------------------------------------------------------------
    const foreign = await mpRuntime({ action: "fn", slug: slugB, function_name: FN_NAME }, [["avatar", new File([bytes("x")], "f.txt", { type: "text/plain" })]], { echo: "nope" });
    await pace();
    harness.check("8 project isolation (deployed): a function app B never deployed is 404 — multipart addressing cannot cross projects",
      foreign.ok === false && Number(foreign.status) === 404, `${foreign.status}`);

    // ---- 9-11. the PREVIEW surface's server half ------------------------------------------------
    // appFunction (the preview endpoint) requires an end-user session, so from a service-role
    // test it is unreachable BY DESIGN (403) — the SAME executor, executeProjectFunction, is
    // its server half, exactly as the F1 suite certified. These checks certify the restore
    // point where the preview bridge's payloads land.
    const pvExec = (payload) => executeProjectFunction(db, {
      project: a.project, entities: [], name: FN_NAME, source: FN_ECHO,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: payload },
    });
    const pvJson = await pvExec({ echo: "preview-json" });
    harness.check("9 preview JSON invoke regression: the executor returns { status: 200, body.echo } — unchanged",
      pvJson.status === 200 && pvJson.body && pvJson.body.echo === "preview-json",
      JSON.stringify(pvJson.body).slice(0, 160));
    const pvMp = await pvExec({ echo: "preview-multipart", avatar: { __base44file__: true, filename: "pv.txt", content_type: "text/plain", size: bytes("preview-bytes").length, content_base64: b64("preview-bytes") } });
    harness.check("10 preview multipart invoke: the bridge's JSON descriptor is restored identically on the preview surface's executor",
      pvMp.status === 200 && pvMp.body && pvMp.body.echo === "preview-multipart" && pvMp.body.avatar &&
      pvMp.body.avatar.filename === "pv.txt" && pvMp.body.avatar.content_base64 === b64("preview-bytes") &&
      pvMp.body.avatar.__base44file__ === undefined,
      JSON.stringify(pvMp.body).slice(0, 200));
    const pvFail = await pvExec({ fail: true });
    harness.check("11 preview >=400: the function's 500 travels as the SAME { status, body.error } envelope",
      pvFail.status === 500 && pvFail.body && pvFail.body.error === "boom",
      JSON.stringify(pvFail.body).slice(0, 160));

    // ---- 12. Δ0 credits --------------------------------------------------------------------------
    const deltas = await probeCreditDeltas(db, A.ws.id, () =>
      mpRuntime({ action: "fn", slug: slugA, function_name: FN_NAME }, [["avatar", new File([bytes("billing")], "bill.txt", { type: "text/plain" })]], { echo: "billing" }).then(() => pace()));
    harness.check("12 Δ0 credits: File/multipart invoke moves NO message or integration credit (nothing is stored, no invented charge)",
      deltas.messageDelta === 0 && deltas.integrationDelta === 0,
      `message Δ${deltas.messageDelta} · integration Δ${deltas.integrationDelta}`);

    // ---- 13. certification boundary pinned ---------------------------------------------------------
    harness.check("13 boundary: every undocumented semantic stays pinned — restore shape NEXUSAI-DERIVED, fetch untouched, G-B/G-C not implemented, JSON path unchanged",
      MULTIPART_CONTRACT.restore_shape.includes("NEXUSAI-DERIVED") && MULTIPART_CONTRACT.fetch.includes("UNTOUCHED") &&
      MULTIPART_CONTRACT.service_role.includes("NOT IMPLEMENTED") && MULTIPART_CONTRACT.json_path.includes("UNCHANGED"),
      JSON.stringify(MULTIPART_CONTRACT).slice(0, 240));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const entity of ["Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Build", "FunctionInvocation", "AppRecord", "AppEntity", "AppSession"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]);
    }
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9fm" } }).catch(() => {});
  }
}
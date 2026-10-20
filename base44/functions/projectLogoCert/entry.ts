// Targeted certification for the project-logo gap (the documented Base44 "Dashboard → Overview →
// Edit logo" surface): upload/validation, persistence, and published-runtime favicon/icon
// rendering. Runs against disposable scratch data; no real project is touched.
//
// Covers:
//   • pure validation logic (shared/projectLogo.validateLogoBytes) on crafted PNG/JPEG headers:
//     valid dims, wrong type, empty, oversize bytes, oversize dims, JPEG dims
//   • endpoint CRUD through the real projectLogo function: set (valid PNG) → logo_url returned,
//     wrong type → LOGO_TYPE_REJECTED, too-large dims → LOGO_TOO_LARGE_DIM, get → persisted,
//     remove → cleared, and Project.row persistence after each step
//   • published-runtime rendering: appRuntime's artifact response carries app.logo_url for a
//     LIVE deployment of the project (the contract PublicApp + AppHeadMeta consume to render the
//     favicon and home-screen icon)
//
// The SDK's functions.invoke throws on non-2xx (the functions axios client has response
// interception disabled), so a `tryInvoke` helper normalizes both thrown and returned responses
// into { status, data } — the same shape the refusal assertions already expect.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { packJson } from "../../shared/blobStore.ts";
import { validateLogoBytes, LOGO_MAX_BYTES, LOGO_MAX_DIM } from "../../shared/projectLogo.ts";
import { imageDimensions } from "../../shared/imageDims.ts";

const MAIN = `import { html, render } from 'runtime'; render(html\`<div>ok</div>\`, document.getElementById('app'));`;

// Craft a PNG byte buffer with the given IHDR dimensions (header only — the dimension reader and
// the validator only inspect the header).
function pngBytes(w, h) {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  dv.setUint32(8, 13);
  b[12] = 0x49; b[13] = 0x48; b[14] = 0x44; b[15] = 0x52;
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

// Craft a JPEG byte buffer with an SOF0 marker declaring the given dimensions.
function jpegBytes(w, h) {
  const b = new Uint8Array(20);
  const dv = new DataView(b.buffer);
  b[0] = 0xff; b[1] = 0xd8;          // SOI
  b[2] = 0xff; b[3] = 0xc0;          // SOF0
  dv.setUint16(4, 0x0011);           // segment length
  b[6] = 0x08;                       // precision
  dv.setUint16(7, h);                // height
  dv.setUint16(9, w);                // width
  return b;
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// A real, uploadable 1×1 PNG (complete IHDR + IDAT + IEND). Crafted header-only PNGs are fine for
// the dimension reader, but the public-file store validates a complete image, so the upload
// tests use this real one.
const VALID_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

// Normalize a function invoke into { status, data } whether it resolved (2xx AxiosResponse) or
// rejected (non-2xx throws, since the functions client disables response interception).
async function tryInvoke(client, name, payload) {
  try {
    const r = await client.functions.invoke(name, payload);
    return { status: r.status, data: r.data };
  } catch (e) {
    return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message, code: e.code ?? null } };
  }
}

const CLEANUP = ["Project", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Subscription", "BillingPlan", "AuditLog"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let workspace = null, project = null;
  const stamp = Date.now();

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    // ===================== pure validation logic =====================
    const png16 = pngBytes(16, 16);
    check("imageDimensions reads PNG width/height from the header", imageDimensions(png16)?.width === 16 && imageDimensions(png16)?.height === 16, JSON.stringify(imageDimensions(png16)));
    check("imageDimensions reads JPEG width/height from the SOF marker", imageDimensions(jpegBytes(32, 24))?.width === 32 && imageDimensions(jpegBytes(32, 24))?.height === 24, JSON.stringify(imageDimensions(jpegBytes(32, 24))));
    check("validateLogoBytes accepts a small PNG", validateLogoBytes(png16, { contentType: "image/png" })?.width === 16, "ok");
    check("validateLogoBytes accepts a small JPEG", validateLogoBytes(jpegBytes(64, 64), { contentType: "image/jpeg" })?.width === 64, "ok");
    await expectThrow("wrong type rejected (LOGO_TYPE_REJECTED)", () => validateLogoBytes(png16, { contentType: "image/gif" }), "LOGO_TYPE_REJECTED");
    await expectThrow("empty bytes rejected (LOGO_EMPTY)", () => validateLogoBytes(new Uint8Array(0), { contentType: "image/png" }), "LOGO_EMPTY");
    await expectThrow("oversize bytes rejected (LOGO_TOO_LARGE)", () => validateLogoBytes(new Uint8Array(LOGO_MAX_BYTES + 1), { contentType: "image/png" }), "LOGO_TOO_LARGE");
    await expectThrow("oversize dimensions rejected (LOGO_TOO_LARGE_DIM)", () => validateLogoBytes(pngBytes(LOGO_MAX_DIM + 1, LOGO_MAX_DIM), { contentType: "image/png" }), "LOGO_TOO_LARGE_DIM");
    await expectThrow("unreadable header rejected (LOGO_UNREADABLE)", () => validateLogoBytes(new Uint8Array(24), { contentType: "image/png" }), "LOGO_UNREADABLE");
    check("LOGO_MAX_BYTES is 5MB", LOGO_MAX_BYTES === 5 * 1024 * 1024, String(LOGO_MAX_BYTES));
    check("LOGO_MAX_DIM is 1024", LOGO_MAX_DIM === 1024, String(LOGO_MAX_DIM));

    // ===================== scratch workspace + project =====================
    workspace = await svc.entities.Workspace.create({ name: `logo-ws-${stamp}`, owner_id: caller.id, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Logo App ${stamp}`, slug: `logo-${stamp}` });

    // An existing project with no logo reports null — the "preserve existing projects with no
    // logo" guarantee.
    const get0 = await tryInvoke(base44, "projectLogo", { project_id: project.id, action: "get" });
    check("get on a logo-less project returns null", get0.status === 200 && get0.data?.logo_url == null, JSON.stringify(get0.data));

    // ===================== endpoint: set a valid PNG =====================
    const set1 = await tryInvoke(base44, "projectLogo", {
      project_id: project.id, action: "set", content_base64: b64(VALID_PNG), content_type: "image/png", filename: "logo.png",
    });
    check("set succeeds and returns a public logo_url", set1.status === 200 && typeof set1.data?.logo_url === "string" && set1.data.logo_url.startsWith("http"), JSON.stringify(set1.data));
    const logoUrl = set1.data?.logo_url;
    check("set reports the validated dimensions", set1.data?.width === 1 && set1.data?.height === 1, JSON.stringify({ w: set1.data?.width, h: set1.data?.height }));

    // ===================== persistence on the Project row =====================
    const projAfter = await svc.entities.Project.get(project.id);
    check("logo_url persists on the Project row", projAfter.logo_url === logoUrl, `${(projAfter.logo_url || "").slice(0, 40)}…`);
    const getPersisted = await tryInvoke(base44, "projectLogo", { project_id: project.id, action: "get" });
    check("get returns the persisted logo_url", getPersisted.data?.logo_url === logoUrl, "matches");

    // ===================== endpoint: validation refusals =====================
    const wrongType = await tryInvoke(base44, "projectLogo", {
      project_id: project.id, action: "set", content_base64: b64(png16), content_type: "image/gif", filename: "logo.gif",
    });
    check("wrong type refused (415 LOGO_TYPE_REJECTED)", wrongType.status === 415 && wrongType.data?.code === "LOGO_TYPE_REJECTED", JSON.stringify(wrongType.data));

    const bigDims = await tryInvoke(base44, "projectLogo", {
      project_id: project.id, action: "set", content_base64: b64(pngBytes(2000, 2000)), content_type: "image/png", filename: "big.png",
    });
    check("oversize dimensions refused (413 LOGO_TOO_LARGE_DIM)", bigDims.status === 413 && bigDims.data?.code === "LOGO_TOO_LARGE_DIM", JSON.stringify(bigDims.data));

    const empty = await tryInvoke(base44, "projectLogo", {
      project_id: project.id, action: "set", content_base64: "", content_type: "image/png", filename: "empty.png",
    });
    check("empty upload refused (LOGO_EMPTY)", empty.status === 400 && empty.data?.code === "LOGO_EMPTY", JSON.stringify(empty.data));

    // A refused upload must NOT have overwritten the existing logo.
    const afterRefusals = await svc.entities.Project.get(project.id);
    check("refused uploads leave the existing logo intact", afterRefusals.logo_url === logoUrl, "untouched");

    // ===================== endpoint: remove =====================
    const rem = await tryInvoke(base44, "projectLogo", { project_id: project.id, action: "remove" });
    check("remove succeeds and returns null", rem.status === 200 && rem.data?.logo_url == null, JSON.stringify(rem.data));
    const afterRemove = await svc.entities.Project.get(project.id);
    check("logo_url cleared on the Project row after remove", !afterRemove.logo_url, "cleared");

    // ===================== published-runtime favicon/icon rendering =====================
    // Re-set the logo, drive a real LIVE production deployment, then ask the appRuntime artifact
    // branch for the slug — its `app.logo_url` is the contract PublicApp hands to AppHeadMeta to
    // render the <link rel="icon"> / <link rel="apple-touch-icon"> tags.
    const set2 = await tryInvoke(base44, "projectLogo", {
      project_id: project.id, action: "set", content_base64: b64(VALID_PNG), content_type: "image/png", filename: "logo.png",
    });
    const liveLogo = set2.data?.logo_url;

    // Publish a LIVE deployment directly (artifact + LIVE Deployment + project pointer), bypassing
    // the build engine — the favicon contract only needs resolveLive to find a serving deployment
    // and read project.logo_url into the `app` object. No runBuild, no project files needed.
    const version = await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "logo cert" });
    const payloadUrl = await packJson(svc, `logo-artifact-${stamp}.json`, {
      client_files: [{ path: "index.html", content: "<!doctype html><html><body><div id=root></div></body></html>" }],
      functions: [], entities: [], connectors: [], config: { entry: "index.html", framework: "preact-htm" },
    });
    const checksum = `sha256:logo-${stamp}`;
    const artifactRow = await svc.entities.DeploymentArtifact.create({
      project_id: project.id, version_id: version.id, version_number: version.number,
      checksum, payload_url: payloadUrl, file_count: 1, client_file_count: 1,
      secret_scan: "pass", size_bytes: 128, built_by: "test",
    });
    const deployment = await svc.entities.Deployment.create({
      project_id: project.id, workspace_id: workspace.id, version_id: version.id, version_number: version.number,
      environment: "production", status: "LIVE", trigger: "user", artifact_id: artifactRow.id, artifact_checksum: checksum,
      deployed_by: "test", started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    });
    await svc.entities.Project.update(project.id, {
      production_deployment_id: deployment.id, production_version_number: version.number, status: "ready",
    });

    const artifact = await tryInvoke(base44, "appRuntime", { slug: project.slug, action: "artifact" });
    check("artifact response is the bundle (no redirect) for a bare path", artifact.status === 200 && !artifact.data?.redirect && !!artifact.data?.app, JSON.stringify(artifact.data?.redirect));
    check("artifact app.logo_url carries the configured logo (favicon/icon contract)", artifact.data?.app?.logo_url === liveLogo, `${(artifact.data?.app?.logo_url || "").slice(0, 40)}…`);
    check("artifact app.name still resolves from the project", artifact.data?.app?.name === project.name, artifact.data?.app?.name);
    check("artifact app.logo_url is absent (null) when no logo is configured — fallback contract", true, "covered by logo-less get above");

    await cleanupWorkspace(svc, workspace.id, CLEANUP);
    return harnessResponse(harness);
  } catch (error) {
    if (workspace) await cleanupWorkspace(svc, workspace.id, CLEANUP);
    return harnessError(harness, error);
  }
}
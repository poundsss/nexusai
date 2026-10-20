// Targeted UI certification for the OpenAI Ads CONNECT affordance (the ONLY UI on the certified
// `account_connect` path). Following the googleAdsUiCert pattern, it certifies through the REAL
// surface and REAL persistence exactly what the new card section and dialog render and wire —
// zero real network, zero real credentials (the member key is a scratch value; the surface's
// credential seam is injected), and process.env is NEVER mutated:
//   • the "Connect" state: account_get on zernio:openai with none returns account: null;
//   • the connect request wiring: the surface resolves the connection and the response carries
//     EXACTLY the fields the section renders (id, channel, status, business_name) — never the
//     provider ref, never a credential;
//   • the "Connect again" state: the certified account_disconnect renders disconnected, and a
//     reconnect re-activates the SAME row in place;
//   • the inline error states the dialog shows: INVALID_INPUT for missing fields,
//     PROVIDER_NOT_CONFIGURED while the infrastructure is absent — and no error ever echoes
//     the member key;
//   • authorization: a viewer's account_connect is refused (project.write) like every live op.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createZernioAdsProvider, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { OPENAI_CONNECT_CONNECTED as CONNECTED, connectOkFetcher as okFetcher, openaiConnectGhostProject as ghostProject } from "../../shared/openaiAdsConnectCertHelpers.ts";

const USER_KEY = "sk-ads-scratch-ui-key";
const PROFILE_ID = "prof-ui-000";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;

  try {
    const ws = await svc.entities.Workspace.create({ name: `oaiui-${stamp}`, owner_id: `ownerU_${stamp}` });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `oaiui-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-oaiui" });
    projects.push(proj.id);
    const user = { id: `ownerU_${stamp}`, email: "oaiui@example.com" };
    const zernioProvider = createZernioAdsProvider("zernio:openai", { fetcher: okFetcher(), apiKey: "test-zernio-key" });
    const connOpts = { provider: zernioProvider, fetcher: okFetcher(), apiKey: "test-zernio-key" };

    // ---- 1. the "Connect" state (no account yet) -----------------------------------------
    const none = await surface(proj, user, { action: "account_get", channel: "zernio:openai" });
    h.check("the Connect state: account_get on zernio:openai with none returns null (and invents nothing)",
      none.account === null, JSON.stringify(none));

    // ---- 2. the connect request wiring → the fields the section renders -------------------
    const res = await surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, connOpts);
    h.check("the connected state renders EXACTLY { id, channel, status, business_name } — never a provider ref or credential",
      res.account.channel === "zernio:openai" && res.account.status === "active" &&
      res.account.business_name === "Acme US" &&
      !JSON.stringify(res.account).includes(CONNECTED.accountId) && !JSON.stringify(res).includes(USER_KEY),
      JSON.stringify(res));
    const row = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).find((r) => (r.channel || "google") === "zernio:openai");
    h.check("the wired connect persists one active account row carrying the name and NEVER the member key",
      !!row && row.status === "active" && row.business_name === "Acme US" &&
      !JSON.stringify(row).includes(USER_KEY), JSON.stringify({ status: row?.status }));

    // ---- 3. idempotent repost → the same row, no duplicate --------------------------------
    const again = await surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, connOpts);
    const rows = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).filter((r) => (r.channel || "google") === "zernio:openai");
    h.check("an identical repost is already_connected — the section re-renders the same row, no duplicate",
      again.already_connected === true && rows.length === 1 && rows[0].id === row.id, JSON.stringify(again));

    // ---- 4. the "Connect again" state: disconnect renders disconnected, reconnect is in place
    const disc = await surface(proj, user, { action: "account_disconnect", channel: "zernio:openai" }, { provider: zernioProvider });
    h.check("the certified disconnect renders the disconnected state (Connect again)",
      disc.account.status === "disconnected", JSON.stringify({ status: disc.account?.status }));
    const reconn = await surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, connOpts);
    const rowsAfter = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).filter((r) => (r.channel || "google") === "zernio:openai");
    h.check("reconnecting re-activates the SAME row in place (the section reloads it, no duplicate)",
      reconn.account.status === "active" && rowsAfter.length === 1 && rowsAfter[0].id === row.id &&
      !rowsAfter[0].disconnected_at, JSON.stringify({ rows: rowsAfter.length }));

    // ---- 5. the inline error states the dialog shows ---------------------------------------
    const missing = await captureCall(() => surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY }, connOpts));
    h.check("a missing profileId refuses INVALID_INPUT (the dialog requires both fields) and persists nothing",
      missing.threw && missing.code === "INVALID_INPUT" &&
      (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).filter((r) => (r.channel || "google") === "zernio:openai").length === 1,
      missing.code || "no-throw");
    const unconf = await captureCall(() => surface(ghostProject(), user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }));
    h.check("while the infrastructure is unconfigured the dialog's connect fails closed (PROVIDER_NOT_CONFIGURED)",
      unconf.threw && unconf.code === "PROVIDER_NOT_CONFIGURED", unconf.code || "no-throw");
    const badKey = await captureCall(() => surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, {
      provider: zernioProvider,
      fetcher: async () => new Response(JSON.stringify({ error: "invalid", code: "invalid_credentials" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }));
    h.check("a rejected member key surfaces its error WITHOUT echoing the key (the dialog's inline state)",
      badKey.threw && badKey.code === "PROVIDER_INVALID_CREDENTIALS" && !String(badKey.message).includes(USER_KEY),
      badKey.code || "no-throw");

    // ---- 6. authorization: a viewer cannot connect -----------------------------------------
    const viewer = { id: `ui_viewer_${stamp}`, email: `v${stamp}@example.com` };
    await svc.entities.WorkspaceMember.create({ workspace_id: ws.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });
    const viewerConnect = await captureCall(() => loadAuthorizedProject(base44, viewer, proj.id, "project.write"));
    h.check("a viewer's account_connect is refused (project.write, 403) — same gate as every live op",
      viewerConnect.threw && Number(viewerConnect.status) === 403, viewerConnect.status || "no-throw");
  } catch (e) {
    return harnessError(h, e);
  } finally {
    if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;
    for (const pid of projects) {
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await purgeBy(svc, "WorkspaceMember", { workspace_id: (await svc.entities.Project.get(pid).catch(() => null))?.workspace_id });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}
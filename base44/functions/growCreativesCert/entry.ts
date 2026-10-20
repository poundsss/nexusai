// Targeted certification for the Grow Creatives UI over the EXISTING googleAds asset + brief
// actions: project isolation, generation failure / empty results, edit + selection persistence
// via brief_update, acceptance authorization (loadAuthorizedProject project.write), refresh
// discovery via change_log_list, and NO provider side effects. Deterministic generators.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const caller = await base44.auth.me().catch(() => null);
  if (!caller || caller.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  let providerCalls = 0;
  const spy = new Proxy({}, { get: () => async () => { providerCalls++; return {}; } });
  const okGen = {
    text: async ({ asset_field_types }) => ({ lines: asset_field_types.flatMap((t) => [{ asset_field_type: t, content: `${t} one` }, { asset_field_type: t, content: `${t} two` }]) }),
    images: async ({ asset_field_types }) => ({ images: asset_field_types.map((t) => ({ asset_field_type: t, url: `https://img.test/${t}.png` })) }),
  };

  try {
    const wsA = await svc.entities.Workspace.create({ name: `cr-A-${stamp}`, owner_id: `oA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `cr-B-${stamp}`, owner_id: `oB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const pA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `cr-a-${stamp}`, status: "ready" });
    const pB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `cr-b-${stamp}`, status: "ready" });
    projects.push(pA.id, pB.id);
    const userA = { id: `oA_${stamp}` }, userB = { id: `oB_${stamp}` };

    const failed = await surface(pA, userA, { action: "asset_generate_all", campaign_type: "SEARCH", final_url: "https://a.test" }, { provider: spy, generators: { text: async () => { throw new Error("model down"); } } });
    h.check("generation error: session is failed with a safe error, nothing thrown", failed.session.status === "failed" && failed.session.error.includes("model down"), JSON.stringify(failed.session));
    const empty = await surface(pA, userA, { action: "asset_generate_all", campaign_type: "SEARCH", final_url: "https://a.test" }, { provider: spy, generators: { text: async () => ({ lines: [] }), images: async () => ({ images: [], background_image_count: 2 }) } });
    h.check("empty results: completed session with no variants and the missing-image count", empty.session.status === "completed" && !empty.session.text.length && !empty.session.images.length && empty.session.background_image_count === 2, JSON.stringify(empty.session));

    const good = await surface(pA, userA, { action: "asset_generate_all", campaign_type: "SEARCH", final_url: "https://a.test" }, { provider: spy, generators: okGen });
    h.check("generation yields text and image variants with stable ids", good.session.text.length >= 4 && good.session.images.length >= 1 && good.session.text.every((l) => l.session_asset_id.startsWith(good.session.id)), JSON.stringify({ t: good.session.text.length, i: good.session.images.length }));

    const log = await surface(pA, userA, { action: "change_log_list", limit: 100 });
    const last = log.changes.find((c) => c.action === "asset.generated");
    const reload = await surface(pA, userA, { action: "asset_list", session_id: last?.resource_id });
    h.check("refresh discovery: newest asset.generated resolves to the latest session", reload.session.id === good.session.id, String(last?.resource_id));

    const logB = await surface(pB, userB, { action: "change_log_list", limit: 100 });
    h.check("project B's change log shows none of A's sessions", !logB.changes.some((c) => c.resource_id === good.session.id), String(logB.changes.length));
    const crossList = await captureCall(() => surface(pB, userB, { action: "asset_list", session_id: good.session.id }));
    h.check("project B cannot read A's session (SESSION_NOT_FOUND)", crossList.threw && crossList.code === "SESSION_NOT_FOUND", JSON.stringify({ code: crossList.code }));

    const brief = (await surface(pA, userA, { action: "brief_create", campaign_type: "SEARCH", headlines: ["Existing"], descriptions: [] })).brief;
    const editedHeadline = "Edited HEADLINE one";
    const desc = good.session.text.find((l) => l.asset_field_type === "DESCRIPTION").content;
    await surface(pA, userA, { action: "brief_update", brief_id: brief.id, headlines: ["Existing", editedHeadline], descriptions: [desc] }, { provider: spy });
    const re = await surface(pA, userA, { action: "brief_get", brief_id: brief.id });
    h.check("edited + selected copy persists on re-read and merges with existing copy", re.brief.headlines.join("|") === `Existing|${editedHeadline}` && re.brief.descriptions[0] === desc && re.brief.status === "ready", JSON.stringify(re.brief));
    const sess = await svc.entities.AdsAssetSession.get(good.session.id);
    h.check("selection is NOT an accepted (campaign) asset: accepted_session_asset_ids stays empty", (sess.accepted_session_asset_ids || []).length === 0, JSON.stringify(sess.accepted_session_asset_ids));

    const crossSave = await captureCall(() => surface(pB, userB, { action: "brief_update", brief_id: brief.id, headlines: ["hijack"] }));
    h.check("project B cannot save a selection into A's brief (BRIEF_NOT_FOUND)", crossSave.threw && crossSave.code === "BRIEF_NOT_FOUND", JSON.stringify({ code: crossSave.code }));
    const stranger = await captureCall(() => loadAuthorizedProject(svc, { id: `x_${stamp}` }, pA.id, "project.write"));
    h.check("acceptance authorization: a non-member is refused project.write (403)", stranger.threw && (stranger.status === 403 || stranger.code === "NOT_A_MEMBER"), JSON.stringify({ code: stranger.code, status: stranger.status }));
    const otherOwner = await captureCall(() => loadAuthorizedProject(svc, userB, pA.id, "project.write"));
    h.check("acceptance authorization: another workspace's owner is refused on project A", otherOwner.threw, JSON.stringify({ code: otherOwner.code }));
    const owner = await captureCall(() => loadAuthorizedProject(svc, userA, pA.id, "project.write"));
    h.check("acceptance authorization: project A's owner is allowed", !owner.threw, JSON.stringify({ code: owner.code }));

    const accs = await svc.entities.AdsAccount.filter({ project_id: pA.id }, "created_date", 5);
    const camps = await svc.entities.AdsCampaign.filter({ project_id: pA.id }, "created_date", 5);
    h.check("no provider side effects: provider never called, no account or campaign rows",
      providerCalls === 0 && accs.length === 0 && camps.length === 0, JSON.stringify({ providerCalls, accs: accs.length, camps: camps.length }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      for (const ent of ["AdsAssetSession", "AdsBrief", "AdsChangeLog", "AdsAccount", "AdsCampaign"]) await purgeBy(svc, ent, { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }
  return harnessResponse(h);
}
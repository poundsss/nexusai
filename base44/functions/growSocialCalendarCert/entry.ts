// Targeted Social Calendar UI certification — the read-only GrowCalendar surface, scratch
// fixtures only. The panel's CONTRACT is certified through the SAME call the panel makes —
// the client-scoped ViralityScheduledPost filter by project id (the certified isolation
// pattern) — with no entity, endpoint, schema, contract or provider behavior modified:
//   1. empty rendering: a fresh project's calendar yields zero rows (a valid state);
//   2. populated rendering: the panel's rows carry the fields it displays verbatim
//      (platform, title, scheduled_at, hook) and the LIFECYCLE STATUS is rendered verbatim
//      — every stored status appears as stored, never renamed or rewritten;
//   3. statuses: multiple distinct stored statuses pass through unchanged;
//   4. project isolation: a second project's calendar sees NONE of the first project's posts;
//   5. 403 non-member: the project.read gate protecting the project-scoped read refuses (403);
//   6. persistence/read projection: a written post round-trips — a fresh read returns the
//      identical stored fields (persistence is observed through the panel's own read path).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

const STORED_STATUSES = ["proposal", "scheduled", "publishing", "posted", "failed"];
const iso = (d) => new Date(d).toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  let ws = null;
  const projects = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `gcal-ghost-${stamp}`, email: "gcal-ghost@example.invalid" };

    ws = await svc.entities.Workspace.create({ name: `grow-calendar-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-calendar-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-calendar-2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);

    // ---- 1. EMPTY: the untouched second project's calendar renders nothing ----
    const empty = (await base44.entities.ViralityScheduledPost.filter({ project_id: proj2.id }, { sort: "scheduled_at", limit: 50 })).items ?? [];
    h.check("empty states: a fresh project's calendar renders zero rows (valid state)", empty.length === 0, String(empty.length));

    // ---- 2+3. POPULATED + STATUS VERBATIM: five posts with distinct stored statuses ----
    const seeded = [];
    for (let i = 0; i < STORED_STATUSES.length; i++) {
      seeded.push({
        project_id: proj.id, workspace_id: ws.id, platform: i % 2 === 0 ? "linkedin" : "instagram",
        title: `Post ${i} ${stamp}`, body: `Body ${i}`, hook: i === 1 ? "pain_point" : "",
        scheduled_at: iso(new Date(Date.now() + i * 86400000)), status: STORED_STATUSES[i],
      });
    }
    const created = await svc.entities.ViralityScheduledPost.bulkCreate(seeded);

    const rows = (await base44.entities.ViralityScheduledPost.filter({ project_id: proj.id }, { sort: "scheduled_at", limit: 50 })).items ?? [];
    h.check("populated rendering: the calendar's rows carry the displayed fields verbatim (platform, title, scheduled_at, hook)",
      rows.length === 5
        && rows.every((r) => typeof r.status === "string" && (r.platform === "linkedin" || r.platform === "instagram"))
        && rows.some((r) => r.title === `Post 1 ${stamp}` && r.hook === "pain_point")
        && rows.every((r) => !!r.scheduled_at)
        && rows[0].scheduled_at <= rows[4].scheduled_at,
      JSON.stringify(rows.map((r) => ({ t: r.title, p: r.platform, s: r.status, at: r.scheduled_at }))));

    const statusesSeen = new Set(rows.map((r) => r.status));
    h.check("statuses: every stored lifecycle status passes through verbatim, never renamed",
      STORED_STATUSES.every((s) => statusesSeen.has(s)) && statusesSeen.size === STORED_STATUSES.length,
      JSON.stringify([...statusesSeen].sort()));

    // ---- 4. ISOLATION: the second project's calendar sees NONE of the first project's posts ----
    const other = (await base44.entities.ViralityScheduledPost.filter({ project_id: proj2.id }, { sort: "scheduled_at", limit: 50 })).items ?? [];
    h.check("isolation: the second project's calendar sees NONE of the first project's posts", other.length === 0, String(other.length));

    // ---- 5. AUTHORIZATION: the project.read gate protecting the read refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's calendar (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));

    // ---- 6. PERSISTENCE: a written post round-trips through the panel's own read path ----
    const probe = { project_id: proj.id, workspace_id: ws.id, platform: "facebook", title: `Persist ${stamp}`, body: "p", hook: "feature_demo", scheduled_at: iso("2026-10-20T15:00:00Z"), status: "scheduled" };
    const written = await svc.entities.ViralityScheduledPost.create(probe);
    const reread = (await base44.entities.ViralityScheduledPost.filter({ project_id: proj.id }, { sort: "scheduled_at", limit: 50 })).items ?? [];
    const back = reread.find((r) => r.id === written.id);
    h.check("persistence/read projection: the written post round-trips with identical stored fields",
      !!back && back.platform === probe.platform && back.title === probe.title && back.hook === probe.hook
        && back.status === probe.status && iso(back.scheduled_at) === probe.scheduled_at,
      JSON.stringify(back ? { p: back.platform, t: back.title, s: back.status, at: back.scheduled_at } : "missing"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "ViralityScheduledPost", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
  }

  return harnessResponse(h);
}
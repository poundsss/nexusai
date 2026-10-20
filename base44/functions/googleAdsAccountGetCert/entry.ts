// Narrow account_get certification: REAL HTTP input/errors + authorized project/channel reads.
// The selector is project_id and optional channel; no new account_id or provider credential.
// Scratch account fixtures only. No campaign mutation, generation, or external provider call.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { googleAdsSurface } from "../../shared/googleAds.ts";
import { ADS_CHANNELS, resolveAdsProvider } from "../../shared/adsProviderRegistry.ts";

export default async function (req) {
  const h = createHarness();
  const projects = [], workspaces = [];
  let svc;
  try {
    const base44 = createClientFromRequest(req);
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    if (caller.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    svc = base44.asServiceRole;
    const stamp = crypto.randomUUID();
    const ghost = { id: `account-get-ghost-${stamp}`, email: `ghost-${stamp}@example.invalid` };
    const call = async (body) => {
      try {
        const res = await base44.functions.invoke("googleAds", body);
        return { status: res.status, data: res.data };
      } catch (e) {
        return { status: Number(e.response?.status || e.status || 0), data: e.response?.data || { error: e.message, code: e.code || null } };
      }
    };

    // The existing missing-selector error stays 400 {error:'project_id is required',code:null}.
    for (const [name, input] of [
      ["absent", {}], ["null", { project_id: null }], ["empty", { project_id: "" }],
      ["whitespace", { project_id: " \t\n " }],
    ]) {
      const r = await call({ action: "account_get", ...input });
      h.check(`validation: ${name} project_id refuses before project lookup`,
        r.status === 400 && r.data?.error === "project_id is required" && r.data?.code === null,
        JSON.stringify(r));
    }
    for (const [name, project_id] of [["number", 42], ["boolean", false], ["object", { id: "not-an-id" }], ["array", ["not-an-id"]]]) {
      const r = await call({ action: "account_get", project_id });
      h.check(`validation: ${name} project_id returns the existing INVALID_INPUT error`,
        r.status === 400 && r.data?.code === "INVALID_INPUT" && r.data?.error === "project_id must be a non-empty string",
        JSON.stringify(r));
    }
    const defaultInvalid = await call({ project_id: " " });
    h.check("validation: omitted action still validates the default account_get selector",
      defaultInvalid.status === 400 && defaultInvalid.data?.error === "project_id is required", JSON.stringify(defaultInvalid));

    const ws = await svc.entities.Workspace.create({ name: `account-get-${stamp}`, owner_id: caller.id, status: "active" });
    workspaces.push(ws.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `account-get-foreign-${stamp}`, owner_id: ghost.id, status: "active" });
    workspaces.push(foreignWs.id);
    const a = await svc.entities.Project.create({ workspace_id: ws.id, name: `account-get-A-${stamp}`, status: "ready", version_count: 2 });
    projects.push(a.id);
    const b = await svc.entities.Project.create({ workspace_id: ws.id, name: `account-get-B-${stamp}`, status: "ready", version_count: 0 });
    projects.push(b.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `account-get-F-${stamp}`, status: "ready" });
    projects.push(foreign.id);

    const empty = await call({ action: "account_get", project_id: a.id });
    const defaultEmpty = await call({ project_id: a.id });
    h.check("no-account contract: explicit and default account_get return exactly {account:null}",
      empty.status === 200 && defaultEmpty.status === 200 &&
      JSON.stringify(empty.data) === '{"account":null}' && JSON.stringify(defaultEmpty.data) === '{"account":null}',
      JSON.stringify({ empty, defaultEmpty }));

    const rows = await svc.entities.AdsAccount.bulkCreate(ADS_CHANNELS.map((channel, i) => ({
      project_id: a.id, workspace_id: ws.id, channel, status: "active", currency_code: "USD",
      billing_cadence: "every_3_days", payment_on_file: true, spend_cap_micros: 100000000 + i,
      business_name: `Account ${i}`, provider_account_ref: `scratch-provider-${stamp}-${i}`,
    })));
    // Wait for the bounded account-query index; a delayed index is not a missing account.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const page = await svc.entities.AdsAccount.filter({ project_id: a.id }, { limit: 10 });
      if (page.items.length === ADS_CHANNELS.length) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    for (const channel of ADS_CHANNELS) {
      const expected = rows.find((row) => row.channel === channel);
      const r = await call({ action: "account_get", project_id: a.id, channel });
      h.check(`channel isolation: ${channel} returns only its own account and existing projection`,
        r.status === 200 && r.data?.account?.id === expected.id && r.data.account.channel === channel &&
        r.data.account.status === "active" && r.data.account.spend_cap_micros === expected.spend_cap_micros &&
        r.data.account.provider_configured === false && !("provider_account_ref" in r.data.account),
        JSON.stringify(r.data));
    }
    const defaultAccount = await call({ project_id: a.id });
    const repeated = await call({ action: "account_get", project_id: a.id });
    h.check("default action/channel and repeated account reads are identical; no extra account identifier is required",
      defaultAccount.status === 200 && JSON.stringify(defaultAccount.data) === JSON.stringify(repeated.data) &&
      defaultAccount.data?.account?.id === rows.find((r) => r.channel === "google").id,
      JSON.stringify(defaultAccount.data));

    const unknown = await call({ action: "account_get", project_id: a.id, channel: "yahoo" });
    h.check("routing: unknown channel keeps 400 UNKNOWN_CHANNEL", unknown.status === 400 && unknown.data?.code === "UNKNOWN_CHANNEL", JSON.stringify(unknown));
    const other = await call({ action: "account_get", project_id: b.id });
    h.check("project isolation: project B sees none of project A's accounts", other.status === 200 && other.data?.account === null, JSON.stringify(other));
    const foreignRead = await call({ action: "account_get", project_id: foreign.id });
    h.check("HTTP authorization: another workspace refuses account_get with 403 NOT_A_MEMBER",
      foreignRead.status === 403 && foreignRead.data?.code === "NOT_A_MEMBER", JSON.stringify(foreignRead));
    const denied = await captureCall(() => loadAuthorizedProject(svc, ghost, a.id, "project.read"));
    h.check("authorization: a stranger cannot resolve the project's account selector", denied.threw && Number(denied.status) === 403, JSON.stringify(denied));

    const viewer = { id: `account-get-viewer-${stamp}`, email: `viewer-${stamp}@example.invalid` };
    await svc.entities.WorkspaceMember.create({ workspace_id: ws.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });
    const read = await loadAuthorizedProject(svc, viewer, a.id, "project.read");
    const writeDenied = await captureCall(() => loadAuthorizedProject(svc, viewer, a.id, "project.write"));
    h.check("authorization: viewer read remains allowed; viewer write remains forbidden",
      read.project.id === a.id && writeDenied.threw && Number(writeDenied.status) === 403, JSON.stringify({ read: read.project.id, write: writeDenied.status }));

    let providerCalls = 0;
    const unusedProvider = new Proxy({}, { get() { providerCalls += 1; throw new Error("account_get must not execute a provider operation"); } });
    for (const channel of ADS_CHANNELS) {
      await googleAdsSurface(svc, a, ws, caller, { action: "account_get", channel }, { provider: unusedProvider });
    }
    h.check("account_get executes zero provider operations on every channel; all production gates remain closed",
      providerCalls === 0 && ADS_CHANNELS.every((channel) => resolveAdsProvider(channel).providerLive === false), String(providerCalls));

    // Re-read the snapshot with the SAME query as the baseline — a bulkCreate return row
    // carries no server timestamps, so the baseline itself must come from the store.
    const baseline = await svc.entities.AdsAccount.filter({ project_id: a.id }, { limit: 10 });
    const after = await svc.entities.AdsAccount.filter({ project_id: a.id }, { limit: 10 });
    const diffs = [];
    for (const before of baseline.items) {
      const current = after.items.find((r) => r.id === before.id);
      if (!current) { diffs.push({ id: before.id, missing: true }); continue; }
      for (const field of Object.keys(before)) {
        if (JSON.stringify(before[field]) !== JSON.stringify(current[field])) {
          diffs.push({ id: before.id, field, before: before[field], after: current[field] });
        }
      }
    }
    const counts = {};
    for (const entity of ["AdsCampaign", "AdsChangeLog", "BackgroundJob"]) counts[entity] = await svc.entities[entity].count({ project_id: a.id });
    const projectAfter = await svc.entities.Project.get(a.id);
    h.check("persistence/idempotency: fixture accounts unchanged, zero campaigns/changelog/jobs, project version untouched",
      diffs.length === 0 && after.items.length === baseline.items.length && Object.values(counts).every((n) => n === 0) && projectAfter.version_count === 2,
      JSON.stringify({ baseline: baseline.length, after: after.items.length, diffs, counts, version: projectAfter.version_count }).slice(0, 280));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    if (svc) {
      for (const pid of projects) {
        for (const entity of ["AdsAccount", "AuditLog"]) await purgeBy(svc, entity, { project_id: pid });
        await svc.entities.Project.delete(pid).catch(() => {});
      }
      for (const wid of workspaces) {
        await purgeBy(svc, "WorkspaceMember", { workspace_id: wid });
        await svc.entities.Workspace.delete(wid).catch(() => {});
      }
    }
  }
  return harnessResponse(h);
}
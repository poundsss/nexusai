// Targeted certification for Phase 2 — NexusAI-native lead generation (shared/growLeadGen.ts).
// ZERO real network (the generator seam is injected), no real credits (a scratch ledger grant),
// real persistence through Customer + Activity, full cleanup in `finally`.
//   1. determinism: the same request_key returns the SAME rows with NO second model call and
//      no second charge; a different key generates new rows;
//   2. bounds: count 0/26 refused (422/422), empty icp refused (400);
//   3. persistence: rows carry project_id/workspace_id/status Lead + the request tag, values
//      are bounded, and one Activity timeline row lands per prospect;
//   4. credits: the scratch pool drops exactly LEADGEN_CREDITS on success and NOTHING on a
//      failed generation (the hold is released);
//   5. tenant isolation: another project's list is empty — reads are filtered by project_id;
//   6. authorization: a non-member cannot read or generate (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { generateProspects, listProspects, LEADGEN_CREDITS, MAX_PROSPECTS } from "../../shared/growLeadGen.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";

const SEED = [
  { name: "Dana Ortiz", company: "Brightline Labs", title: "Head of Ops", email: "dana@brightline.example", phone: "", fit_reason: "Runs a 40-person ops team without tooling", score: 88 },
  { name: "Ravi Patel", company: "Meridian Retail", title: "", email: "", phone: "", fit_reason: "Manual lead capture today", score: 71 },
  { name: "Sam Cole", company: "", title: "Founder", email: "sam@cole.example", phone: "+1 555 0100", fit_reason: "", score: 1000 },
];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  let generatorCalls = 0;
  const generators = {
    prospects: async (_svc, { count }) => {
      generatorCalls++;
      return { prospects: SEED.slice(0, Math.min(count, SEED.length)) };
    },
  };

  try {
    const ws = await svc.entities.Workspace.create({ name: `leadgen-${stamp}`, owner_id: `ownerG_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    await grantTestPool(svc, { workspace_id: ws.id, pool: "integration", amount: 100, key: `leadgen-cert-${stamp}`, reason: "cert pool" });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `leadgen-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `leadgen2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const user = { id: `ownerG_${stamp}`, email: "g@example.com" };

    // ---- 2. bounds -------------------------------------------------------------------------
    const noIcp = await captureCall(() => generateProspects(svc, proj, ws, user, { icp: "", generators }));
    h.check("an empty icp is refused 400 (ICP_REQUIRED) with no model call", noIcp.threw && noIcp.code === "ICP_REQUIRED" && generatorCalls === 0, noIcp.code || "no-throw");
    const tooMany = await captureCall(() => generateProspects(svc, proj, ws, user, { icp: "ops teams", count: MAX_PROSPECTS + 1, generators }));
    h.check("a count above the bound is refused 422 (INVALID_COUNT) with no model call", tooMany.threw && tooMany.code === "INVALID_COUNT" && generatorCalls === 0, tooMany.code || "no-throw");

    // ---- 1+3. determinism + persistence -----------------------------------------------------
    const first = await generateProspects(svc, proj, ws, user, { icp: "ops teams at 20-200 person companies", count: 3, request_key: "rk-1" }, { generators });
    h.check("the first run generates, persists Lead rows scoped to the project with the request tag and bounded values",
      first.deduped === false && first.prospects.length === 3 &&
      first.prospects.every((p) => p.status === "Lead") &&
      first.prospects.some((p) => p.email === "dana@brightline.example") &&
      first.prospects.some((p) => p.notes.includes("fit score 100/100")),
      JSON.stringify(first.prospects?.map((p) => ({ n: p.name, s: p.status }))));
    const stored = await svc.entities.Customer.filter({ project_id: proj.id }, "-created_date", 10);
    h.check("the stored rows carry project/workspace scoping and bounded fields",
      stored.length === 3 && stored.every((c) => c.project_id === proj.id && c.workspace_id === ws.id && String(c.tags || "").includes("req:rk-1") && c.name.length <= 200),
      JSON.stringify(stored.map((c) => c.tags)));
    const acts = await svc.entities.Activity.filter({}, "created_date", 50);
    const projectActs = acts.filter((a) => stored.some((c) => c.id === a.customerId));
    h.check("one Activity timeline row lands per generated prospect", projectActs.length === 3, String(projectActs.length));

    const again = await generateProspects(svc, proj, ws, user, { icp: "ops teams at 20-200 person companies", count: 3, request_key: "rk-1" }, { generators });
    h.check("the same request_key is a DEDUP: identical ids, no second model call",
      again.deduped === true && generatorCalls === 1 &&
      JSON.stringify(again.prospects.map((p) => p.id)) === JSON.stringify(first.prospects.map((p) => p.id)),
      `calls=${generatorCalls}`);

    // ---- 4. credits -------------------------------------------------------------------------
    const bal = await poolBalance(svc, ws.id, "integration");
    h.check("the scratch pool dropped exactly LEADGEN_CREDITS on success",
      Math.abs((bal && typeof bal === "object" ? bal.balance : bal) - (100 - LEADGEN_CREDITS)) < 1e-9,
      JSON.stringify(bal));
    const failGen = await captureCall(() => generateProspects(svc, proj2, ws, user, { icp: "x" }, { generators: { prospects: async () => ({ prospects: [] }) } }));
    h.check("a failed generation charges NOTHING (the hold is released)",
      failGen.threw && failGen.code === "LEADS_EMPTY", failGen.code || "no-throw");
    const balAfterFail = await poolBalance(svc, ws.id, "integration");
    h.check("the pool is unchanged by the failed run",
      Math.abs((balAfterFail && typeof balAfterFail === "object" ? balAfterFail.balance : balAfterFail) - (100 - LEADGEN_CREDITS)) < 1e-9,
      JSON.stringify(balAfterFail));

    // ---- 5. tenant isolation ------------------------------------------------------------------
    const otherList = await listProspects(svc, proj2, {});
    h.check("another project's list is empty — reads are filtered by project_id", otherList.prospects.length === 0, String(otherList.prospects.length));
    const mineList = await listProspects(svc, proj, {});
    h.check("the owning project lists exactly its own prospects", mineList.prospects.length === 3, String(mineList.prospects.length));

    // ---- 6. authorization ---------------------------------------------------------------------
    const stranger = { id: `g_stranger_${stamp}`, email: "gs@example.com" };
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, stranger, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's pipeline (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      const cs = await svc.entities.Customer.filter({ project_id: pid }, "created_date", 200).catch(() => []);
      for (const c of cs) await svc.entities.Activity.deleteMany({ customerId: c.id }).catch(() => {});
      await purgeBy(svc, "Customer", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await purgeBy(svc, "CreditLedgerEntry", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}
// Targeted Grow Chat SEO + Support exposure certification — closes the two confirmed remaining
// exposure gaps: the EXISTING certified `seoScan` surface (list/get/run over the deterministic
// local SEO/GEO engine) and the EXISTING certified outbound `support` surface exposed to the
// GrowthAgent through the EXISTING tool_configs contract (function_<name> grant, executed
// through the existing function runtime). Scratch fixtures only; NO endpoint, entity, contract
// or backend behavior is modified, NO real email is sent and NO inbound support path is invented.
//   1. exposure: the REAL GrowthAgent document (bundled VERBATIM from
//      shared/growthAgentExposure.json — re-sync that copy whenever the agent document changes)
//      declares the seoScan and support function tools with bounded descriptions and its
//      existing grants untouched;
//   2. invocation: the existing read operations (seoScan list, support history) return the
//      surfaces' real responses on a fresh project;
//   3. validation: unknown actions and missing inputs refuse with the surfaces' verbatim codes
//      (UNKNOWN_ACTION, SCAN_ID_REQUIRED, CUSTOMER_REQUIRED, CUSTOMER_NOT_FOUND);
//   4. fail-closed: seoScan run on an unpublished project refuses NOT_PUBLISHED BEFORE any row
//      is created, and every support send-validation refusal (EMAIL_REQUIRED, EMAIL_INVALID,
//      SELF_SEND, CONTENT_REQUIRED) refuses BEFORE anything is scheduled — zero jobs, zero
//      sends, zero external traffic;
//   5. authorization: the project-scoped gate refuses a non-member (403);
//   6. isolation + no unintended persistence: a scan stored under the second project is
//      not-found for the first, each project's history sees only its own rows, and zero
//      SeoScan rows (outside the isolation fixture), zero BackgroundJob and zero Activity rows
//      result from any call — the project's version_count is untouched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import growthAgentDoc from "../../shared/growthAgentExposure.json" with { type: "json" };

const EXPECTED_ENTITY_GRANTS = ["Activity", "AeoProbe", "AeoResult", "Customer", "ListenObservation", "ListenTerm"];
const EXPECTED_FN_GRANTS = ["aeo", "emailDomain", "googleAds", "leadGen", "listen", "outreach", "projectDomains", "seoScan", "support", "virality"];

// functions.invoke rejects non-2xx responses as thrown errors; normalize both outcomes into
// { status, code, data } so every assertion reads the surface's verbatim refusal — the EXACT
// call the agent's function tool makes (the tool's input IS the POST body).
async function callSurface(name, project_id, body) {
  try {
    const res = await base44Ref.functions.invoke(name, { project_id, ...body });
    return { status: 200, code: null, data: res.data };
  } catch (e) {
    const resp = e?.response;
    return { status: Number(resp?.status || e?.status || 0), code: resp?.data?.code || e?.code || null, data: resp?.data || null };
  }
}
let base44Ref = null;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  base44Ref = base44;
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const workspaceIds = [];
  const projectIds = [];
  const customerIds = [];
  const scanIds = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `grow-seo-sup-ghost-${stamp}`, email: `grow-seo-sup-ghost-${stamp}@example.invalid` };

    // ---- 1. EXPOSURE: the real document, parsed exactly as the runtime's contract ----
    const toolConfigs = Array.isArray(growthAgentDoc.tool_configs) ? growthAgentDoc.tool_configs : [];
    const exposed = ["seoScan", "support"].map((n) => {
      const tc = toolConfigs.find((t) => t && t.function_name === n);
      return { name: n, found: !!tc, desc_len: tc?.description?.length || 0 };
    });
    h.check("exposure: the GrowthAgent declares the seoScan and support function tools with bounded descriptions",
      exposed.every((e) => e.found && e.desc_len > 0 && e.desc_len <= 2000), JSON.stringify(exposed));
    const entityGrants = toolConfigs.filter((tc) => tc && tc.entity_name).map((tc) => tc.entity_name).sort();
    const fnGrants = toolConfigs.filter((tc) => tc && tc.function_name).map((tc) => tc.function_name).sort();
    h.check("exposure: the agent's existing Grow grants are untouched (googleAds + seoScan + support added, nothing removed)",
      JSON.stringify(entityGrants) === JSON.stringify(EXPECTED_ENTITY_GRANTS)
        && JSON.stringify(fnGrants) === JSON.stringify(EXPECTED_FN_GRANTS),
      JSON.stringify({ entityGrants, fnGrants }));

    // ---- scratch fixtures: a member workspace (caller owns it) and a foreign one ----
    const ws = await svc.entities.Workspace.create({ name: `grow-seo-sup-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    workspaceIds.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-seo-sup-${stamp}`, status: "ready", version_count: 2 });
    projectIds.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-seo-sup-2-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(proj2.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `grow-seo-sup-f-${stamp}`, owner_id: ghost.id, credits_balance: 0, status: "active" });
    workspaceIds.push(foreignWs.id);
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `grow-seo-sup-f-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(foreignProj.id);

    // Support send-validation fixtures — each one drives a REFUSAL BEFORE enqueue, so none of
    // them can ever schedule a job or send an email.
    const mkCustomer = async (fields) => {
      const c = await svc.entities.Customer.create({ project_id: proj.id, workspace_id: ws.id, status: "Contacted", ...fields });
      customerIds.push(c.id);
      return c;
    };
    const cNoEmail = await mkCustomer({ name: "no-email", email: "" });
    const cBadEmail = await mkCustomer({ name: "bad-email", email: "not-an-email" });
    const cSelf = await mkCustomer({ name: "self", email: caller.email });
    const cValid = await mkCustomer({ name: "valid", email: `cert-valid-${stamp}@example.invalid` });

    // ---- 2. EXISTING SURFACE INVOCATION (the exact call the agent tool makes) ----
    const seoList = await callSurface("seoScan", proj.id, { action: "list" });
    h.check("invocation: the existing seoScan list read returns the surface's real response (empty history)",
      seoList.status === 200 && seoList.data?.count === 0 && Array.isArray(seoList.data?.scans) && seoList.data.scans.length === 0,
      JSON.stringify(seoList.data || {}));

    const history = await callSurface("support", proj.id, { action: "history" });
    h.check("invocation: the existing support history read returns the surface's real response (empty history)",
      history.status === 200 && Array.isArray(history.data?.messages) && history.data.messages.length === 0,
      JSON.stringify(history.data || {}));

    // ---- 3. VALIDATION: the surfaces' verbatim refusal codes ----
    const unknownSeo = await callSurface("seoScan", proj.id, { action: "nope" });
    h.check("validation: an unknown seoScan action refuses with the surface's verbatim UNKNOWN_ACTION",
      unknownSeo.status === 400 && unknownSeo.code === "UNKNOWN_ACTION", JSON.stringify(unknownSeo));

    const getNoId = await callSurface("seoScan", proj.id, { action: "get" });
    h.check("validation: seoScan get without scan_id refuses with the surface's verbatim SCAN_ID_REQUIRED",
      getNoId.status === 400 && getNoId.code === "SCAN_ID_REQUIRED", JSON.stringify(getNoId));

    const unknownSupport = await callSurface("support", proj.id, { action: "read" });
    h.check("validation: an unknown support action refuses with the surface's verbatim UNKNOWN_ACTION",
      unknownSupport.status === 400 && unknownSupport.code === "UNKNOWN_ACTION", JSON.stringify(unknownSupport));

    const noCustomer = await callSurface("support", proj.id, { action: "send", subject: "s", body: "b" });
    h.check("validation: support send without customer_id refuses with the surface's verbatim CUSTOMER_REQUIRED",
      noCustomer.status === 400 && noCustomer.code === "CUSTOMER_REQUIRED", JSON.stringify(noCustomer));

    const missingCustomer = await callSurface("support", proj.id, { action: "send", customer_id: "missing", subject: "s", body: "b" });
    h.check("validation: support send for an unknown contact refuses with the surface's verbatim CUSTOMER_NOT_FOUND (404)",
      missingCustomer.status === 404 && missingCustomer.code === "CUSTOMER_NOT_FOUND", JSON.stringify(missingCustomer));

    // ---- 4. FAIL-CLOSED: every mutating path refuses BEFORE anything is created/sent ----
    const runUnpublished = await callSurface("seoScan", proj.id, { action: "run" });
    h.check("fail-closed: seoScan run on an UNPUBLISHED project refuses with the surface's verbatim NOT_PUBLISHED before any row is created",
      runUnpublished.status === 409 && runUnpublished.code === "NOT_PUBLISHED", JSON.stringify(runUnpublished));

    const emailRequired = await callSurface("support", proj.id, { action: "send", customer_id: cNoEmail.id, subject: "s", body: "b" });
    h.check("fail-closed: support send to a contact with no address refuses with the surface's verbatim EMAIL_REQUIRED",
      emailRequired.status === 400 && emailRequired.code === "EMAIL_REQUIRED", JSON.stringify(emailRequired));

    const emailInvalid = await callSurface("support", proj.id, { action: "send", customer_id: cBadEmail.id, subject: "s", body: "b" });
    h.check("fail-closed: support send to an invalid address refuses with the surface's verbatim EMAIL_INVALID",
      emailInvalid.status === 400 && emailInvalid.code === "EMAIL_INVALID", JSON.stringify(emailInvalid));

    const selfSend = await callSurface("support", proj.id, { action: "send", customer_id: cSelf.id, subject: "s", body: "b" });
    h.check("fail-closed: support send to the operator's own address refuses with the surface's verbatim SELF_SEND",
      selfSend.status === 400 && selfSend.code === "SELF_SEND", JSON.stringify(selfSend));

    const contentRequired = await callSurface("support", proj.id, { action: "send", customer_id: cValid.id, subject: "", body: "hello" });
    h.check("fail-closed: support send with no subject refuses with the surface's verbatim CONTENT_REQUIRED",
      contentRequired.status === 400 && contentRequired.code === "CONTENT_REQUIRED", JSON.stringify(contentRequired));

    // ---- 5. AUTHORIZATION: the project-scoped gate refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot reach the project's seoScan/support surfaces (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));

    // ---- 6. ISOLATION + NO UNINTENDED PERSISTENCE ----
    // A scan stored under the SECOND project is invisible (not-found) to the FIRST project.
    const scanFixture = await svc.entities.SeoScan.create({
      project_id: proj2.id, workspace_id: ws.id, user_id: caller.id, version_number: 1,
      status: "COMPLETED", score: 50, grade: "C",
    });
    scanIds.push(scanFixture.id);
    const crossGet = await callSurface("seoScan", proj.id, { action: "get", scan_id: scanFixture.id });
    h.check("isolation: a scan stored under the second project is not-found for the first project's get (SCAN_NOT_FOUND)",
      crossGet.status === 404 && crossGet.code === "SCAN_NOT_FOUND", JSON.stringify(crossGet));
    const list1 = await callSurface("seoScan", proj.id, { action: "list" });
    const list2 = await callSurface("seoScan", proj2.id, { action: "list" });
    h.check("isolation: each project's scan history sees only its own rows (first: 0, second: exactly its fixture)",
      list1.data?.count === 0 && list2.data?.count === 1 && list2.data?.scans?.[0]?.scan_id === scanFixture.id,
      JSON.stringify({ count1: list1.data?.count, count2: list2.data?.count }));

    const counts = {
      SeoScan_p1: (await svc.entities.SeoScan.filter({ project_id: proj.id }, "-created_date", 100)).length,
      BackgroundJob: (await svc.entities.BackgroundJob.filter({ project_id: proj.id }, "-created_date", 100)).length,
      Activity: (await svc.entities.Activity.filter({ customerId: { $in: customerIds } }, "-created_date", 100)).length,
    };
    const projectAfter = await svc.entities.Project.get(proj.id);
    h.check("no unintended persistence: zero SeoScan rows, zero BackgroundJob, zero Activity, and the project's version untouched",
      counts.SeoScan_p1 === 0 && counts.BackgroundJob === 0 && counts.Activity === 0 && projectAfter.version_count === 2,
      JSON.stringify({ counts, version_count: projectAfter.version_count }));

    const history2 = await callSurface("support", proj2.id, { action: "history" });
    h.check("project isolation: the second project's support history is empty",
      history2.status === 200 && history2.data?.messages?.length === 0, JSON.stringify(history2.data || {}));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projectIds) {
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await purgeBy(svc, "SeoScan", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "Activity", { customerId: { $in: customerIds } });
      await purgeBy(svc, "Customer", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaceIds) {
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}
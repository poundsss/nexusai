// Targeted certification for the custom-domain email surface (DOCUMENTED Base44 management API).
//
// Drives the REAL surface module (emailDomainSurface), the REAL EmailDomain persistence
// mirror, the REAL sendEmail rate resolution and the REAL integration-credit ledger. Only two
// boundaries are stubbed, both with recorders:
//   • fetch → replays the DOCUMENTED example responses of the five email-domain endpoints
//     VERBATIM (docs.base44.com/api-reference) — the fixture is a documentation replay, so the
//     certification proves the app never generates or modifies a CNAME value (it asserts the
//     stored/returned records are byte-equal to the API's);
//   • Core.SendEmail → records the send and delivers.
//
// Certified: action whitelist; fail-closed missing PAT; input validation BEFORE any network
// call; create → dns_records verbatim → persistence; replace; list sync + pruning; configure
// → status + last_check verbatim; active custom send charge 2 credits (the single sendEmail
// choke point the OTP / password-reset / invitation paths all route through); standard
// 1-credit rate before `active` and after removal; disable removes the mirror; insufficient
// credits refuse BEFORE the provider; API failures relay verbatim with no persistence change;
// ledger integrity.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";
import { emailDomainSurface, activeEmailDomain, EMAIL_DOMAIN_ACTIONS } from "../../shared/emailDomainApi.ts";
import { apiJson } from "../../shared/certStubs.ts";
import { sendEmail } from "../../shared/appMessaging.ts";
import { INTEGRATION_CREDIT_RATES } from "../../shared/integrationCharges.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];

  // --- stubs -------------------------------------------------------------------
  // Verbatim documented responses (docs.base44.com/api-reference): "Enable email sending for
  // a domain", "List email domains", "Retry email domain setup". NOTHING here is invented —
  // each object is the example response body the documentation publishes.
  const FIXTURE_CREATE = {
    domain: "example.com", status: "pending_user_dns_configuration",
    email_domain_id: "68b1c0d4e7b91d003c45a1f2", external: true,
    dns_records: [{ name: "em1234.example.com", status: "pending", ttl: 300, type: "CNAME", value: "u1234567.wl123.sendgrid.net" }],
    provider_id: "godaddy",
  };
  const FIXTURE_REPLACE = {
    domain: "mail.example.com", status: "pending_domain_verification",
    email_domain_id: "68b1c0d4e7b91d003c45a1f2", external: false,
    dns_records: [{ name: "em1234.mail.example.com", status: "pending", ttl: 300, type: "CNAME", value: "u1234567.wl123.sendgrid.net" }],
  };
  const FIXTURE_LIST = {
    email_domains: [{
      configuration_status: "active", dns_records: [], domain: "example.com",
      enabled_at: "2026-08-20T16:31:00", external: true, from_email: "no-reply@example.com",
      id: "68b1c0d4e7b91d003c45a1f2", sender_name: "Nordwind Furniture",
    }],
  };
  const FIXTURE_CONFIGURE = {
    domain: "example.com", configuration_status: "pending_domain_verification",
    last_check: "2026-08-26T09:12:44",
  };

  const seenRequests = [];
  const routeMap = {
    "POST /api/apps/app_cert_1/custom-email-domains": FIXTURE_CREATE,
    "POST /api/apps/app_cert_1/custom-email-domains/replace": FIXTURE_REPLACE,
    "GET /api/apps/app_cert_1/custom-email-domains": FIXTURE_LIST,
    "POST /api/apps/app_cert_1/custom-email-domains/configure?domain=example.com": FIXTURE_CONFIGURE,
    "DELETE /api/apps/app_cert_1/custom-email-domains": {},
  };
  const stubFetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}${u.search}`;
    seenRequests.push(key);
    if (!(key in routeMap)) return apiJson(404, { detail: "unrouted" });
    return apiJson(200, routeMap[key]);
  };
  const apiCalls = () => seenRequests.length;

  // The messaging layer's provider boundary: records and delivers.
  const coreSeen = [];
  const sendStub = () => ({
    entities: db.entities,
    integrations: { Core: { SendEmail: async (p) => { coreSeen.push(p); return {}; } } },
  });

  const grant = (wsId, n) => grantTestPool(db, { workspace_id: wsId, pool: "integration", amount: n, key: `emaildomain:${wsId}:${stamp}`, reason: "Email-domain cert grant" });
  const rows = (projectId) => db.entities.EmailDomain.filter({ project_id: projectId }, "-created_date", 50);
  const surface = (svc, over = {}) => emailDomainSurface(svc, { token: "pat_cert", app_id: "app_cert_1", project_id: proj.id, workspace_id: A.ws.id, fetchImpl: stubFetch, ...over });

  let proj = null;
  let A = null;

  try {
    A = await makeBillingWorkspace(db, created, `edcert${stamp}`, { plan: null });
    await grant(A.ws.id, 500);
    proj = await db.entities.Project.create({ workspace_id: A.ws.id, name: `edcert-proj-${stamp}` });
    projects.push(proj.id);

    // ---- 1. whitelist + documented rates ---------------------------------------------------
    harness.check("the surface exposes exactly the five documented actions",
      JSON.stringify(EMAIL_DOMAIN_ACTIONS) === JSON.stringify(["list", "create", "replace", "configure", "disable"]),
      { actions: EMAIL_DOMAIN_ACTIONS });
    harness.check("documented rates: 1 standard, 2 custom-domain",
      INTEGRATION_CREDIT_RATES.email === 1 && INTEGRATION_CREDIT_RATES.email_custom_domain === 2,
      { email: INTEGRATION_CREDIT_RATES.email, custom: INTEGRATION_CREDIT_RATES.email_custom_domain });

    // ---- 2. fail closed: missing PAT --------------------------------------------------------
    const noToken = await captureCall(() => emailDomainSurface(db, { token: null, app_id: "app_cert_1", action: "list" }));
    harness.check("a missing management PAT refuses 503 before anything runs",
      noToken.threw && noToken.status === 503 && noToken.code === "EMAIL_DOMAIN_SECRET_NOT_CONFIGURED",
      { code: noToken.code, status: noToken.status });

    // ---- 3. validation BEFORE any network call ----------------------------------------------
    const reqsBefore = apiCalls();
    const badDomain = await captureCall(() => surface(db, { action: "create", domain: "not_a_domain", sender_name: "N", from_email: "n@not_a_domain" }));
    const missingName = await captureCall(() => surface(db, { action: "create", domain: "example.com", sender_name: "", from_email: "n@example.com" }));
    const mismatch = await captureCall(() => surface(db, { action: "create", domain: "example.com", sender_name: "N", from_email: "no-reply@other.com" }));
    const unknownAction = await captureCall(() => surface(db, { action: "explode" }));
    harness.check("invalid create inputs and unknown actions are refused 400 BEFORE the API is called",
      badDomain.code === "EMAIL_DOMAIN_INVALID" && missingName.code === "EMAIL_SENDER_NAME_REQUIRED" &&
      mismatch.code === "EMAIL_FROM_DOMAIN_MISMATCH" && unknownAction.code === "EMAIL_DOMAIN_ACTION_UNKNOWN" &&
      apiCalls() === reqsBefore,
      { badDomain: badDomain.code, missingName: missingName.code, mismatch: mismatch.code, unknownAction: unknownAction.code, api_calls: apiCalls() - reqsBefore });

    // ---- 4. create: dns_records verbatim + persistence --------------------------------------
    const created1 = await surface(db, { action: "create", domain: "example.com", sender_name: "Nordwind Furniture", from_email: "no-reply@example.com" });
    const stored = (await rows(proj.id)).find((r) => r.domain === "example.com");
    harness.check("create returns the API response verbatim and persists dns_records byte-equal",
      JSON.stringify(created1.email_domain.dns_records) === JSON.stringify(FIXTURE_CREATE.dns_records) &&
      created1.email_domain.status === "pending_user_dns_configuration" && created1.email_domain.external === true &&
      created1.email_domain.provider_id === "godaddy" && !!stored &&
      JSON.stringify(stored.dns_records) === JSON.stringify(FIXTURE_CREATE.dns_records) &&
      stored.email_domain_id === FIXTURE_CREATE.email_domain_id,
      { status: created1.email_domain.status, stored: !!stored });

    // ---- 5. before `active`: standard 1-credit rate -----------------------------------------
    let before = (await poolBalance(db, A.ws.id, "integration")).balance;
    const sendStd = await sendEmail(sendStub(), proj.id, { to: ["a@x.com"], subject: "s", text: "hi" }, { transport: "platform" });
    let after = await poolBalance(db, A.ws.id, "integration");
    harness.check("a send while the domain is pending charges the standard 1 credit",
      sendStd.delivered === 1 && after.balance === before - 1 && after.reserved === 0,
      { charged: before - after.balance, reserved: after.reserved });

    // ---- 6. replace: second configuration in flight -----------------------------------------
    const replaced = await surface(db, { action: "replace", domain: "mail.example.com", sender_name: "Nordwind Furniture", from_email: "no-reply@mail.example.com" });
    const twoRows = (await rows(proj.id)).length;
    harness.check("replace persists the replacement alongside the incumbent (two in flight)",
      replaced.email_domain.domain === "mail.example.com" && replaced.email_domain.external === false &&
      JSON.stringify(replaced.email_domain.dns_records) === JSON.stringify(FIXTURE_REPLACE.dns_records) && twoRows === 2,
      { domain: replaced.email_domain.domain, rows: twoRows });

    // ---- 7. list sync: verbatim statuses, pruning of what the API stopped returning ---------
    const listed = await surface(db, { action: "list" });
    const afterList = await rows(proj.id);
    const example = afterList.find((r) => r.domain === "example.com");
    harness.check("list syncs configuration_status verbatim and prunes unlisted rows",
      listed.email_domains.length === 1 && example && example.status === "active" &&
      JSON.stringify(example.dns_records) === JSON.stringify(FIXTURE_LIST.email_domains[0].dns_records) &&
      example.enabled_at === "2026-08-20T16:31:00" && afterList.length === 1,
      { rows: afterList.length, status: example?.status });

    // ---- 8. active custom-domain send: 2 credits per delivered email ------------------------
    // The single choke point: OTP / password-reset / invitation sends all route through
    // sendEmail (appRuntime + appAuth wiring), so this check covers those paths too.
    before = (await poolBalance(db, A.ws.id, "integration")).balance;
    const coreBefore = coreSeen.length;
    const sendCustom = await sendEmail(sendStub(), proj.id, { to: ["a@x.com", "b@x.com"], subject: "s", text: "hi" }, { transport: "platform" });
    after = await poolBalance(db, A.ws.id, "integration");
    harness.check("while `active`, 2 delivered emails charge exactly 4 credits",
      sendCustom.delivered === 2 && coreSeen.length === coreBefore + 2 &&
      after.balance === before - 4 && after.reserved === 0,
      { charged: before - after.balance, delivered: sendCustom.delivered, reserved: after.reserved });

    // ---- 9. configure / re-check: status + last_check verbatim ------------------------------
    const configured = await surface(db, { action: "configure", domain: "example.com" });
    const afterConfig = (await rows(proj.id)).find((r) => r.domain === "example.com");
    harness.check("configure persists configuration_status and last_check verbatim",
      configured.email_domain.status === "pending_domain_verification" &&
      afterConfig.status === "pending_domain_verification" &&
      afterConfig.last_check === "2026-08-26T09:12:44",
      { status: afterConfig.status, last_check: afterConfig.last_check });

    // ---- 10. after configure (no longer active): standard rate returns ----------------------
    before = (await poolBalance(db, A.ws.id, "integration")).balance;
    await sendEmail(sendStub(), proj.id, { to: ["a@x.com"], subject: "s", text: "hi" }, { transport: "platform" });
    after = await poolBalance(db, A.ws.id, "integration");
    harness.check("a non-active status falls back to the standard 1-credit rate",
      after.balance === before - 1 && after.reserved === 0,
      { charged: before - after.balance });

    // ---- 11. disable: API + mirror both cleared ---------------------------------------------
    const disabled = await surface(db, { action: "disable" });
    const afterDisable = await rows(proj.id);
    const activeAfter = await activeEmailDomain(db, proj.id);
    harness.check("disable clears the mirror and the sending-capability lookup",
      disabled.disabled === true && afterDisable.length === 0 && !activeAfter,
      { rows: afterDisable.length, active: !!activeAfter });

    // ---- 12. insufficient credits: refused BEFORE the provider ------------------------------
    const C = await makeBillingWorkspace(db, created, `edbroke${stamp}`, { plan: null });
    const projC = await db.entities.Project.create({ workspace_id: C.ws.id, name: `edcert-broke-${stamp}` });
    projects.push(projC.id);
    await db.entities.EmailDomain.create({ project_id: projC.id, workspace_id: C.ws.id, domain: "example.com", email_domain_id: "68b1c0d4e7b91d003c45a1f2", status: "active" });
    const coreBeforeBroke = coreSeen.length;
    const broke = await captureCall(() => sendEmail(sendStub(), projC.id, { to: ["a@x.com"], subject: "s", text: "hi" }, { transport: "platform" }));
    harness.check("insufficient integration credits refuse 402 BEFORE any email is delivered",
      broke.threw && broke.code === "INSUFFICIENT_CREDITS" && broke.status === 402 && coreSeen.length === coreBeforeBroke,
      { code: broke.code, core_calls: coreSeen.length - coreBeforeBroke });

    // ---- 13. API failures relay verbatim, no persistence change -----------------------------
    const failingFetch = async () => { throw new Error("network down"); };
    const unreachable = await captureCall(() => emailDomainSurface(db, { token: "pat_cert", app_id: "app_cert_1", action: "list", project_id: proj.id, fetchImpl: failingFetch }));
    const refusingFetch = async () => new Response(JSON.stringify({ detail: { message: "This domain is registered to another workspace" } }), { status: 409, headers: { "Content-Type": "application/json" } });
    const refused = await captureCall(() => emailDomainSurface(db, { token: "pat_cert", app_id: "app_cert_1", action: "create", domain: "example.com", sender_name: "N", from_email: "no-reply@example.com", project_id: proj.id, workspace_id: A.ws.id, fetchImpl: refusingFetch }));
    const rowsAfterFailures = (await rows(proj.id)).length;
    harness.check("API failures relay the documented verdict and change no persisted state",
      unreachable.threw && unreachable.code === "BASE44_API_UNREACHABLE" && unreachable.status === 502 &&
      refused.threw && refused.code === "BASE44_API_ERROR" && refused.status === 409 &&
      String(refused.message).includes("registered to another workspace") && rowsAfterFailures === 0,
      { unreachable: unreachable.code, refused: refused.status, rows: rowsAfterFailures });

    // ---- 14. ledger integrity ---------------------------------------------------------------
    const integrityA = await verifyBalanceIntegrity(db, A.ws.id);
    const integrityC = await verifyBalanceIntegrity(db, C.ws.id);
    harness.check("ledger integrity holds for both workspaces",
      integrityA.ok && integrityC.ok, { A: integrityA.ok, C: integrityC.ok });

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(db, "EmailDomain", { project_id: pid });
      await purgeBy(db, "AppRecord", { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}
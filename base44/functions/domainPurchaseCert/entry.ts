// Focused certification for the standalone GoDaddy domain-purchase flow.
//
// Drives the REAL surface module (domainPurchaseSurface), the REAL GodaddyRegistration
// persistence, the REAL CustomDomain attachment (createDomainWithinLimit) and the REAL
// runtime resolution primitives (resolveHostname). Only ONE boundary is stubbed, with
// recorders: fetch → replays DOCUMENTED v3 example responses (check-availability with
// per-term pricing, suggestions, registration-quotes with requiredAgreements, the 202
// registration with CONFIRMED + operationId, operations polling, zone DNS record create).
//
// Certified: action whitelist; fail-closed missing credential; validation BEFORE any
// network call; search (exact + suggestions, taken names stay clean); quote (offer view
// with agreements, quote token persisted SERVER-side only, idempotent re-quote, unavailable
// → clean no-row answer, fees captured); register (Idempotency-Key minted and sent, consent
// agreementTypes match the quote, acknowledgedFees passthrough for fee'd quotes, pending
// re-register doesn't re-POST); poll (registering → connected, CNAME provisioned to the
// serving host, CustomDomain created ACTIVE with verified_at, expiry captured); human
// failure mapping (taken at register, expired offer, NO_PAYMENT_PROFILE keeps the offer
// retryable); cross-project isolation; dns_provision retry; CustomDomain regression
// (external TXT-challenge domains keep their verification-gated resolution); no internal
// registrar state ever leaks into a view.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { resolveHostname } from "../../shared/domains.ts";
import { domainPurchaseSurface, GODADDY_ACTIONS, SERVING_HOST } from "../../shared/godaddyApi.ts";
import { apiJson } from "../../shared/certStubs.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];
  const plans = [];

  // --- fixtures: DOCUMENTED v3 example responses, keyed per domain -------------------------
  const D1 = `cert${stamp}a.com`;        // happy path
  const TAKEN = `cert${stamp}taken.com`; // unavailable everywhere
  const PREMIUM = `cert${stamp}prem.com`;// carries purchase fees
  const SNIPED = `cert${stamp}snip.com`; // available at quote, taken at execute
  const EXPIRED = `cert${stamp}old.com`; // offer expires before execute
  const NOPAY = `cert${stamp}nopay.com`; // account has no payment profile
  const SUG1 = `cert${stamp}alt1.com`;
  const SUG2 = `cert${stamp}alt2.net`;
  const EXPIRES = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const AGREEMENTS = [{ agreementType: "API_DPA", title: "Domain Name Registration Agreement", url: "https://www.godaddy.com/agreements" }];

  const seen = [];
  const regBodies = [];
  const idemKeys = [];
  const dnsBodies = [];
  const pollScript = {
    [`op_${D1}`]: { script: ["CONFIRMED", { status: "COMPLETED", result: { expiresAt: EXPIRES, orderId: "ord_1" } }], i: 0 },
  };
  const gdStubFetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    seen.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname.endsWith("/check-availability")) {
      const d = u.searchParams.get("domain");
      if (d === TAKEN) return apiJson(200, { domain: d, available: false, definitive: true });
      return apiJson(200, { domain: d, available: true, definitive: false, inventory: "REGISTRY", prices: [{ term: "YEAR", period: 1, price: { currencyCode: "USD", value: 1199 }, renewalPrice: { currencyCode: "USD", value: 2299 } }] });
    }
    if (u.pathname.endsWith("/suggestions")) return apiJson(200, [{ domain: SUG1 }, { domain: SUG2 }]);
    if (u.pathname.endsWith("/registration-quotes")) {
      const b = JSON.parse(init.body);
      if (b.domain === TAKEN) return apiJson(200, { domain: b.domain, available: false });
      const fees = b.domain === PREMIUM ? [{ type: "ONE_TIME_PREMIUM_DOMAIN_PURCHASE", fee: { currencyCode: "USD", value: 390000 } }] : [];
      return apiJson(200, {
        quoteToken: `qt_${b.domain}`, expiresAt: new Date(Date.now() + 600000).toISOString(),
        domain: b.domain, available: true, period: b.period,
        price: { currencyCode: "USD", value: 1199 }, renewalPrice: { currencyCode: "USD", value: 2299 },
        requiredAgreements: AGREEMENTS, irreversible: false, fees, inventory: "REGISTRY",
        resolved: { contactSource: "ACCOUNT", registrantSummary: "Cert Tester", autoRenew: b.profile?.autoRenew, privacy: true },
      });
    }
    if (u.pathname.endsWith("/registrations")) {
      const b = JSON.parse(init.body);
      idemKeys.push(init.headers["Idempotency-Key"]);
      regBodies.push(b);
      if (b.domain === SNIPED) return apiJson(409, { code: "DOMAIN_NOT_AVAILABLE", message: "The requested domain is not available" });
      if (b.domain === NOPAY) return apiJson(422, { code: "NO_PAYMENT_PROFILE", message: "Shopper does not have a payment profile" });
      return apiJson(202, { registrationId: `reg_${b.domain}`, domain: b.domain, period: b.period, status: "CONFIRMED", operationId: `op_${b.domain}`, createdAt: new Date().toISOString() });
    }
    if (u.pathname.includes("/operations/")) {
      const opId = u.pathname.split("/").pop();
      const s = pollScript[opId];
      const next = s ? s.script[Math.min(s.i, s.script.length - 1)] : { status: "CONFIRMED" };
      if (s) s.i += 1;
      return apiJson(200, { operationId: opId, type: "REGISTER", domain: "x", status: next.status, ...(next.result ? { result: next.result } : {}), ...(next.error ? { error: next.error } : {}) });
    }
    if (u.pathname.includes("/zones/") && method === "POST") {
      dnsBodies.push(JSON.parse(init.body));
      return apiJson(201, { recordId: "rec_1" });
    }
    return apiJson(404, { code: "NOT_FOUND", message: "unrouted" });
  };

  let proj = null;
  let A = null;
  const godaddyRows = (projectId) => db.entities.GodaddyRegistration.filter({ project_id: projectId }, "-created_date", 50);
  const gdSurface = (svc, over = {}) => domainPurchaseSurface(svc, { token: "pat_cert", project_id: proj.id, workspace_id: A.ws.id, added_by: "cert_user", fetchImpl: gdStubFetch, ...over });
  const allViews = [];

  try {
    // A plan that allows custom domains — the free plan's custom_domains limit is 0.
    const plan = await db.entities.BillingPlan.create({ code: `gd_cert_${stamp}`, name: "GD Cert Plan", active: true, limits: { custom_domains: 10 } });
    plans.push(plan.id);
    A = await makeBillingWorkspace(db, created, `gdcert${stamp}`, { plan });
    proj = await db.entities.Project.create({ workspace_id: A.ws.id, name: `gdcert-proj-${stamp}` });
    projects.push(proj.id);

    // ---- 1. action whitelist + fail-closed credential ---------------------------------------
    harness.check("the surface exposes exactly the documented purchase actions",
      JSON.stringify(GODADDY_ACTIONS) === JSON.stringify(["search", "quote", "register", "poll", "resume", "dns_provision"]),
      { actions: GODADDY_ACTIONS });
    const noToken = await captureCall(() => domainPurchaseSurface(db, { token: null, action: "search", query: "x.com" }));
    harness.check("a missing GoDaddy credential refuses 503 before anything runs",
      noToken.threw && noToken.status === 503 && noToken.code === "GODADDY_SECRET_NOT_CONFIGURED",
      { code: noToken.code, status: noToken.status });

    // ---- 2. validation BEFORE any network call ----------------------------------------------
    const reqsBefore = seen.length;
    const unknownAction = await captureCall(() => gdSurface(db, { action: "explode" }));
    const emptySearch = await captureCall(() => gdSurface(db, { action: "search", query: "  " }));
    harness.check("unknown actions and empty searches are refused 400 BEFORE the API is called",
      unknownAction.code === "DOMAIN_PURCHASE_ACTION_UNKNOWN" && emptySearch.code === "SEARCH_QUERY_REQUIRED" && seen.length === reqsBefore,
      { unknown: unknownAction.code, empty: emptySearch.code, api_calls: seen.length - reqsBefore });

    // ---- 3. search: exact + suggestions, taken names stay clean ------------------------------
    const s1 = await gdSurface(db, { action: "search", query: D1 });
    allViews.push(s1);
    harness.check("search returns the exact name with a 1-year price plus checked suggestions",
      s1.results[0]?.domain === D1 && s1.results[0]?.available === true && s1.results[0]?.price?.value === 1199 &&
      s1.results.some((r) => r.domain === SUG1 && r.available) && s1.results.some((r) => r.domain === SUG2 && r.available),
      { results: s1.results.length });
    const s2 = await gdSurface(db, { action: "search", query: TAKEN });
    allViews.push(s2);
    harness.check("a taken exact name reads as unavailable, not as an error",
      s2.results[0]?.domain === TAKEN && s2.results[0]?.available === false,
      { available: s2.results[0]?.available });

    // ---- 4. quote: offer view, server-side-only token, idempotent re-quote -------------------
    const q1 = await gdSurface(db, { action: "quote", domain: D1, period: 1, auto_renew: true });
    allViews.push(q1.registration);
    const stored1 = (await godaddyRows(proj.id)).find((r) => r.domain === D1);
    harness.check("quote returns an offer view with the agreements and stores the token server-side only",
      q1.available === true && q1.registration.stage === "offer" && q1.registration.period === 1 &&
      q1.registration.price?.value === 1199 &&
      JSON.stringify(q1.registration.agreements) === JSON.stringify([{ agreement_type: "API_DPA", title: "Domain Name Registration Agreement", url: "https://www.godaddy.com/agreements" }]) &&
      stored1?.quote_token === `qt_${D1}` && !!stored1?.idempotency_key,
      { stage: q1.registration.stage, agreements: q1.registration.agreements?.length });
    const q2 = await gdSurface(db, { action: "quote", domain: D1, period: 1, auto_renew: true });
    harness.check("re-quoting the same domain + period reuses the SAME offer row (no duplicates)",
      q2.registration.registration_id === q1.registration.registration_id,
      { same_row: q2.registration.registration_id === q1.registration.registration_id });
    const q3 = await gdSurface(db, { action: "quote", domain: TAKEN, period: 1 });
    const takenRows = (await godaddyRows(proj.id)).filter((r) => r.domain === TAKEN);
    harness.check("quoting a taken name returns a clean unavailable answer and persists nothing",
      q3.available === false && !q3.registration && takenRows.length === 0,
      { available: q3.available, rows: takenRows.length });
    const q4 = await gdSurface(db, { action: "quote", domain: PREMIUM, period: 1, auto_renew: true });
    const storedPrem = (await godaddyRows(proj.id)).find((r) => r.domain === PREMIUM);
    harness.check("a fee-carrying quote records the fees verbatim for consent passthrough",
      q4.available === true && JSON.stringify(storedPrem?.fees) === JSON.stringify([{ type: "ONE_TIME_PREMIUM_DOMAIN_PURCHASE", fee: { currencyCode: "USD", value: 390000 } }]),
      { fees: storedPrem?.fees?.length });

    // ---- 5. register: Idempotency-Key, consent match, no double-fire -------------------------
    const regsBefore = seen.filter((k) => k.includes("/registrations")).length;
    const r1 = await gdSurface(db, { action: "register", registration_id: q1.registration.registration_id });
    allViews.push(r1.registration);
    harness.check("register sends the minted Idempotency-Key and the quote-matching consent",
      r1.registration.stage === "registering" &&
      idemKeys[0] && idemKeys[0].length === 36 && (idemKeys[0].match(/-/g) || []).length === 4 &&
      JSON.stringify(regBodies[0].consent.agreementTypes) === JSON.stringify(["API_DPA"]) &&
      !!regBodies[0].consent.agreedAt && !!regBodies[0].quoteToken &&
      JSON.stringify(regBodies[0].profile) === JSON.stringify({ autoRenew: true, privacy: true }) &&
      !regBodies[0].consent.acknowledgedFees,
      { stage: r1.registration.stage, idem: idemKeys[0] });
    await gdSurface(db, { action: "register", registration_id: q1.registration.registration_id });
    const regsAfter = seen.filter((k) => k.includes("/registrations")).length;
    harness.check("re-registering an in-flight purchase does NOT re-call the registrar",
      regsAfter === regsBefore + 1, { register_calls: regsAfter - regsBefore });

    // ---- 6. poll: registering → connected (DNS + active CustomDomain) ------------------------
    const p1 = await gdSurface(db, { action: "poll", registration_id: q1.registration.registration_id });
    allViews.push(p1.registration);
    harness.check("a non-terminal operation polls as still registering",
      p1.registration.stage === "registering" && !p1.registration.error,
      { stage: p1.registration.stage });
    const p2 = await gdSurface(db, { action: "poll", registration_id: q1.registration.registration_id });
    allViews.push(p2.registration);
    const cd1 = (await db.entities.CustomDomain.filter({ project_id: proj.id }, "-created_date", 50)).find((d) => d.hostname === D1);
    const completedRow = (await godaddyRows(proj.id)).find((r) => r.domain === D1);
    harness.check("a COMPLETED operation provisions the serving CNAME, attaches the domain ACTIVE and stores the expiry",
      p2.registration.stage === "connected" && p2.registration.connected === "active" &&
      p2.registration.expires_at === EXPIRES &&
      JSON.stringify(dnsBodies[0]) === JSON.stringify({ type: "CNAME", name: "@", data: SERVING_HOST, ttl: 3600 }) &&
      cd1?.status === "active" && !!cd1?.verified_at && cd1?.project_id === proj.id &&
      completedRow?.status === "completed" && completedRow?.dns_ok === true,
      { stage: p2.registration.stage, dns: dnsBodies[0]?.name, custom: cd1?.status });

    // ---- 7. fee'd consent passthrough --------------------------------------------------------
    await gdSurface(db, { action: "register", registration_id: q4.registration.registration_id });
    const premBody = regBodies.find((b) => b.domain === PREMIUM);
    harness.check("a fee-carrying registration passes the fees verbatim as acknowledgedFees",
      JSON.stringify(premBody?.consent.acknowledgedFees) === JSON.stringify([{ type: "ONE_TIME_PREMIUM_DOMAIN_PURCHASE", fee: { currencyCode: "USD", value: 390000 } }]),
      { acknowledged: !!premBody?.consent.acknowledgedFees });

    // ---- 8. human failure mapping ------------------------------------------------------------
    const q5 = await gdSurface(db, { action: "quote", domain: SNIPED, period: 1, auto_renew: true });
    const sniped = await captureCall(() => gdSurface(db, { action: "register", registration_id: q5.registration.registration_id }));
    const snipedRow = (await godaddyRows(proj.id)).find((r) => r.domain === SNIPED);
    harness.check("a name sniped between quote and execute reads as a human 'taken' error",
      sniped.threw && String(sniped.message).includes("just taken") && snipedRow?.status === "failed",
      { message: sniped.message, status: snipedRow?.status });
    const q6 = await gdSurface(db, { action: "quote", domain: EXPIRED, period: 1, auto_renew: true });
    await db.entities.GodaddyRegistration.update(q6.registration.registration_id, { quote_expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await captureCall(() => gdSurface(db, { action: "register", registration_id: q6.registration.registration_id }));
    const expiredRow = (await godaddyRows(proj.id)).find((r) => r.domain === EXPIRED);
    harness.check("an expired offer fails closed with a human 'search again' error",
      expired.threw && String(expired.message).includes("expired") && expiredRow?.status === "failed",
      { message: expired.message, status: expiredRow?.status });
    const q7 = await gdSurface(db, { action: "quote", domain: NOPAY, period: 1, auto_renew: true });
    const nopay = await captureCall(() => gdSurface(db, { action: "register", registration_id: q7.registration.registration_id }));
    const nopayRow = (await godaddyRows(proj.id)).find((r) => r.domain === NOPAY);
    harness.check("a missing payment profile is a human error and KEEPS the offer retryable",
      nopay.threw && String(nopay.message).includes("payment method") && nopayRow?.status === "quoted",
      { message: nopay.message, status: nopayRow?.status });

    // ---- 9. cross-project isolation ----------------------------------------------------------
    const proj2 = await db.entities.Project.create({ workspace_id: A.ws.id, name: `gdcert-proj2-${stamp}` });
    projects.push(proj2.id);
    const foreign = await captureCall(() => domainPurchaseSurface(db, { token: "pat_cert", project_id: proj2.id, workspace_id: A.ws.id, action: "poll", registration_id: q1.registration.registration_id, fetchImpl: gdStubFetch }));
    harness.check("another project cannot read or resume this project's registration",
      foreign.threw && foreign.status === 404 && foreign.code === "REGISTRATION_NOT_FOUND",
      { code: foreign.code, status: foreign.status });

    // ---- 10. dns_provision retry -------------------------------------------------------------
    await db.entities.CustomDomain.update(cd1.id, { status: "error", last_error: "simulated dns failure" });
    const dnsBefore = dnsBodies.length;
    const retried = await gdSurface(db, { action: "dns_provision", registration_id: q1.registration.registration_id });
    const cdAfter = await db.entities.CustomDomain.get(cd1.id);
    harness.check("a failed connect is retryable and restores the domain to active",
      retried.registration.connected === "active" && cdAfter.status === "active" && dnsBodies.length === dnsBefore + 1,
      { connected: retried.registration.connected, dns_calls: dnsBodies.length - dnsBefore });

    // ---- 11. CustomDomain regression: external TXT-challenge domains are untouched ------------
    const ext = `ext${stamp}check.com`;
    const externalRow = await db.entities.CustomDomain.create({
      project_id: proj.id, hostname: ext, environment: "production", status: "pending_verification",
      verification_method: "dns_txt", verification_host: `_nexus-verify.${ext}`, verification_token: "tok", is_primary: false,
    });
    const unverified = await resolveHostname(db, ext);
    await db.entities.CustomDomain.update(externalRow.id, { status: "active", verified_at: new Date().toISOString() });
    const verified = await resolveHostname(db, ext);
    harness.check("the runtime still resolves ONLY verified domains — bought domains ride the same primitive",
      !unverified && verified?.project_id === proj.id && verified?.environment === "production",
      { unverified: !unverified, verified: !!verified });

    // ---- 12. no registrar internals ever reach a view -----------------------------------------
    const blob = JSON.stringify(allViews);
    harness.check("no view ever carries the quote token, operation id or Idempotency-Key",
      !blob.includes("qt_") && !blob.includes("op_") && !blob.includes("Idempotency") && !blob.includes("registrationId"),
      { leaked: ["qt_", "op_", "Idempotency"].filter((k) => blob.includes(k)) });

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(db, "GodaddyRegistration", { project_id: pid });
      await purgeBy(db, "CustomDomain", { project_id: pid });
      await purgeBy(db, "AuditLog", { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const planId of plans) {
      await db.entities.BillingPlan.delete(planId).catch(() => {});
    }
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}
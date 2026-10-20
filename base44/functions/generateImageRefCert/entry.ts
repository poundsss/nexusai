// Targeted certification for the DOCUMENTED Base44 `Core.GenerateImage` reference-image
// parameter `existing_image_urls` (appIntegrations → primitive executor → platform provider).
//
// Drives the REAL bridge dispatch (handleAppIntegrations), the REAL primitive executor
// (invokePrimitive: contract validation, hold/settle/release) and the REAL canonical credit
// ledger; only the platform image-provider boundary is stubbed (mediaIntegrationCert pattern),
// with call counters so "refused BEFORE the provider" is an assertion, not an assumption.
//
// Certified:
//   • existing_image_urls: [url] reaches Core.GenerateImage unchanged and returns { url };
//   • exactly 1 integration credit is held and settled for a valid request (0 reserved after);
//   • more than 3 reference URLs → the existing PRIMITIVE_INPUT_INVALID 400 BEFORE the provider
//     call, zero credit movement;
//   • a reference URL longer than 2000 chars → the same fail-closed refusal, zero movement;
//   • a non-array existing_image_urls preserves the CURRENT behavior (silently dropped, the
//     call succeeds on the prompt alone, 1 credit);
//   • the deployed runtime exposes the same behavior: the SAME invalid shapes are refused 400
//     with PRIMITIVE_INPUT_INVALID through the REAL public-runtime HTTP surface with zero
//     credit movement (the deployed SUCCESS path is deliberately not driven — it would invoke
//     the real image provider);
//   • an unknown integration operation is still refused unchanged;
//   • existing GenerateImage behavior WITHOUT existing_image_urls is unchanged;
//   • ledger integrity holds.
//
// NOT verified here (left UNKNOWN, per instructions): Base44's own server-side limits on
// existing_image_urls, and the documented unreadable-reference degradation semantics — both
// live behind the REAL platform provider, which this cert never calls.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { grantIntegrationCredits, integrationPoolBalance, integrationBridge, runtimeIntegrationsCall } from "../../shared/integrationCertHelpers.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];

  // Stubbed platform image provider. The bridge, primitive executor, holds and ledger are the
  // REAL ones; only the provider boundary is faked, with counters and an argument recorder.
  const calls = { image: 0 };
  const seen = [];
  const flags = { fail: false };
  const stub = {
    entities: db.entities,
    integrations: { Core: {
      GenerateImage: async (p) => {
        calls.image++; seen.push(p);
        if (flags.fail) throw new Error("image provider timed out");
        return { url: `https://cdn.test/image-${calls.image}.png` };
      },
    } },
  };

  const grant = (wsId, n) => grantIntegrationCredits(db, wsId, n, `imgref:${wsId}:${stamp}`, "GenerateImage ref cert grant");
  const intOf = (wsId) => integrationPoolBalance(db, wsId);
  const bridge = (project, op, args) => integrationBridge(stub, project, op, args);

  try {
    const A = await makeBillingWorkspace(db, created, `imgref${stamp}`, { plan: null });
    await grant(A.ws.id, 200);
    const proj = await db.entities.Project.create({ workspace_id: A.ws.id, name: `imgref-proj-${stamp}` });
    projects.push(proj.id);

    // ---- 1. existing_image_urls: [url] forwarded VERBATIM, { url } returned, 1 credit -------
    let before = (await intOf(A.ws.id)).balance;
    const ref = "https://cdn.test/reference-1.png";
    const img = await bridge(proj, "GenerateImage", { prompt: "edit this image", existing_image_urls: [ref] });
    let after = await intOf(A.ws.id);
    harness.check("existing_image_urls: [url] reaches Core.GenerateImage unchanged, returns { url }, and charges exactly 1 integration credit",
      calls.image === 1 && img.url === "https://cdn.test/image-1.png" &&
      Array.isArray(seen[0].existing_image_urls) && seen[0].existing_image_urls.length === 1 &&
      seen[0].existing_image_urls[0] === ref && seen[0].prompt === "edit this image" &&
      after.balance === before - 1 && after.reserved === 0,
      { sent: seen[0], charged: before - after.balance, reserved: after.reserved });

    // ---- 2. more than 3 reference URLs → 400 BEFORE the provider, zero credit movement ------
    const fourRefs = ["https://cdn.test/r1.png", "https://cdn.test/r2.png", "https://cdn.test/r3.png", "https://cdn.test/r4.png"];
    before = (await intOf(A.ws.id)).balance;
    const tooMany = await captureCall(() => bridge(proj, "GenerateImage", { prompt: "too many refs", existing_image_urls: fourRefs }));
    after = await intOf(A.ws.id);
    harness.check("more than 3 reference URLs is refused 400 PRIMITIVE_INPUT_INVALID before the provider call with zero credit movement",
      tooMany.threw && tooMany.status === 400 && tooMany.code === "PRIMITIVE_INPUT_INVALID" &&
      calls.image === 1 && after.balance === before && after.reserved === 0,
      { code: tooMany.code, provider_calls: calls.image, credit_delta: after.balance - before, reserved: after.reserved });

    // ---- 3. a reference URL longer than 2000 chars → 400 BEFORE the provider -----------------
    const longUrl = "https://cdn.test/" + "a".repeat(1984);
    before = (await intOf(A.ws.id)).balance;
    const longRef = await captureCall(() => bridge(proj, "GenerateImage", { prompt: "long url", existing_image_urls: [longUrl] }));
    after = await intOf(A.ws.id);
    harness.check("a reference URL longer than 2000 chars is refused 400 PRIMITIVE_INPUT_INVALID before the provider call with zero credit movement",
      longUrl.length === 2001 && longRef.threw && longRef.status === 400 && longRef.code === "PRIMITIVE_INPUT_INVALID" &&
      calls.image === 1 && after.balance === before && after.reserved === 0,
      { url_length: longUrl.length, code: longRef.code, credit_delta: after.balance - before });

    // ---- 4. non-array existing_image_urls preserves the CURRENT behavior (silently dropped) --
    before = (await intOf(A.ws.id)).balance;
    const asString = await bridge(proj, "GenerateImage", { prompt: "string ref", existing_image_urls: "https://cdn.test/not-an-array.png" });
    const asObject = await bridge(proj, "GenerateImage", { prompt: "object ref", existing_image_urls: { url: "https://cdn.test/no.png" } });
    after = await intOf(A.ws.id);
    harness.check("a non-array existing_image_urls preserves the current behavior: silently dropped, the call succeeds on the prompt alone and charges 1 credit",
      asString.url === "https://cdn.test/image-2.png" && asObject.url === "https://cdn.test/image-3.png" &&
      seen[1] && seen[1].existing_image_urls === undefined && seen[1].prompt === "string ref" &&
      seen[2] && seen[2].existing_image_urls === undefined && seen[2].prompt === "object ref" &&
      calls.image === 3 && after.balance === before - 2 && after.reserved === 0,
      { dropped: [seen[1]?.existing_image_urls === undefined, seen[2]?.existing_image_urls === undefined], charged: before - after.balance });

    // ---- 5. baseline regression: GenerateImage WITHOUT existing_image_urls is unchanged ------
    before = (await intOf(A.ws.id)).balance;
    const base = await bridge(proj, "GenerateImage", { prompt: "a simple flat blue circle on white background" });
    after = await intOf(A.ws.id);
    harness.check("existing GenerateImage behavior without existing_image_urls is unchanged",
      base.url === "https://cdn.test/image-4.png" && seen[3] && seen[3].existing_image_urls === undefined &&
      calls.image === 4 && after.balance === before - 1 && after.reserved === 0,
      { sent: seen[3], charged: before - after.balance });

    // ---- 6. unknown integration operation is still refused unchanged --------------------------
    const unknown = await captureCall(() => bridge(proj, "NotAnOperation", {}));
    harness.check("an unknown integration operation is still refused unchanged",
      unknown.threw && unknown.code === "INTEGRATION_OP_UNSUPPORTED" && unknown.status === 400,
      { code: unknown.code, status: unknown.status });

    // ---- 7. deployed runtime exposes the same behavior (REAL public-runtime HTTP surface) ----
    // Only the REFUSAL paths are driven: a valid deployed call would invoke the REAL image
    // provider, which this cert must never do. Validation runs BEFORE any provider call, so
    // the deployed invalid calls prove the same fail-closed behavior with zero credit movement.
    const me = await createClientFromRequest(req).auth.me();
    const dep = await createDeployedApp(db, {
      rls_enabled: true,
      workspace_id: A.ws.id, name: `imgref-rt-${stamp}`, slug: `imgrefrt-${stamp}`, deployed_by: me?.id || A.user.id,
      on_project_created: (p) => projects.push(p.id),
    });
    harness.check("the deployed app fixture reached a live deployment", dep.run.status === "LIVE",
      { status: dep.run.status });
    const endUser = await signUpWithSession(db, dep.project.id, { email: `rt-${stamp}@imgref.test`, password: "Sup3r-Secret-ImageRef-1", full_name: "RT User" }, {});
    const rt = appRuntimeCaller(db);
    const rtCall = (op, args) => runtimeIntegrationsCall(rt, dep.project.slug, op, args, endUser.token);
    before = (await intOf(A.ws.id)).balance;
    const dTooMany = await rtCall("GenerateImage", { prompt: "x", existing_image_urls: fourRefs });
    const dLongRef = await rtCall("GenerateImage", { prompt: "x", existing_image_urls: [longUrl] });
    after = await intOf(A.ws.id);
    harness.check("the deployed runtime refuses the same invalid existing_image_urls shapes 400 PRIMITIVE_INPUT_INVALID with zero credit movement",
      dTooMany.status === 400 && dTooMany.data.code === "PRIMITIVE_INPUT_INVALID" &&
      dLongRef.status === 400 && dLongRef.data.code === "PRIMITIVE_INPUT_INVALID" &&
      after.balance === before && after.reserved === 0,
      { too_many: dTooMany.data.code, long_url: dLongRef.data.code, credit_delta: after.balance - before });

    // ---- 8. ledger integrity -------------------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds for the charged workspace", integrity.ok, { ok: integrity.ok });

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      for (const entity of ["Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile", "FunctionInvocation", "PrimitiveInvocation", "IntegrationInvocation", "AIOperation", "ScheduledTrigger"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}
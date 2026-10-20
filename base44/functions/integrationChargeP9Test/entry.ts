// P-9.2 regression suite: flat integration-credit charges for the five Base44-VERIFIED
// platform-service operations — GenerateImage, ExtractDataFromUploadedFile (ExtractStructuredData
// file path), SendEmail, SendPushNotification, UploadFile. Only published rates (1 credit per
// image / call / email / notification / upload); no rate is invented here.
//
// Drives the REAL handlers, the REAL messaging/file primitives and the REAL canonical ledger —
// only the provider boundary is stubbed (with call counters, so "fail-closed BEFORE the provider"
// is an assertion, not an assumption) — and asserts:
//   • a successful operation charges EXACTLY the published rate from the workspace integration pool;
//   • a workspace without integration credits is refused fail-closed BEFORE the provider runs;
//   • a failed provider call / delivery charges nothing and leaves no hold;
//   • a replayed operation (same invocation key) charges once, never twice;
//   • the message pool is never touched by any of these charges;
//   • one workspace's operations never move another workspace's credits;
//   • an operation against an unknown project (a verification namespace) charges nobody.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";
import { PRIMITIVE_HANDLERS } from "../../shared/primitiveHandlers.ts";
import { resolvePrimitive } from "../../shared/primitiveContract.ts";
import { sendEmail, sendPush } from "../../shared/appMessaging.ts";
import { uploadFile, FILES_ENTITY } from "../../shared/appFiles.ts";
import { USERS_ENTITY } from "../../shared/appAuth.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];
  const unknownProject = `verify_p92_missing_${stamp}`;

  // Stubbed platform providers. Handlers and ledger are the REAL ones; only the provider
  // boundary is faked, with counters proving fail-closed happens before it.
  const calls = { image: 0, extract: 0, email: 0, push: 0, upload: 0 };
  const flags = { image_fail: false, extract_fail: false, upload_fail: false, reject_email: null };
  const stub = {
    entities: db.entities,
    integrations: { Core: {
      GenerateImage: async () => { calls.image++; if (flags.image_fail) throw new Error("image provider unavailable"); return { url: `https://cdn.test/img-${calls.image}.png` }; },
      ExtractDataFromUploadedFile: async () => { calls.extract++; if (flags.extract_fail) throw new Error("extraction provider unavailable"); return { status: "success", output: { title: "Invoice", total: 42 } }; },
      SendEmail: async ({ to }) => { calls.email++; if (flags.reject_email && (flags.reject_email === "*" || to === flags.reject_email)) throw new Error("smtp rejected the recipient"); return {}; },
      SendPushNotification: async () => { calls.push++; return {}; },
      UploadPrivateFile: async () => { calls.upload++; if (flags.upload_fail) throw new Error("storage unavailable"); return { file_uri: `private://p92-${calls.upload}` }; },
      CreateFileSignedUrl: async () => ({ signed_url: "https://signed.test/f", expires_in: 300 }),
    } },
  };

  const grant = (wsId, pool, n) => grantTestPool(db, { workspace_id: wsId, pool, amount: n, key: `p92:${pool}:${wsId}:${stamp}`, reason: "P-9.2 test grant" });
  const intOf = (wsId) => poolBalance(db, wsId, "integration");
  const msgOf = (wsId) => poolBalance(db, wsId, "message");

  const ctxFor = (name, { project, ws, input, invocation_id }) => ({
    base44: db, svc: stub, project: { ...project, rls_enabled: false }, workspace: ws, user: null, end_user: null,
    contract: resolvePrimitive(name), input, trace_id: `p92-${stamp}`, run_id: null,
    invocation_id, idempotency_key: null, options: {},
  });

  try {
    // ---- fixtures: A funded (100 integration / 50 message), B funded but untouched, C broke (0/0)
    const A = await makeBillingWorkspace(db, created, `p92a${stamp}`, { plan: null });
    const B = await makeBillingWorkspace(db, created, `p92b${stamp}`, { plan: null });
    const C = await makeBillingWorkspace(db, created, `p92c${stamp}`, { plan: null });
    await grant(A.ws.id, "integration", 100);
    await grant(A.ws.id, "message", 50);
    await grant(B.ws.id, "integration", 10);
    await grant(B.ws.id, "message", 50);

    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p92-proj-a-${stamp}` });
    const projC = await db.entities.Project.create({ workspace_id: C.ws.id, name: `p92-proj-c-${stamp}` });
    projects.push(projA.id, projC.id);

    const fileRow = await db.entities.AppRecord.create({
      project_id: projA.id, entity_name: FILES_ENTITY,
      data: { filename: "invoice.pdf", content_type: "application/pdf", size: 100, file_uri: "private://fixture", uploaded_at: new Date().toISOString() },
    });
    const userRow = await db.entities.AppRecord.create({ project_id: projA.id, entity_name: USERS_ENTITY, data: { email: "user@test.io", platform_user_id: "pu_1" } });
    const userNoDevice = await db.entities.AppRecord.create({ project_id: projA.id, entity_name: USERS_ENTITY, data: { email: "nodevice@test.io" } });
    const userC = await db.entities.AppRecord.create({ project_id: projC.id, entity_name: USERS_ENTITY, data: { email: "c@test.io", platform_user_id: "pu_c" } });

    const extractSchema = { type: "object", properties: { title: { type: "string" }, total: { type: "number" } }, required: ["title", "total"] };

    // ---- 1. GenerateImage: success charges exactly 1 integration credit ------------------------
    let t = await intOf(A.ws.id);
    const img = await PRIMITIVE_HANDLERS["GenerateImage@1.0.0"](ctxFor("GenerateImage", {
      project: projA, ws: A.ws, input: { prompt: "a red cube" }, invocation_id: `p92-img-${stamp}`,
    }));
    let after = await intOf(A.ws.id);
    harness.check("GenerateImage success charges exactly 1 integration credit and leaves no hold",
      img.credits_charged === 1 && after.balance === t.balance - 1 && after.reserved === 0,
      { charged: img.credits_charged, before: t.balance, after: after.balance, reserved: after.reserved });

    // ---- 2. Replayed invocation (same key) charges once, never twice ---------------------------
    const imgReplay = await PRIMITIVE_HANDLERS["GenerateImage@1.0.0"](ctxFor("GenerateImage", {
      project: projA, ws: A.ws, input: { prompt: "a red cube" }, invocation_id: `p92-img-${stamp}`,
    }));
    after = await intOf(A.ws.id);
    harness.check("replayed GenerateImage invocation (same key) charges nothing extra",
      imgReplay.credits_charged === 0 && after.balance === t.balance - 1 && after.reserved === 0,
      { charged: imgReplay.credits_charged, balance: after.balance, expected_once: t.balance - 1 });

    // ---- 3. Provider failure: 0 charge, hold released ------------------------------------------
    t = await intOf(A.ws.id);
    flags.image_fail = true;
    const imgFail = await captureCall(() => PRIMITIVE_HANDLERS["GenerateImage@1.0.0"](ctxFor("GenerateImage", {
      project: projA, ws: A.ws, input: { prompt: "a blue cube" }, invocation_id: `p92-imgf-${stamp}`,
    })));
    flags.image_fail = false;
    after = await intOf(A.ws.id);
    harness.check("GenerateImage provider failure charges 0 and releases the reservation",
      imgFail.threw && imgFail.code === "PROVIDER_ERROR" && after.balance === t.balance && after.reserved === 0,
      { threw: imgFail.threw, code: imgFail.code, before: t.balance, after: after.balance });

    // ---- 4. Fail-closed: no integration credits → refused BEFORE the provider ------------------
    const imageCallsBefore = calls.image;
    const imgBroke = await captureCall(() => PRIMITIVE_HANDLERS["GenerateImage@1.0.0"](ctxFor("GenerateImage", {
      project: projC, ws: C.ws, input: { prompt: "no funds" }, invocation_id: `p92-imgc-${stamp}`,
    })));
    const brokeC = await intOf(C.ws.id);
    harness.check("GenerateImage without integration credits is refused fail-closed before the provider call",
      imgBroke.threw && imgBroke.code === "INSUFFICIENT_CREDITS" && calls.image === imageCallsBefore &&
      brokeC.balance === 0 && brokeC.reserved === 0,
      { threw: imgBroke.threw, code: imgBroke.code, provider_calls: calls.image - imageCallsBefore, balance: brokeC.balance });

    // ---- 5. ExtractStructuredData (file path): success charges exactly 1 ------------------------
    t = await intOf(A.ws.id);
    const ext = await PRIMITIVE_HANDLERS["ExtractStructuredData@1.0.0"](ctxFor("ExtractStructuredData", {
      project: projA, ws: A.ws, input: { file_id: fileRow.id, schema: extractSchema }, invocation_id: `p92-ext-${stamp}`,
    }));
    after = await intOf(A.ws.id);
    harness.check("file extraction success charges exactly 1 integration credit and leaves no hold",
      ext.credits_charged === 1 && after.balance === t.balance - 1 && after.reserved === 0 &&
      ext.output?.data?.title === "Invoice",
      { charged: ext.credits_charged, before: t.balance, after: after.balance, data: JSON.stringify(ext.output?.data || null) });

    // ---- 6. Extraction provider failure: 0 charge, hold released -------------------------------
    t = await intOf(A.ws.id);
    flags.extract_fail = true;
    const extFail = await captureCall(() => PRIMITIVE_HANDLERS["ExtractStructuredData@1.0.0"](ctxFor("ExtractStructuredData", {
      project: projA, ws: A.ws, input: { file_id: fileRow.id, schema: extractSchema }, invocation_id: `p92-extf-${stamp}`,
    })));
    flags.extract_fail = false;
    after = await intOf(A.ws.id);
    harness.check("file extraction failure charges 0 and releases the reservation",
      extFail.threw && extFail.code === "PROVIDER_ERROR" && after.balance === t.balance && after.reserved === 0,
      { threw: extFail.threw, code: extFail.code, before: t.balance, after: after.balance });

    // ---- 7. SendEmail: 1 credit per DELIVERED email ---------------------------------------------
    t = await intOf(A.ws.id);
    const sent3 = await sendEmail(stub, projA.id, { to: ["a@t.io", "b@t.io", "c@t.io"], subject: "P-9.2", text: "hello" }, { transport: "platform" });
    after = await intOf(A.ws.id);
    harness.check("SendEmail charges 1 integration credit per delivered email (3 delivered = 3)",
      sent3.delivered === 3 && after.balance === t.balance - 3 && after.reserved === 0,
      { delivered: sent3.delivered, before: t.balance, after: after.balance });

    t = await intOf(A.ws.id);
    flags.reject_email = "b@t.io";
    const sent2 = await sendEmail(stub, projA.id, { to: ["a@t.io", "b@t.io", "c@t.io"], subject: "P-9.2", text: "hello" }, { transport: "platform" });
    flags.reject_email = null;
    after = await intOf(A.ws.id);
    harness.check("SendEmail charges only the emails actually delivered (2 of 3)",
      sent2.delivered === 2 && after.balance === t.balance - 2 && after.reserved === 0,
      { delivered: sent2.delivered, before: t.balance, after: after.balance });

    t = await intOf(A.ws.id);
    flags.reject_email = "*";
    const sent0 = await sendEmail(stub, projA.id, { to: ["a@t.io"], subject: "P-9.2", text: "hello" }, { transport: "platform" });
    flags.reject_email = null;
    after = await intOf(A.ws.id);
    harness.check("SendEmail where nothing was delivered charges 0 and releases the hold",
      sent0.delivered === 0 && after.balance === t.balance && after.reserved === 0,
      { delivered: sent0.delivered, before: t.balance, after: after.balance });

    // ---- 8. SendEmail fail-closed: no credits → refused before any send ------------------------
    const emailCallsBefore = calls.email;
    const sentBroke = await captureCall(() => sendEmail(stub, projC.id, { to: ["x@t.io"], subject: "P-9.2", text: "hello" }, { transport: "platform" }));
    harness.check("SendEmail without integration credits is refused fail-closed before any send",
      sentBroke.threw && sentBroke.code === "INSUFFICIENT_CREDITS" && calls.email === emailCallsBefore,
      { threw: sentBroke.threw, code: sentBroke.code, sends_attempted: calls.email - emailCallsBefore });

    // ---- 9. SendEmail against an unknown project (verification namespace) charges nobody ------
    const balancesBefore = {};
    for (const id of [A.ws.id, B.ws.id, C.ws.id]) balancesBefore[id] = (await intOf(id)).balance;
    const sentUnknown = await sendEmail(stub, unknownProject, { to: ["x@t.io"], subject: "P-9.2", text: "hello" }, { transport: "platform" });
    let chargedNobody = sentUnknown.delivered === 1;
    for (const id of [A.ws.id, B.ws.id, C.ws.id]) chargedNobody = chargedNobody && (await intOf(id)).balance === balancesBefore[id];
    harness.check("SendEmail against an unknown project delivers but charges no workspace",
      chargedNobody, { delivered: sentUnknown.delivered });

    // ---- 10. SendPushNotification: 1 per delivered notification ---------------------------------
    t = await intOf(A.ws.id);
    const pushed = await sendPush(stub, projA.id, { user_id: userRow.id, title: "Hi", content: "P-9.2" }, { transport: "platform" });
    after = await intOf(A.ws.id);
    harness.check("SendPushNotification charges 1 integration credit when delivered",
      pushed.delivered === true && after.balance === t.balance - 1 && after.reserved === 0,
      { delivered: pushed.delivered, before: t.balance, after: after.balance });

    t = await intOf(A.ws.id);
    const pushNoDevice = await sendPush(stub, projA.id, { user_id: userNoDevice.id, title: "Hi", content: "P-9.2" }, { transport: "platform" });
    after = await intOf(A.ws.id);
    harness.check("an undelivered push charges 0 and releases the hold",
      pushNoDevice.delivered === false && after.balance === t.balance && after.reserved === 0,
      { delivered: pushNoDevice.delivered, before: t.balance, after: after.balance });

    const pushCallsBefore = calls.push;
    const pushBroke = await captureCall(() => sendPush(stub, projC.id, { user_id: userC.id, title: "Hi", content: "P-9.2" }, { transport: "platform" }));
    harness.check("SendPushNotification without integration credits is refused before any provider call",
      pushBroke.threw && pushBroke.code === "INSUFFICIENT_CREDITS" && calls.push === pushCallsBefore,
      { threw: pushBroke.threw, code: pushBroke.code, sends_attempted: calls.push - pushCallsBefore });

    // ---- 11. UploadFile: 1 credit per successful upload -------------------------------------------
    t = await intOf(A.ws.id);
    const up = await uploadFile(stub, projA.id, { filename: "a.png", content_type: "image/png", content_base64: btoa("pngbytes") });
    after = await intOf(A.ws.id);
    harness.check("UploadFile charges exactly 1 integration credit on success",
      up.size === 8 && after.balance === t.balance - 1 && after.reserved === 0,
      { before: t.balance, after: after.balance, size: up.size });

    t = await intOf(A.ws.id);
    flags.upload_fail = true;
    const upFail = await captureCall(() => uploadFile(stub, projA.id, { filename: "b.png", content_type: "image/png", content_base64: btoa("x") }));
    flags.upload_fail = false;
    after = await intOf(A.ws.id);
    harness.check("UploadFile storage failure charges 0 and releases the reservation",
      upFail.threw && after.balance === t.balance && after.reserved === 0,
      { threw: upFail.threw, code: upFail.code, before: t.balance, after: after.balance });

    const uploadCallsBefore = calls.upload;
    const upBroke = await captureCall(() => uploadFile(stub, projC.id, { filename: "c.png", content_type: "image/png", content_base64: btoa("x") }));
    harness.check("UploadFile without integration credits is refused before storage is touched",
      upBroke.threw && upBroke.code === "INSUFFICIENT_CREDITS" && calls.upload === uploadCallsBefore,
      { threw: upBroke.threw, code: upBroke.code, uploads_attempted: calls.upload - uploadCallsBefore });

    // ---- 12. Message pool untouched; workspace isolation; ledger integrity ----------------------
    const msgA = await msgOf(A.ws.id);
    const msgB = await msgOf(B.ws.id);
    const msgC = await msgOf(C.ws.id);
    const intB = await intOf(B.ws.id);
    const finalA = await intOf(A.ws.id);
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("all integration charges left the message pool untouched (A: 50, B: 50, C: 0)",
      msgA.balance === 50 && msgB.balance === 50 && msgC.balance === 0,
      { msgA: msgA.balance, msgB: msgB.balance, msgC: msgC.balance });
    harness.check("workspace isolation: untouched B kept its 10 integration credits, C stayed at 0",
      intB.balance === 10 && (await intOf(C.ws.id)).balance === 0,
      { B: intB.balance, C: (await intOf(C.ws.id)).balance });
    harness.check("A's integration balance spent exactly the verified rates (100 − 9 = 91), no stranded holds",
      finalA.balance === 91 && finalA.reserved === 0,
      { balance: finalA.balance, reserved: finalA.reserved });
    harness.check("ledger integrity: A's cached projection matches the derived ledger",
      integrity.ok, { ok: integrity.ok, cached: JSON.stringify(integrity.cached) });

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(db, "AppRecord", { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    await purgeBy(db, "AppRecord", { project_id: unknownProject });
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}
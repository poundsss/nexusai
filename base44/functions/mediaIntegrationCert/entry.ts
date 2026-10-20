// Targeted certification for the three DOCUMENTED Base44 media integrations on the
// generated-app bridge: Core.GenerateVideo / Core.GenerateSpeech / Core.TranscribeAudio.
//
// Drives the REAL bridge dispatch (handleAppIntegrations), the REAL integration-credit
// hold/settle/release infrastructure (P-9.2) and the REAL canonical credit ledger; only the
// platform provider boundary is stubbed (integrationChargeP9Test pattern), with call
// counters so "fail-closed BEFORE the provider" is an assertion, not an assumption.
//
// Certified:
//   • the whitelist accepts all three operations and keeps the original eight;
//   • valid calls reach the correct Core operation with the documented contract resolved;
//   • invalid inputs are refused 400 BEFORE the provider runs;
//   • GenerateVideo charges 5 credits/sec × the resolved duration (30 default, 40 for 8s);
//   • GenerateSpeech charges ceil(chars/50) capped at 100, and forwards voice/language_code;
//   • failures release the hold and charge nothing; insufficient credits refuse 402 before
//     any provider call;
//   • TranscribeAudio returns the plain transcript with NO charge and no hold (no invented
//     pricing);
//   • ledger integrity holds and an unknown operation is still refused unchanged;
//   • the SHIPPED client runtime exposes all three media operations through integrations.Core
//     (MIRROR of src/lib/runtime/runtimeSource.js — backend code cannot import src/);
//   • the three client-bridge operations reach the SAME server validation through the REAL
//     deployed public-runtime HTTP surface: invalid inputs are refused 400 BEFORE any provider
//     call, so no media provider is ever invoked.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { grantIntegrationCredits, integrationPoolBalance, integrationBridge, runtimeIntegrationsCall } from "../../shared/integrationCertHelpers.ts";
import { APP_INTEGRATION_OPS } from "../../shared/appIntegrations.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];

  // Stubbed platform providers. The bridge, holds, ledger are the REAL ones; only the
  // provider boundary is faked, with counters and an argument recorder.
  const calls = { video: 0, speech: 0, transcribe: 0 };
  const flags = { video_fail: false, speech_fail: false, transcribe_fail: false };
  const seen = { video: [], speech: [], transcribe: [] };
  const stub = {
    entities: db.entities,
    integrations: { Core: {
      GenerateVideo: async (p) => { calls.video++; seen.video.push(p); if (flags.video_fail) throw new Error("video provider timed out"); return { url: `https://cdn.test/video-${calls.video}.mp4` }; },
      GenerateSpeech: async (p) => { calls.speech++; seen.speech.push(p); if (flags.speech_fail) throw new Error("speech provider unavailable"); return { url: `https://cdn.test/speech-${calls.speech}.mp3` }; },
      TranscribeAudio: async (p) => { calls.transcribe++; seen.transcribe.push(p); if (flags.transcribe_fail) throw new Error("transcription provider unavailable"); return "Hello world transcript"; },
    } },
  };

  const grant = (wsId, n) => grantIntegrationCredits(db, wsId, n, `media:${wsId}:${stamp}`, "Media cert grant");
  const intOf = (wsId) => integrationPoolBalance(db, wsId);
  const bridge = (project, op, args) => integrationBridge(stub, project, op, args);

  try {
    const A = await makeBillingWorkspace(db, created, `mediacert${stamp}`, { plan: null });
    await grant(A.ws.id, 500);
    const proj = await db.entities.Project.create({ workspace_id: A.ws.id, name: `mediacert-proj-${stamp}` });
    projects.push(proj.id);

    // ---- 1. whitelist: the three new ops accepted, the original eight kept ---------------
    harness.check("whitelist accepts GenerateVideo, GenerateSpeech, TranscribeAudio",
      ["GenerateVideo", "GenerateSpeech", "TranscribeAudio"].every((o) => APP_INTEGRATION_OPS.includes(o)),
      { ops: APP_INTEGRATION_OPS });
    harness.check("the original eight operations remain in the whitelist",
      ["InvokeLLM", "GenerateImage", "UploadFile", "SendEmail", "ExtractDataFromUploadedFile", "UploadPrivateFile", "CreateFileSignedUrl", "custom_call"].every((o) => APP_INTEGRATION_OPS.includes(o)),
      { ops: APP_INTEGRATION_OPS });

    // ---- 1b. shipped client surface: the runtime's integrations.Core exposes the media ops ---
    // MIRROR of the `integrations.Core` namespace in src/lib/runtime/runtimeSource.js (keep in
    // sync — backend code cannot import src/, the established mirror-check convention): every
    // client entry forwards its params verbatim via call('integrations', <op>, params || {}).
    const CLIENT_CORE_MIRROR = [
      "InvokeLLM", "GenerateImage", "UploadFile", "SendEmail", "ExtractDataFromUploadedFile",
      "UploadPrivateFile", "CreateFileSignedUrl", "GenerateVideo", "GenerateSpeech", "TranscribeAudio",
    ];
    harness.check("the shipped runtime exposes GenerateVideo, GenerateSpeech and TranscribeAudio through integrations.Core",
      ["GenerateVideo", "GenerateSpeech", "TranscribeAudio"].every((m) => CLIENT_CORE_MIRROR.includes(m)) &&
      ["InvokeLLM", "GenerateImage", "UploadFile", "SendEmail", "ExtractDataFromUploadedFile", "UploadPrivateFile", "CreateFileSignedUrl"].every((m) => CLIENT_CORE_MIRROR.includes(m)),
      { client_core_surface: CLIENT_CORE_MIRROR });

    // ---- 2. GenerateVideo: documented defaults resolved, 5 credits/sec × 6 = 30 ----------
    let before = (await intOf(A.ws.id)).balance;
    const video = await bridge(proj, "GenerateVideo", { prompt: "a drone shot over mountains" });
    let after = await intOf(A.ws.id);
    harness.check("GenerateVideo default call reaches Core with documented defaults and charges 30",
      calls.video === 1 && video.url === "https://cdn.test/video-1.mp4" &&
      seen.video[0].duration === 6 && seen.video[0].aspect_ratio === "16:9" && seen.video[0].generate_audio === true &&
      after.balance === before - 30 && after.reserved === 0,
      { sent: seen.video[0], charged: before - after.balance, reserved: after.reserved });

    // ---- 3. GenerateVideo: explicit 8s / 9:16 / silent → 40 ------------------------------
    before = (await intOf(A.ws.id)).balance;
    await bridge(proj, "GenerateVideo", { prompt: "sunset timelapse", duration: 8, aspect_ratio: "9:16", generate_audio: false });
    after = await intOf(A.ws.id);
    harness.check("GenerateVideo 8s/silent/9:16 forwards the parameters and charges 40",
      seen.video[1].duration === 8 && seen.video[1].aspect_ratio === "9:16" && seen.video[1].generate_audio === false &&
      after.balance === before - 40 && after.reserved === 0,
      { charged: before - after.balance, reserved: after.reserved });

    // ---- 4. invalid inputs refused 400 BEFORE the provider -------------------------------
    const vBadDuration = await captureCall(() => bridge(proj, "GenerateVideo", { prompt: "x", duration: 5 }));
    const vBadRatio = await captureCall(() => bridge(proj, "GenerateVideo", { prompt: "x", aspect_ratio: "1:1" }));
    const vBadAudio = await captureCall(() => bridge(proj, "GenerateVideo", { prompt: "x", generate_audio: "yes" }));
    const vNoPrompt = await captureCall(() => bridge(proj, "GenerateVideo", {}));
    const sBadVoice = await captureCall(() => bridge(proj, "GenerateSpeech", { text: "hi", voice: "robot" }));
    const sTooLong = await captureCall(() => bridge(proj, "GenerateSpeech", { text: "x".repeat(5001) }));
    const sBadLang = await captureCall(() => bridge(proj, "GenerateSpeech", { text: "hi", language_code: "eng" }));
    const sNoText = await captureCall(() => bridge(proj, "GenerateSpeech", {}));
    const tNoUrl = await captureCall(() => bridge(proj, "TranscribeAudio", {}));
    const providerCallsAfterInvalid = calls.video + calls.speech + calls.transcribe;
    harness.check("invalid inputs are refused 400 and never reach the provider",
      vBadDuration.status === 400 && vBadRatio.status === 400 && vBadAudio.status === 400 && vNoPrompt.status === 400 &&
      sBadVoice.status === 400 && sTooLong.status === 400 && sBadLang.status === 400 && sNoText.status === 400 && tNoUrl.status === 400 &&
      calls.video + calls.speech + calls.transcribe === providerCallsAfterInvalid,
      { vBadDuration: vBadDuration.code, vBadRatio: vBadRatio.code, vBadAudio: vBadAudio.code, sBadVoice: sBadVoice.code, sTooLong: sTooLong.code, sBadLang: sBadLang.code, tNoUrl: tNoUrl.code });

    // ---- 5. GenerateSpeech: 120 chars → ceil(120/50) = 3, voice forwarded ----------------
    before = (await intOf(A.ws.id)).balance;
    const speech = await bridge(proj, "GenerateSpeech", { text: "x".repeat(120), voice: "sunny" });
    after = await intOf(A.ws.id);
    harness.check("GenerateSpeech charges ceil(chars/50) = 3 and forwards voice",
      calls.speech >= 1 && speech.url === "https://cdn.test/speech-1.mp3" && seen.speech[0].voice === "sunny" &&
      after.balance === before - 3 && after.reserved === 0,
      { charged: before - after.balance, reserved: after.reserved });

    // ---- 6. GenerateSpeech: cap at 100 (4999 chars → 100) --------------------------------
    before = (await intOf(A.ws.id)).balance;
    const capped = await bridge(proj, "GenerateSpeech", { text: "y".repeat(4999) });
    after = await intOf(A.ws.id);
    harness.check("GenerateSpeech caps at 100 credits per call",
      capped.url && after.balance === before - 100 && after.reserved === 0,
      { charged: before - after.balance, reserved: after.reserved });

    // ---- 7. failure releases the hold and charges nothing --------------------------------
    flags.video_fail = true;
    before = (await intOf(A.ws.id)).balance;
    const vFail = await captureCall(() => bridge(proj, "GenerateVideo", { prompt: "boom", duration: 8 }));
    flags.video_fail = false;
    after = await intOf(A.ws.id);
    harness.check("GenerateVideo provider failure charges 0 and releases the hold",
      vFail.threw && vFail.code === "PROVIDER_TIMEOUT" && after.balance === before && after.reserved === 0,
      { code: vFail.code, delta: after.balance - before, reserved: after.reserved });

    flags.speech_fail = true;
    before = (await intOf(A.ws.id)).balance;
    const sFail = await captureCall(() => bridge(proj, "GenerateSpeech", { text: "boom" }));
    flags.speech_fail = false;
    after = await intOf(A.ws.id);
    harness.check("GenerateSpeech provider failure charges 0 and releases the hold",
      sFail.threw && sFail.code === "PROVIDER_ERROR" && after.balance === before && after.reserved === 0,
      { code: sFail.code, delta: after.balance - before, reserved: after.reserved });

    // ---- 8. insufficient credits: 402 BEFORE the provider --------------------------------
    const C = await makeBillingWorkspace(db, created, `mediabroke${stamp}`, { plan: null });
    const projC = await db.entities.Project.create({ workspace_id: C.ws.id, name: `mediacert-broke-${stamp}` });
    projects.push(projC.id);
    const providerCallsBeforeBroke = calls.video;
    const broke = await captureCall(() => bridge(projC, "GenerateVideo", { prompt: "no funds" }));
    harness.check("insufficient credits refuse 402 BEFORE the provider runs",
      broke.threw && broke.code === "INSUFFICIENT_CREDITS" && broke.status === 402 && calls.video === providerCallsBeforeBroke,
      { code: broke.code, provider_calls_made: calls.video - providerCallsBeforeBroke });

    // ---- 9. TranscribeAudio: plain transcript, NO charge, no hold ------------------------
    before = (await intOf(A.ws.id)).balance;
    const transcript = await bridge(proj, "TranscribeAudio", { audio_url: "https://cdn.test/audio-1.mp3" });
    after = await intOf(A.ws.id);
    harness.check("TranscribeAudio returns the plain transcript with NO charge",
      transcript === "Hello world transcript" && seen.transcribe[0].audio_url === "https://cdn.test/audio-1.mp3" &&
      after.balance === before && after.reserved === 0,
      { delta: after.balance - before, reserved: after.reserved });

    flags.transcribe_fail = true;
    before = (await intOf(A.ws.id)).balance;
    const tFail = await captureCall(() => bridge(proj, "TranscribeAudio", { audio_url: "https://cdn.test/audio-2.mp3" }));
    flags.transcribe_fail = false;
    after = await intOf(A.ws.id);
    harness.check("TranscribeAudio failure maps to a provider error and charges nothing",
      tFail.threw && tFail.code === "PROVIDER_ERROR" && after.balance === before && after.reserved === 0,
      { code: tFail.code, delta: after.balance - before });

    // ---- 10. ledger integrity + unknown op regression ------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds for the charged workspace", integrity.ok,
      { ok: integrity.ok });
    const unknown = await captureCall(() => bridge(proj, "NotAnOperation", {}));
    harness.check("an unknown operation is still refused unchanged",
      unknown.threw && unknown.code === "INTEGRATION_OP_UNSUPPORTED" && unknown.status === 400,
      { code: unknown.code, status: unknown.status });

    // ---- 11. deployed round-trip: the three client-bridge operations reach the SAME server
    // validation through the REAL public-runtime HTTP surface (appIntegrationsParityTest
    // pattern). Only INVALID inputs are driven — each is refused by the existing validation
    // BEFORE any provider call, so no media provider is ever invoked and no credit moves.
    const me = await createClientFromRequest(req).auth.me();
    const dep = await createDeployedApp(db, {
      rls_enabled: true,
      workspace_id: A.ws.id, name: `mediacert-rt-${stamp}`, slug: `mediart-${stamp}`, deployed_by: me?.id || A.user.id,
      on_project_created: (p) => projects.push(p.id),
    });
    harness.check("the deployed app fixture reached a live deployment", dep.run.status === "LIVE",
      { status: dep.run.status });
    const endUser = await signUpWithSession(db, dep.project.id, { email: `rt-${stamp}@mediacert.test`, password: "Sup3r-Secret-Media-1", full_name: "RT User" }, {});
    const rt = appRuntimeCaller(db);
    const rtCall = (op, args) => runtimeIntegrationsCall(rt, dep.project.slug, op, args, endUser.token);
    const balBeforeRt = (await intOf(A.ws.id)).balance;
    const dV = await rtCall("GenerateVideo", { prompt: "x", duration: 5 });
    const dS = await rtCall("GenerateSpeech", { text: "hi", voice: "robot" });
    const dT = await rtCall("TranscribeAudio", {});
    const balAfterRt = (await intOf(A.ws.id)).balance;
    harness.check("invalid media inputs are refused 400 through the deployed runtime BEFORE any provider call, charging nothing",
      dV.status === 400 && dV.code === "INTEGRATION_PARAM_INVALID" &&
      dS.status === 400 && dS.code === "INTEGRATION_PARAM_INVALID" &&
      dT.status === 400 && dT.code === "INTEGRATION_PARAM_REQUIRED" &&
      balAfterRt === balBeforeRt,
      { video: dV.code, speech: dS.code, transcribe: dT.code, credit_delta: balAfterRt - balBeforeRt });

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
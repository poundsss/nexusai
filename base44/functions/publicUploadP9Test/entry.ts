// P-9.7 targeted regression suite: PUBLIC upload parity (Base44 UploadFile analog).
//
// Drives the REAL appFiles handlers, the REAL __files/AppRecord storage contract and the
// REAL canonical P-9.2 charge path (hold → provider → settle / release) — only the storage
// provider boundary is stubbed, with call counters so "fail-closed BEFORE the provider" and
// "replay never re-uploads" are assertions, not assumptions. Asserts:
//   • a successful public upload returns the public storage file_url and metadata;
//   • exactly 1 integration credit per successful upload, hold before, settle after;
//   • the message pool is never touched by any public upload;
//   • no integration credits → refused BEFORE public storage is touched;
//   • provider failure → 0 charge + reservation released;
//   • replayed operation key → same file, no second upload, no second charge;
//   • one workspace's uploads never move another workspace's credits or files;
//   • the private upload path is unchanged (signed-URL only, no public url);
//   • the existing MIME/size/encoding/filename/RLS security checks apply unchanged;
//   • the stored __files metadata row matches what was returned.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";
import {
  uploadFile, uploadPublicFile, getFileMeta, listFiles, accessFile, FILES_ENTITY, MAX_FILE_BYTES,
} from "../../shared/appFiles.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];

  // Only the provider boundary is stubbed; handlers, ledger and storage contract are real.
  const calls = { pub: 0, priv: 0, sign: 0 };
  const flags = { pub_fail: false };
  const stub = {
    entities: db.entities,
    integrations: { Core: {
      UploadPublicFile: async () => {
        calls.pub++;
        if (flags.pub_fail) throw new Error("public storage unavailable");
        const url = `https://cdn.test/pub-${calls.pub}.png`;
        return { file_url: url };
      },
      UploadPrivateFile: async () => { calls.priv++; return { file_uri: `private://p97-${calls.priv}` }; },
      CreateFileSignedUrl: async () => { calls.sign++; return { signed_url: "https://signed.test/f", expires_in: 300 }; },
    } },
  };

  // Balance helpers come from the shared credit-pool test helpers — no local re-implementation.
  const intOf = (wsId) => poolBalance(db, wsId, "integration");
  const msgOf = (wsId) => poolBalance(db, wsId, "message");
  const fileRows = (pid) => db.entities.AppRecord.filter({ project_id: pid, entity_name: FILES_ENTITY }, "-created_date", 500);
  const PNG = "image/png";

  try {
    // ---- fixtures: A funded (100 integration / 50 message), B funded but isolated (10/50), C broke (0/0)
    const A = await makeBillingWorkspace(db, created, `p97a${stamp}`, { plan: null });
    const B = await makeBillingWorkspace(db, created, `p97b${stamp}`, { plan: null });
    const C = await makeBillingWorkspace(db, created, `p97c${stamp}`, { plan: null });
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "integration", amount: 100, key: `p97:int:${A.ws.id}:${stamp}`, reason: "P-9.7 test grant" });
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "message", amount: 50, key: `p97:msg:${A.ws.id}:${stamp}`, reason: "P-9.7 test grant" });
    await grantTestPool(db, { workspace_id: B.ws.id, pool: "integration", amount: 10, key: `p97:int:${B.ws.id}:${stamp}`, reason: "P-9.7 test grant" });
    await grantTestPool(db, { workspace_id: B.ws.id, pool: "message", amount: 50, key: `p97:msg:${B.ws.id}:${stamp}`, reason: "P-9.7 test grant" });

    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p97-proj-a-${stamp}` });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p97-proj-b-${stamp}` });
    const projC = await db.entities.Project.create({ workspace_id: C.ws.id, name: `p97-proj-c-${stamp}` });
    projects.push(projA.id, projB.id, projC.id);

    // ---- 1. Successful public upload → file_url + exactly 1 integration credit --------------
    const opKey = `p97-op-${stamp}`;
    const payload = "public-bytes";
    let t = await intOf(A.ws.id);
    const up = await uploadPublicFile(stub, projA.id, {
      filename: "poster.png", content_type: PNG, content_base64: btoa(payload), idempotency_key: opKey,
    }, { rls: false, user: null });
    let after = await intOf(A.ws.id);
    harness.check("public upload succeeds, returns the storage file_url and charges exactly 1 integration credit",
      typeof up.url === "string" && up.url.startsWith("https://") && up.filename === "poster.png" &&
      up.size === payload.length && after.balance === t.balance - 1 && after.reserved === 0,
      { url: up.url, before: t.balance, after: after.balance, reserved: after.reserved });

    // ---- 2. Message pool untouched by the public upload ------------------------------------
    const msgA1 = await msgOf(A.ws.id);
    harness.check("public upload charges only the integration pool (message pool untouched)",
      msgA1.balance === 50 && msgA1.reserved === 0,
      { message_balance: msgA1.balance, reserved: msgA1.reserved });

    // ---- 3. Metadata integrity: the __files row matches what was returned -------------------
    const rowsAfter1 = await fileRows(projA.id);
    const stored = rowsAfter1.find((r) => r.id === up.id);
    const metaAgain = await getFileMeta(stub, projA.id, up.id, { rls: false, user: null });
    harness.check("stored __files metadata matches the upload (name, type, size, url, visibility, key)",
      !!stored &&
      stored.data.filename === "poster.png" && stored.data.content_type === PNG &&
      stored.data.size === payload.length && stored.data.file_url === up.url &&
      stored.data.visibility === "public" && stored.data.idempotency_key === opKey &&
      metaAgain.url === up.url && stored.owner_id == null,
      { row: JSON.stringify(stored?.data || null), meta_url: metaAgain.url });

    // ---- 4. Replay / idempotency: same key → same file, no re-upload, no double charge --------
    const pubCallsBeforeReplay = calls.pub;
    const rowsBeforeReplay = rowsAfter1.length;
    const replay = await uploadPublicFile(stub, projA.id, {
      filename: "poster.png", content_type: PNG, content_base64: btoa("changed-but-ignored"), idempotency_key: opKey,
    }, { rls: false, user: null });
    const afterReplay = await intOf(A.ws.id);
    const rowsAfterReplay = (await fileRows(projA.id)).length;
    harness.check("replayed operation key returns the SAME file and charges nothing extra",
      replay.id === up.id && replay.url === up.url && calls.pub === pubCallsBeforeReplay &&
      afterReplay.balance === after.balance && afterReplay.reserved === 0 && rowsAfterReplay === rowsBeforeReplay,
      { same_id: replay.id === up.id, provider_calls: calls.pub - pubCallsBeforeReplay, balance: afterReplay.balance, records: rowsAfterReplay });

    // ---- 5. Provider failure → 0 charge + reservation released ------------------------------
    t = await intOf(A.ws.id);
    flags.pub_fail = true;
    const upFail = await captureCall(() => uploadPublicFile(stub, projA.id, {
      filename: "f.png", content_type: PNG, content_base64: btoa("x"),
    }, { rls: false, user: null }));
    flags.pub_fail = false;
    after = await intOf(A.ws.id);
    harness.check("public storage failure charges 0 and releases the reservation",
      upFail.threw && after.balance === t.balance && after.reserved === 0,
      { threw: upFail.threw, code: upFail.code, before: t.balance, after: after.balance });

    // ---- 6. Fail-closed: no integration credits → refused BEFORE public storage -------------
    const pubCallsBeforeBroke = calls.pub;
    const upBroke = await captureCall(() => uploadPublicFile(stub, projC.id, {
      filename: "broke.png", content_type: PNG, content_base64: btoa("x"),
    }, { rls: false, user: null }));
    const brokeC = await intOf(C.ws.id);
    harness.check("public upload without integration credits is refused fail-closed before storage is touched",
      upBroke.threw && upBroke.code === "INSUFFICIENT_CREDITS" && calls.pub === pubCallsBeforeBroke &&
      brokeC.balance === 0 && brokeC.reserved === 0,
      { threw: upBroke.threw, code: upBroke.code, provider_calls: calls.pub - pubCallsBeforeBroke, balance: brokeC.balance });

    // ---- 7. Workspace isolation: B's upload moves only B's credits and stays in B's project ----
    t = await intOf(A.ws.id);
    const tB = await intOf(B.ws.id);
    const upB = await uploadPublicFile(stub, projB.id, {
      filename: "b-file.png", content_type: PNG, content_base64: btoa("b"),
    }, { rls: false, user: null });
    const afterA7 = await intOf(A.ws.id);
    const afterB7 = await intOf(B.ws.id);
    const listA = await listFiles(stub, projA.id, { limit: 100 }, { rls: false, user: null });
    const listB = await listFiles(stub, projB.id, { limit: 100 }, { rls: false, user: null });
    harness.check("workspace isolation: B's upload charges only B and is invisible in A's project",
      afterB7.balance === tB.balance - 1 && afterA7.balance === t.balance &&
      listA.every((f) => f.id !== upB.id) && listB.some((f) => f.id === upB.id),
      { B: { before: tB.balance, after: afterB7.balance }, A_unchanged: afterA7.balance === t.balance, in_B_list: listB.some((f) => f.id === upB.id) });

    // ---- 8. Private upload regression: behavior unchanged (signed URL only, no public url) ----
    t = await intOf(A.ws.id);
    const priv = await uploadFile(stub, projA.id, { filename: "a.png", content_type: PNG, content_base64: btoa("pngbytes") }, { rls: false, user: null });
    after = await intOf(A.ws.id);
    const privRow = (await fileRows(projA.id)).find((r) => r.id === priv.id);
    const privAccess = await accessFile(stub, projA.id, priv.id, { rls: false, user: null });
    harness.check("private upload regression: unchanged path (1 credit, file_uri only, signed URL access, no public url)",
      priv.size === 8 && priv.url === undefined && after.balance === t.balance - 1 &&
      privRow?.data?.file_uri && privRow.data.file_url === undefined &&
      privAccess.url === "https://signed.test/f" && calls.sign === 1,
      { charged: t.balance - after.balance, row_has_uri: !!privRow?.data?.file_uri, signed_url: privAccess.url });

    // ---- 9. Existing MIME / size / encoding / filename / RLS security checks apply ----------
    t = await intOf(A.ws.id);
    const securityBefore = { pub: calls.pub, balance: t.balance };
    const badType = await captureCall(() => uploadPublicFile(stub, projA.id, { filename: "x.zip", content_type: "application/zip", content_base64: btoa("z") }, { rls: false, user: null }));
    const tooBig = await captureCall(() => uploadPublicFile(stub, projA.id, { filename: "big.png", content_type: PNG, content_base64: btoa("x".repeat(MAX_FILE_BYTES + 10)) }, { rls: false, user: null }));
    const empty = await captureCall(() => uploadPublicFile(stub, projA.id, { filename: "e.png", content_type: PNG, content_base64: "" }, { rls: false, user: null }));
    const badB64 = await captureCall(() => uploadPublicFile(stub, projA.id, { filename: "b.png", content_type: PNG, content_base64: "!!!not-base64!!!" }, { rls: false, user: null }));
    const afterSecurity = await intOf(A.ws.id);
    harness.check("security limits unchanged: bad type / oversize / empty / bad encoding rejected before storage, charged nothing",
      badType.threw && badType.code === "FILE_TYPE_REJECTED" &&
      tooBig.threw && tooBig.code === "FILE_TOO_LARGE" &&
      empty.threw && empty.code === "FILE_EMPTY" &&
      badB64.threw && badB64.code === "FILE_INVALID_ENCODING" &&
      calls.pub === securityBefore.pub && afterSecurity.balance === securityBefore.balance && afterSecurity.reserved === 0,
      { codes: [badType.code, tooBig.code, empty.code, badB64.code], provider_calls: calls.pub - securityBefore.pub, balance: afterSecurity.balance });

    // Filename traversal is still sanitized; a public upload under RLS still requires the
    // session user, stamps ownership and keeps another user's file indistinguishable from missing.
    const sanitized = await uploadPublicFile(stub, projA.id, { filename: "../../etc/passwd", content_type: "text/plain", content_base64: btoa("ok") }, { rls: false, user: null });
    const rlsAnon = await captureCall(() => uploadPublicFile(stub, projA.id, { filename: "a.png", content_type: PNG, content_base64: btoa("x") }, { rls: true, user: null }));
    const rlsUp = await uploadPublicFile(stub, projA.id, { filename: "mine.png", content_type: PNG, content_base64: btoa("m") }, { rls: true, user: { id: "u_owner" } });
    const rlsRow = (await fileRows(projA.id)).find((r) => r.id === rlsUp.id);
    const otherUser = await captureCall(() => getFileMeta(stub, projA.id, rlsUp.id, { rls: true, user: { id: "u_other" } }));
    const ownUser = await getFileMeta(stub, projA.id, rlsUp.id, { rls: true, user: { id: "u_owner" } });
    harness.check("filename sanitization and RLS ownership checks are unchanged for public uploads",
      sanitized.filename === "passwd" && rlsAnon.threw && rlsAnon.code === "AUTH_REQUIRED" &&
      rlsRow?.owner_id === "u_owner" && otherUser.threw && otherUser.code === "FILE_NOT_FOUND" &&
      ownUser.url === rlsUp.url,
      { sanitized: sanitized.filename, anon: rlsAnon.code, owner: rlsRow?.owner_id, other_user: otherUser.code });

    // ---- 10. Final pools: message untouched, isolation held, no stranded holds, ledger integrity
    const msgA = await msgOf(A.ws.id);
    const msgB = await msgOf(B.ws.id);
    const msgC = await msgOf(C.ws.id);
    const finalA = await intOf(A.ws.id);
    const finalB = await intOf(B.ws.id);
    const finalC = await intOf(C.ws.id);
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("final state: message pools untouched (A: 50, B: 50, C: 0), B spent only its own upload, no stranded holds",
      msgA.balance === 50 && msgB.balance === 50 && msgC.balance === 0 &&
      finalB.balance === 9 && finalC.balance === 0 && finalA.reserved === 0 && finalB.reserved === 0,
      { msgA: msgA.balance, msgB: msgB.balance, msgC: msgC.balance, intA: finalA.balance, intB: finalB.balance, intC: finalC.balance, reserved: finalA.reserved });
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
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}
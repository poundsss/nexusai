// TEMPORARY certification runner for Launchpad submission Slice 1. Deleted after certification.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { submitLaunchpad, myLaunchpadSubmissions, editLaunchpadSubmission, withdrawLaunchpadSubmission, parseImageDimensions, MAX_MEDIA } from "../../shared/launchpad.ts";



const TAG = `cert3-${Date.now()}`;
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail: String(detail).slice(0, 300) });
const threw = (r, code) => r.threw && (r.code === code);
const capture = async (fn) => { try { return { threw: false, value: await fn() }; } catch (e) { return { threw: true, code: e.code || null, status: e.status || null, message: String(e.message || "") }; } };

// --- minimal PNG encoder (stored-deflate zlib, CRC32 + adler32) ----------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function buildPng(w, h) {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const body = new Uint8Array(4 + data.length); body.set(new TextEncoder().encode(type), 0); body.set(data, 4);
    const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(body));
    return [len, body, crc];
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const stride = 1 + w * 3;
  const raw = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) { const off = y * stride; raw[off] = 0; for (let x = 0; x < w; x++) { const p = off + 1 + x * 3; raw[p] = 200; raw[p + 1] = 30; raw[p + 2] = 90; } }
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const b = raw.slice(i, Math.min(i + 65535, raw.length));
    const head = new Uint8Array(5); head[0] = i + 65535 >= raw.length ? 1 : 0;
    new DataView(head.buffer).setUint16(1, b.length, false); new DataView(head.buffer).setUint16(3, b.length, false);
    blocks.push(head, b);
  }
  const deflate = new Uint8Array(blocks.reduce((n, a) => n + a.length, 0));
  let off = 0; for (const a of blocks) { deflate.set(a, off); off += a.length; }
  const zlib = new Uint8Array(2 + deflate.length + 4);
  zlib[0] = 0x78; zlib[1] = 0x01; zlib.set(deflate, 2);
  new DataView(zlib.buffer).setUint32(2 + deflate.length, adler32(raw));
  const parts = [sig, ...chunk("IHDR", ihdr), ...chunk("IDAT", zlib), ...chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  off = 0; for (const a of parts) { png.set(a, off); off += a.length; }
  return png;
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const created = { ws: [], projects: [], submissions: [], audits: [] };
  const stage = (s) => console.log(`[cert3] stage: ${s}`);
  try {
    stage("start");
    const payload = await req.json().catch(() => ({}));
    if (payload.stop === "init") return Response.json({ ok: true, stage: "init" });
    const userA = { id: `${TAG}-user-a`, email: "a@cert.test" };
    const userB = { id: `${TAG}-user-b`, email: "b@cert.test" };
    const wsA = await svc.entities.Workspace.create({ name: `${TAG}-wsA`, owner_id: userA.id, credits_balance: 0 });
    const wsB = await svc.entities.Workspace.create({ name: `${TAG}-wsB`, owner_id: userB.id, credits_balance: 0 });
    created.ws.push(wsA.id, wsB.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `${TAG}-proj`, status: "ready", version_count: 1, slug: `${TAG}-proj` });
    const projForeign = await svc.entities.Project.create({ workspace_id: wsB.id, name: `${TAG}-foreign`, status: "ready", version_count: 1, slug: `${TAG}-foreign` });
    created.projects.push(projA.id, projForeign.id);
    const versionA = await svc.entities.ProjectVersion.create({ project_id: projA.id, number: 1, message: "initial" });
    if (payload.stop === "setup") return Response.json({ ok: true, ws: [wsA.id, wsB.id], projects: [projA.id, projForeign.id], version: versionA.id });

    const validInput = { project_id: projA.id, tagline: "Cert launch", description: "A certified launch description.", categories: ["productivity"], media: [], terms_accepted: true };

    // 1 — not eligible: no LIVE production deployment
    const beforeLive = await capture(() => submitLaunchpad(base44, userA, validInput));
    check("1 unpublished/non-LIVE project rejected", threw(beforeLive, "NOT_LIVE_IN_PRODUCTION"), beforeLive.code || "no-throw");

    // 2 — cross-workspace authorization
    const foreign = await capture(() => submitLaunchpad(base44, userB, validInput));
    check("2 cross-project access rejected", threw(foreign, "NOT_A_MEMBER") && foreign.status === 403, `${foreign.code || "no-throw"}/${foreign.status}`);

    // staging LIVE alone must not qualify
    const staging = await svc.entities.Deployment.create({ project_id: projA.id, workspace_id: wsA.id, version_id: versionA.id, version_number: 1, environment: "staging", status: "LIVE" });
    const stagingOnly = await capture(() => submitLaunchpad(base44, userA, validInput));
    check("2b staging-only does not qualify", threw(stagingOnly, "NOT_LIVE_IN_PRODUCTION"), stagingOnly.code || "no-throw");
    await svc.entities.Deployment.delete(staging.id);

    // go LIVE in production
    await svc.entities.Deployment.create({ project_id: projA.id, workspace_id: wsA.id, version_id: versionA.id, version_number: 1, environment: "production", status: "LIVE" });
    const liveRow = await svc.entities.Deployment.filter({ project_id: projA.id, environment: "production", status: "LIVE" }, "created_date", 1);
    check("2c LIVE production exists", liveRow.length === 1, liveRow[0]?.id || "none");

    // 3 — validation failures
    const badTagline = await capture(() => submitLaunchpad(base44, userA, { ...validInput, tagline: "x".repeat(201) }));
    const badDescription = await capture(() => submitLaunchpad(base44, userA, { ...validInput, description: "x".repeat(4001) }));
    const badCategories = await capture(() => submitLaunchpad(base44, userA, { ...validInput, categories: ["a", "b", "c", "d"] }));
    const noTerms = await capture(() => submitLaunchpad(base44, userA, { ...validInput, terms_accepted: false }));
    const tooManyMedia = await capture(() => submitLaunchpad(base44, userA, { ...validInput, media: Array.from({ length: MAX_MEDIA + 1 }, () => ({ url: "https://media.base44.com/x.png", kind: "screenshot" })) }));
    const badMediaItem = await capture(() => submitLaunchpad(base44, userA, { ...validInput, media: [{ url: "https://media.base44.com/x.png", kind: "gif" }] }));
    check("3 field/media validation",
      threw(badTagline, "TAGLINE_TOO_LONG") && threw(badDescription, "DESCRIPTION_TOO_LONG") && threw(badCategories, "TOO_MANY_CATEGORIES") &&
      threw(noTerms, "TERMS_REQUIRED") && threw(tooManyMedia, "TOO_MANY_MEDIA") && threw(badMediaItem, "INVALID_MEDIA_ITEM"),
      [badTagline.code, badDescription.code, badCategories.code, noTerms.code, tooManyMedia.code, badMediaItem.code].join(" · "));

    // 4 — successful submission persists
    const submit1 = await submitLaunchpad(base44, userA, validInput);
    const row1 = await svc.entities.LaunchpadSubmission.get(submit1.submission.submission_id);
    created.submissions.push(submit1.submission.submission_id);
    check("4 successful submission persists",
      !submit1.duplicate && row1.status === "submitted" && row1.workspace_id === wsA.id && row1.project_id === projA.id &&
      row1.tagline === "Cert launch" && Array.isArray(row1.categories) && row1.categories.length === 1,
      row1.id);

    // 5 — one active submission per project (repeat submit is a duplicate)
    const submit2 = await submitLaunchpad(base44, userA, validInput);
    const activeRows = await svc.entities.LaunchpadSubmission.filter({ project_id: projA.id, status: "submitted" }, "created_date", 50);
    check("5 one active submission per project", submit2.duplicate === true && submit2.submission.submission_id === submit1.submission.submission_id && activeRows.length === 1,
      `active=${activeRows.length}`);

    // 6 — media E2E: real uploads, server-parsed (skippable via payload.skip_media)
    stage("media-begin");
    if (payload.skip_media) { stage("media-skipped"); return Response.json({ ok: results.every((r) => r.ok), results, skipped: true }); }
    const bigPng = new File([buildPng(1280, 720)], `${TAG}-big.png`, { type: "image/png" });
    const smallPng = new File([buildPng(100, 80)], `${TAG}-small.png`, { type: "image/png" });
    const webmBytes = new Uint8Array(1024); webmBytes.fill(0x1a, 0, 4); webmBytes.set([0x45, 0xdf, 0xa3], 0);
    const tinyWebm = new File([webmBytes], `${TAG}-demo.webm`, { type: "video/webm" });
    const upBig = await svc.integrations.Core.UploadPublicFile({ file: bigPng });
    const upSmall = await svc.integrations.Core.UploadPublicFile({ file: smallPng });
    const upVideo = await svc.integrations.Core.UploadPublicFile({ file: tinyWebm });
    const tooSmall = await capture(() => editLaunchpadSubmission(base44, userA, { project_id: projA.id, submission_id: submit1.submission.submission_id, media: [{ url: upSmall.file_url, kind: "screenshot" }] }));
    check("6a screenshot <1280x720 rejected server-side", threw(tooSmall, "SCREENSHOT_TOO_SMALL"), tooSmall.code || "no-throw");
    const withMedia = await editLaunchpadSubmission(base44, userA, { project_id: projA.id, submission_id: submit1.submission.submission_id, media: [{ url: upBig.file_url, kind: "screenshot" }, { url: upVideo.file_url, kind: "video" }] });
    const rowMedia = await svc.entities.LaunchpadSubmission.get(submit1.submission.submission_id);
    check("6b screenshot dimensions parsed server-side",
      rowMedia.media?.[0]?.width === 1280 && rowMedia.media?.[0]?.height === 720 && rowMedia.media?.[0]?.mime === "image/png" && rowMedia.media?.length === 2,
      JSON.stringify(rowMedia.media?.map((m) => ({ w: m.width, h: m.height, b: m.bytes, m: m.mime }))));
    const videoItem = rowMedia.media?.[1] || {};
    check("6c video type+size probed server-side", videoItem.mime === "video/webm" && Number(videoItem.bytes) === 1024, JSON.stringify({ mime: videoItem.mime, bytes: videoItem.bytes }));
    const junkParse = await capture(() => parseImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6])));
    check("6d pure parser rejects junk", junkParse.threw, junkParse.threw ? "threw" : "no-throw");
    check("6e edit persisted tagline", (await editLaunchpadSubmission(base44, userA, { project_id: projA.id, submission_id: submit1.submission.submission_id, tagline: "Edited tagline" })).submission.tagline === "Edited tagline"
      && (await svc.entities.LaunchpadSubmission.get(submit1.submission.submission_id)).tagline === "Edited tagline", "edit");

    // 7 — my_submissions owner isolation
    const mineA = await myLaunchpadSubmissions(base44, userA);
    const mineB = await myLaunchpadSubmissions(base44, userB);
    check("7 my_submissions owner isolation",
      mineA.submissions.length === 1 && mineB.submissions.length === 0 &&
      mineA.submissions.every((s) => s.workspace_id === wsA.id),
      `A=${mineA.submissions.length}, B=${mineB.submissions.length}`);

    // 8 — withdraw: persists, project untouched, idempotent
    const beforeWithdraw = await svc.entities.Project.get(projA.id);
    const wd = await withdrawLaunchpadSubmission(base44, userA, { project_id: projA.id, submission_id: submit1.submission.submission_id });
    const wdRow = await svc.entities.LaunchpadSubmission.get(submit1.submission.submission_id);
    const afterWithdraw = await svc.entities.Project.get(projA.id);
    const wdAgain = await withdrawLaunchpadSubmission(base44, userA, { project_id: projA.id, submission_id: submit1.submission.submission_id });
    const editAfterWd = await capture(() => editLaunchpadSubmission(base44, userA, { project_id: projA.id, submission_id: submit1.submission.submission_id, tagline: "no" }));
    check("8 withdraw persists without deleting project",
      wd.duplicate === false && wdRow.status === "withdrawn" && !!beforeWithdraw && !!afterWithdraw && beforeWithdraw.id === afterWithdraw.id &&
      wdAgain.duplicate === true && threw(editAfterWd, "ALREADY_WITHDRAWN"),
      `project=${!!afterWithdraw}, row=${wdRow.status}`);

    // 9 — resubmit after withdraw: fresh active row, invariant holds
    const resubmit = await submitLaunchpad(base44, userA, validInput);
    const activeAfter = await svc.entities.LaunchpadSubmission.filter({ project_id: projA.id, status: "submitted" }, "created_date", 50);
    created.submissions.push(resubmit.submission.submission_id);
    check("9 resubmit after withdraw keeps one active", resubmit.duplicate === false && resubmit.submission.submission_id !== submit1.submission.submission_id && activeAfter.length === 1, `active=${activeAfter.length}`);

    // 10 — foreign edit/withdraw reach nothing
    const foreignEdit = await capture(() => editLaunchpadSubmission(base44, userB, { project_id: projA.id, submission_id: resubmit.submission.submission_id, tagline: "stolen" }));
    const foreignWd = await capture(() => withdrawLaunchpadSubmission(base44, userB, { project_id: projA.id, submission_id: resubmit.submission.submission_id }));
    check("10 foreign edit/withdraw rejected", threw(foreignEdit, "NOT_A_MEMBER") && threw(foreignWd, "NOT_A_MEMBER"), `${foreignEdit.code}/${foreignWd.code}`);

    // 11 — audit rows
    const audits = [];
    for (const sid of created.submissions) {
      audits.push(...(await svc.entities.AuditLog.filter({ resource: "LaunchpadSubmission", resource_id: sid }, "-created_date", 20)));
    }
    const actions = new Set(audits.map((a) => a.action));
    check("11 audit records exist", actions.has("launchpad.submitted") && actions.has("launchpad.edited") && actions.has("launchpad.withdrawn") &&
      audits.every((a) => a.workspace_id === wsA.id), [...actions].join(", "));

    stage("done");
    const failed = results.filter((r) => !r.ok);
    return Response.json({ ok: !failed.length, passed: results.length - failed.length, failed });
  } catch (e) {
    return Response.json({ ok: false, results, fatal: String(e?.message || e), stack: String(e?.stack || "").slice(0, 1500) }, { status: 500 });
  } finally {
    for (const sid of created.submissions) await svc.entities.LaunchpadSubmission.delete(sid).catch(() => {});
    for (const pid of created.projects) {
      for (const name of ["Deployment", "ProjectVersion", "ProjectFile", "AuditLog"]) {
        const rows = await svc.entities[name].filter({ project_id: pid }, "created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[name].delete(r.id).catch(() => {});
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.ws) {
      for (const name of ["LaunchpadSubmission", "AuditLog"]) {
        const rows = await svc.entities[name].filter({ workspace_id: wid }, "created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[name].delete(r.id).catch(() => {});
      }
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}
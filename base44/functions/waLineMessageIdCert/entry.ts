// In-memory regression for R-2d: WhatsApp and LINE refuse a processable message with a
// missing/invalid id BEFORE the claim, charge or agent; valid duplicates stay single-processed.
// No database, no provider calls. Test agents reject unlinked senders, so a message that passes
// the claim ends at CHANNEL_NOT_LINKED (before the executor); a duplicate returns { duplicate }.
import { handleWhatsAppUpdate, handleLINEUpdate } from "../../shared/appAgentChannels.ts";

export const config = { method: "POST" };

function stub() {
  const tables = {};
  let seq = 0;
  const table = (name) => ({
    filter: async (q = {}) => (tables[name] || []).filter((r) => Object.entries(q).every(([k, v]) => typeof v !== "object" || v === null ? r[k] === v : true))
      .sort((a, b) => a.created_date.localeCompare(b.created_date)),
    create: async (d) => { const r = { ...d, id: `${name}${++seq}`, created_date: new Date(Date.now() + seq).toISOString() }; (tables[name] ||= []).push(r); return r; },
    update: async (id, d) => { const r = (tables[name] || []).find((x) => x.id === id); Object.assign(r || {}, d); return r; },
    get: async (id) => (tables[name] || []).find((x) => x.id === id) || null,
    delete: async () => ({}),
  });
  return { svc: { entities: new Proxy({}, { get: (_, n) => table(String(n)) }) }, tables };
}

const enc = new TextEncoder();
async function hmac(secret, raw) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b) => btoa(String.fromCharCode(...b));

const project = { id: "p-wl", workspace_id: "w-wl" };
const payload = { agents: [{ name: "a", allow_anonymous_access: false }] };
const http = async () => { throw new Error("no provider call expected"); };
const SECRET = "wl-secret";
const resolveSecret = async () => SECRET;

const waBody = (id) => JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { messages: [{ from: "15550001", type: "text", text: { body: "hi" }, ...(id === undefined ? {} : { id }) }] } }] }] });
const lineBody = (id) => JSON.stringify({ events: [{ type: "message", replyToken: "rt", source: { type: "user", userId: "U1" }, message: { type: "text", text: "hi", ...(id === undefined ? {} : { id }) } }] });

const wa = async (s, id) => { const raw = waBody(id); return handleWhatsAppUpdate(s.svc, { project, payload, agentName: "a", rawBody: raw, update: JSON.parse(raw), signatureHeader: "sha256=" + hex(await hmac(SECRET, raw)), resolveSecret, http }); };
const line = async (s, id) => { const raw = lineBody(id); return handleLINEUpdate(s.svc, { project, payload, agentName: "a", rawBody: raw, update: JSON.parse(raw), signatureHeader: b64(await hmac(SECRET, raw)), resolveSecret, http }); };
const outcome = async (p) => { try { return { v: await p }; } catch (e) { return { code: e?.code || e?.body?.code || String(e?.message || e), status: e?.status }; } };
const passed = (o) => /CHANNEL_NOT_LINKED|not linked/.test(String(o.code));
// Everything except the (already-passed) rate limiter counts as a write after validation.
const writes = (s) => Object.entries(s.tables).filter(([n]) => !/RateLimit/.test(n)).reduce((n, [, rows]) => n + rows.length, 0);

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 240) });
  const bad = [["missing", undefined], ["empty", ""], ["number", 123], ["object", { x: 1 }], ["whitespace", " wamid.1 "], ["oversized", "x".repeat(513)]];

  for (const [ch, fn, code] of [["WhatsApp", wa, "WHATSAPP_MESSAGE_INVALID"], ["LINE", line, "LINE_MESSAGE_INVALID"]]) {
    for (const [label, id] of bad) {
      const s = stub();
      const o = await outcome(fn(s, id));
      add(`${ch}: ${label} id refused 400 before claim/charge/agent`, o.status === 400 && o.code === code && writes(s) === 0, { o, writes: writes(s) });
    }
    const s = stub();
    const first = await outcome(fn(s, "msg.valid.1"));
    const replay = await outcome(fn(s, "msg.valid.1"));
    add(`${ch}: valid message passes the claim`, passed(first), first);
    add(`${ch}: valid duplicate is single-processed`, replay.v?.duplicate === true, replay);
    const s2 = stub();
    const race = await Promise.all([outcome(fn(s2, "msg.race.1")), outcome(fn(s2, "msg.race.1"))]);
    add(`${ch}: concurrent duplicates have exactly one winner`, race.filter(passed).length === 1 && race.filter((o) => o.v?.duplicate).length === 1, race);
  }

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});
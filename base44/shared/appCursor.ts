// Opaque page cursor for the records-mode v2/list page contract (Phase B1).
//
// DOCUMENTED (Base44 SDK 0.8.51, EntityListOptions / EntityPage): `next_cursor` from the
// previous page continues the walk; the token "carries the query, sort and fields of the
// walk, so a later page needs only `cursor` and `limit`"; "Passing a different query, sort
// or fields with a cursor is an error". Base44 publishes NOTHING about the token's format,
// lifetime or error behavior — every choice below is:
//
// NEXUSAI-DERIVED, explicitly NON-PARITY (smallest fail-closed semantics):
//   • format ... a stateless signed envelope  nc1.<b64url(json)>.<b64url(hmac-sha256)>,
//               HMAC-keyed from the EXISTING WORKER_SECRET app secret (no new secret);
//   • TTL .... 24 hours, carried as a signed `exp` so a client cannot extend it;
//   • anchor .. a signed offset — the page re-walks the existing read path from 0 to the
//               offset, so every page passes the SAME read gate / RLS scoping (no snapshot
//               or tombstone machinery is introduced);
//   • errors . malformed, tampered, expired, cross-project and cross-entity tokens are all
//               refused with the SAME structured error, DATABASE_INVALID_CURSOR (HTTP 400),
//               before any storage work — a client never learns WHY a cursor was rejected;
//   • key ..... mint and verify both fail closed (HTTP 503) when WORKER_SECRET is absent.
import { secrets } from "base44:runtime";
import { timingSafeEqual } from "./workerAuth.ts";

export const CURSOR_PREFIX = "nc1";
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OFFSET = 1000000; // signed-anchor bound: an absurd offset is refused cheaply

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text) => {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function cursorKey() {
  const secret = secrets.get("WORKER_SECRET");
  if (!secret) {
    throw Object.assign(new Error("Page cursors are unavailable: the WORKER_SECRET app secret is not configured"), { code: "CURSOR_KEY_UNAVAILABLE", status: 503 });
  }
  return crypto.subtle.importKey(
    "raw", enc.encode(`nexusai:page-cursor:v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

const invalid = (message) => Object.assign(new Error(message), { code: "DATABASE_INVALID_CURSOR", status: 400 });

// Mint a continuation token for one page walk. `state` is JSON-serializable and pinned
// verbatim: { projectId, entity, q, sort, fields, offset } (+ the signed exp added here).
export async function mintPageCursor(state) {
  const key = await cursorKey();
  const payload = b64url(enc.encode(JSON.stringify({ ...state, exp: Date.now() + CURSOR_TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${CURSOR_PREFIX}.${payload}`));
  return `${CURSOR_PREFIX}.${payload}.${b64url(sig)}`;
}

// Verify one token and bind it to the caller's OWN project + entity (both are derived from
// the execution context by the caller — never from the token). Returns the signed state.
export async function verifyPageCursor(token, { projectId, entity }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw invalid("Invalid cursor");
  let state;
  try {
    const key = await cursorKey();
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!timingSafeEqual(b64url(sig), parts[2])) throw invalid("Invalid cursor");
    state = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch (e) {
    throw e && e.code === "DATABASE_INVALID_CURSOR" ? e : invalid("Invalid cursor");
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) throw invalid("Invalid cursor");
  if (typeof state.exp !== "number" || state.exp < Date.now()) throw invalid("Expired cursor");
  if (state.projectId !== projectId || state.entity !== entity) throw invalid("Invalid cursor");
  if (!Number.isInteger(state.offset) || state.offset < 0 || state.offset > MAX_OFFSET) throw invalid("Invalid cursor");
  return state;
}
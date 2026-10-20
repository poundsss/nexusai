// Custom domains for deployed apps.
//
// A hostname only becomes servable after the owner proves control of it by publishing a
// DNS TXT record containing a per-domain challenge. Verification is a REAL DNS lookup over
// DNS-over-HTTPS — there is no "trust the request" path, so a user cannot attach someone
// else's hostname (or hijack another project's domain) by asking nicely.
//
// Resolution is the inverse: the public runtime hands a Host header to resolveHostname and
// gets back the project AND the environment that hostname serves, or nothing at all.
import { normalizeEnvironment } from "./environments.ts";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 8000;
export const VERIFICATION_PREFIX = "_nexus-verify";
export const MAX_DOMAINS_PER_PROJECT = 10;

// Hostnames only: no scheme, port, path, wildcard or trailing dot. Public suffix-ish sanity
// (at least one dot) keeps "localhost" and bare labels out.
const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESERVED_SUFFIXES = ["base44.app", "base44.com", "localhost", "local", "internal", "example.com"];

export function normalizeHostname(input) {
  let host = String(input || "").trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (host.includes(":")) host = host.split(":")[0];
  if (!HOSTNAME_RE.test(host)) throw Object.assign(new Error(`"${input}" is not a valid domain name. Use a hostname like app.example.com.`), { status: 400, code: "INVALID_HOSTNAME" });
  if (host.startsWith("*.")) throw Object.assign(new Error("Wildcard domains are not supported."), { status: 400, code: "INVALID_HOSTNAME" });
  if (RESERVED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw Object.assign(new Error(`"${host}" is a reserved domain and cannot be attached to a project.`), { status: 400, code: "RESERVED_HOSTNAME" });
  }
  return host;
}

export const verificationHost = (hostname) => `${VERIFICATION_PREFIX}.${hostname}`;
export const newVerificationToken = () => `nexus-verify-${crypto.randomUUID().replace(/-/g, "")}`;

// Real DNS TXT lookup. Returns the record strings, or throws a classified error the caller
// turns into a user-facing reason. A lookup failure is never treated as success.
export async function lookupTxtRecords(name, { fetchImpl = fetch } = {}) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/dns-json" }, signal: controller.signal });
    if (!res.ok) throw Object.assign(new Error(`DNS lookup failed (${res.status})`), { code: "DNS_LOOKUP_FAILED" });
    const data = await res.json();
    // NXDOMAIN (3) is the common "record not published yet" case and must read as such.
    if (data.Status === 3) return [];
    if (data.Status !== 0) throw Object.assign(new Error(`DNS lookup failed with status ${data.Status}`), { code: "DNS_LOOKUP_FAILED" });
    return (data.Answer || []).filter((a) => a.type === 16).map((a) => String(a.data || "").replace(/^"|"$/g, "").replace(/"\s+"/g, ""));
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("DNS lookup timed out"), { code: "DNS_TIMEOUT" });
    throw e.code ? e : Object.assign(new Error(`DNS lookup failed: ${e.message}`), { code: "DNS_LOOKUP_FAILED" });
  } finally {
    clearTimeout(timer);
  }
}

// Verifies ONE domain row and persists the outcome. Idempotent: an already-active domain
// re-verifies (so a removed record is caught) but never loses its status on a transient
// lookup failure — only a definitive "record absent" moves it out of active.
export async function verifyDomain(svc, domain, { fetchImpl = fetch } = {}) {
  const now = new Date().toISOString();
  let records = null;
  let failure = null;
  try {
    records = await lookupTxtRecords(domain.verification_host || verificationHost(domain.hostname), { fetchImpl });
  } catch (e) {
    failure = { code: e.code || "DNS_LOOKUP_FAILED", message: e.message };
  }

  if (failure) {
    // Transient infrastructure problem: report it without demoting a live domain.
    const saved = await svc.entities.CustomDomain.update(domain.id, { last_checked_at: now, last_error: failure.message.slice(0, 300) });
    return { ok: false, code: failure.code, status: saved?.status || domain.status, domain: saved || domain };
  }

  const matched = records.some((r) => r.trim() === domain.verification_token);
  if (matched) {
    const saved = await svc.entities.CustomDomain.update(domain.id, { status: "active", verified_at: domain.verified_at || now, last_checked_at: now, last_error: null });
    return { ok: true, code: "VERIFIED", status: "active", domain: saved };
  }
  const message = records.length
    ? `The TXT record on ${domain.verification_host} does not contain this domain's verification token.`
    : `No TXT record found at ${domain.verification_host}. Publish it, then verify again (DNS can take a few minutes).`;
  const saved = await svc.entities.CustomDomain.update(domain.id, { status: "pending_verification", verified_at: null, last_checked_at: now, last_error: message });
  return { ok: false, code: "RECORD_NOT_FOUND", status: "pending_verification", domain: saved, records_found: records.length };
}

// Host → { project_id, environment }. ONLY an active domain resolves, so an unverified or
// removed hostname is indistinguishable from one that was never added.
export async function resolveHostname(svc, host) {
  let hostname;
  try { hostname = normalizeHostname(host); } catch { return null; }
  const rows = await svc.entities.CustomDomain.filter({ hostname, status: "active" }, "-created_date", 2);
  const domain = rows[0];
  if (!domain) return null;
  return { domain, project_id: domain.project_id, environment: normalizeEnvironment(domain.environment) };
}

// The DNS instructions shown to the user. Metadata only — no credential is involved.
export function dnsInstructions(domain) {
  return {
    type: "TXT",
    name: domain.verification_host || verificationHost(domain.hostname),
    value: domain.verification_token,
    note: "Add this TXT record with your DNS provider, then press Verify. Records usually appear within a few minutes.",
  };
}
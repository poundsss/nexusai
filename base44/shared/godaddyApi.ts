// Standalone GoDaddy domain-purchase control plane (Domains v3 quote-execute).
//
// ALL registrar complexity lives here — quote tokens, the Idempotency-Key, operation
// polling, consent agreements, DNS provisioning — and NONE of it reaches the UI. Only
// human-readable offers, stages and errors leave this module:
//   offer → the user is confirming a price · registering → purchase in flight (resumable)
//   connected → registered AND attached to the project · failed → terminal, human error.
// The registrar credential lives only in backend secrets (GODADDY_PAT); it is handed in by
// the calling function and never returned, logged or persisted. Billing is GoDaddy-side:
// purchase/renewal charge the ACCOUNT's payment method on file — no NexusAI credits and no
// per-call payment data are involved.
//
// External (brought-by-user) domains keep the TXT-challenge path — nothing here touches it.

import { normalizeHostname, MAX_DOMAINS_PER_PROJECT } from "./domains.ts";
import { createDomainWithinLimit } from "./planLimits.ts";

const BASE = "https://api.godaddy.com/v3/domains";
// The runtime edge that serves a project's CustomDomain hostnames. A bought domain is
// CNAME'd here by the registrar's own DNS API — no manual instructions are shown.
export const SERVING_HOST = "quick-zip-snap.base44.app";

export const GODADDY_ACTIONS = ["search", "quote", "register", "poll", "resume", "dns_provision"];

// Read-only actions the caller may invoke with the lighter project.read capability.
export const GODADDY_READ_ACTIONS = ["search", "quote"];

// Human copy for a plan that doesn't allow any custom domains (e.g. the free plan).
const PLAN_LIMIT_MESSAGE = "Your plan doesn't include custom domains. Upgrade your plan to connect this domain.";

// Errors the registrar documents by code get exact human copy; everything else stays
// deliberately generic. Raw API messages NEVER reach the UI.
const HUMAN_ERRORS = {
  GODADDY_SECRET_NOT_CONFIGURED: "GoDaddy isn't connected yet. Add a GoDaddy API key in the app's secrets, then try again.",
  NO_PAYMENT_PROFILE: "The GoDaddy account has no payment method on file. Add one in GoDaddy, then try again.",
  quote_expired: "The price offer expired. Search for the domain again to get a fresh price.",
  UNABLE_TO_AUTHENTICATE: "GoDaddy rejected the API key or its permissions. Reconnect the GoDaddy API key in the app's secrets.",
};

export function humanize(status, code, message, path) {
  if (code && HUMAN_ERRORS[code]) return HUMAN_ERRORS[code];
  if (status === 401) return HUMAN_ERRORS.UNABLE_TO_AUTHENTICATE;
  if (status === 403) return "The GoDaddy account isn't allowed to do this. Check the API key's scopes and the account's payment profile.";
  if (status === 409) return String(path).includes("registration") ? "That domain was just taken by someone else. Pick another name." : "GoDaddy says this conflicts with the current state. Try again in a moment.";
  if (status === 429) return "GoDaddy is busy right now. Try again in a moment.";
  return "GoDaddy couldn't complete this. Please try again in a moment.";
}

function err(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// The one HTTP boundary. A transport failure is never treated as success; API errors come
// back as HUMAN errors with the machine code preserved for programmatic handling.
export async function godaddyFetch(token, method, path, body, { fetchImpl = fetch, idempotency_key = null } = {}) {
  if (!token) throw err(503, HUMAN_ERRORS.GODADDY_SECRET_NOT_CONFIGURED, "GODADDY_SECRET_NOT_CONFIGURED");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotency_key) headers["Idempotency-Key"] = idempotency_key;
  let res;
  try {
    res = await fetchImpl(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw err(502, "GoDaddy is unreachable right now. Please try again in a moment.", "GODADDY_UNREACHABLE");
  }
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const code = data?.code || data?.name || null;
    const message = data?.message || (Array.isArray(data?.fields) && data.fields[0]?.message) || null;
    throw Object.assign(new Error(humanize(res.status, code, message, path)), { status: res.status, code: code || `GODADDY_HTTP_${res.status}` });
  }
  return data;
}

// --- views (the ONLY shapes that leave this module) ------------------------------------------

const STAGES = { quoted: "offer", pending: "registering", completed: "connected", failed: "failed" };
const money = (value, currency) => (value == null ? null : { value, currency: currency || "USD" });

function view(r, attached = null) {
  return {
    registration_id: r.id,
    domain: r.domain,
    stage: STAGES[r.status] || "failed",
    period: r.period || 1,
    price: money(r.price_value, r.price_currency),
    renewal_price: money(r.renewal_value, r.renewal_currency),
    agreements: r.agreements || [],
    offer_expires_at: r.quote_expires_at || null,
    auto_renew: !!r.auto_renew,
    error: r.status === "failed" ? (r.error || "Registration failed. Please try again.") : null,
    expires_at: r.expires_at || null,
    connected: attached ? attached.status : null,
  };
}

function entryFromAvailability(a) {
  const price = (a.prices || []).find((p) => p.period === 1) || (a.prices || [])[0] || null;
  return {
    domain: a.domain,
    available: a.available === true,
    price: price ? money(price.price.value, price.price.currencyCode) : null,
    renewal_price: price?.renewalPrice ? money(price.renewalPrice.value, price.renewalPrice.currencyCode) : null,
  };
}

// --- registrar calls ---------------------------------------------------------------------------

const checkAvailability = (token, domain, fetchImpl) =>
  godaddyFetch(token, "GET", `/check-availability?domain=${encodeURIComponent(domain)}&optimizeFor=SPEED`, undefined, { fetchImpl });

// Serving DNS: one CNAME at the apex pointing the bought domain at the runtime edge. A
// registrar that refuses an apex CNAME falls back to www; both failures stay retryable.
async function provisionRecords(token, domain, fetchImpl) {
  for (const name of ["@", "www"]) {
    try {
      await godaddyFetch(token, "POST", `/zones/${encodeURIComponent(domain)}/dns-records`, { type: "CNAME", name, data: SERVING_HOST, ttl: 3600 }, { fetchImpl });
      return { ok: true, name };
    } catch { /* try the next name */ }
  }
  return { ok: false, error: "Connecting the domain to your app failed. You can retry in a moment." };
}

// --- the surface --------------------------------------------------------------------------------

export async function domainPurchaseSurface(svc, input = {}) {
  const action = String(input.action || "");
  if (!GODADDY_ACTIONS.includes(action)) throw err(400, `Unsupported action ${action}`, "DOMAIN_PURCHASE_ACTION_UNKNOWN");
  const token = input.token;
  if (!token) throw err(503, HUMAN_ERRORS.GODADDY_SECRET_NOT_CONFIGURED, "GODADDY_SECRET_NOT_CONFIGURED");
  const fetchImpl = input.fetchImpl || fetch;
  const project_id = input.project_id;
  const workspace_id = input.workspace_id;
  const added_by = input.added_by || null;

  const rowsFor = async () => svc.entities.GodaddyRegistration.filter({ project_id }, "-created_date", 50);
  const loadRow = async (registration_id) => {
    const r = await svc.entities.GodaddyRegistration.get(registration_id).catch(() => null);
    if (!r || r.project_id !== project_id) throw err(404, "Registration not found", "REGISTRATION_NOT_FOUND");
    return r;
  };
  const findAttached = async (hostname) =>
    (await svc.entities.CustomDomain.filter({ hostname }, "-created_date", 5)).find((d) => d.status !== "removed") || null;
  const takenError = (attached) => err(409,
    attached.project_id === project_id ? "That domain is already connected to this project." : "That domain is already in use by another project.",
    attached.project_id === project_id ? "ALREADY_CONNECTED" : "HOSTNAME_TAKEN");

  // SEARCH — availability for the typed name + a few alternatives, each with a 1-year price.
  if (action === "search") {
    const raw = String(input.query || "").trim().toLowerCase();
    if (!raw) throw err(400, "Type a domain name to search.", "SEARCH_QUERY_REQUIRED");
    const looksLikeDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(raw);
    const results = [];
    if (looksLikeDomain) {
      try {
        results.push(entryFromAvailability(await checkAvailability(token, raw, fetchImpl)));
      } catch (e) {
        if (e.code === "GODADDY_UNREACHABLE" || e.code === "GODADDY_SECRET_NOT_CONFIGURED") throw e;
        results.push({ domain: raw, available: null, price: null, renewal_price: null });
      }
    }
    const query = looksLikeDomain ? raw.replace(/\.[^.]+$/, "").replace(/-/g, " ") : raw;
    let suggestions = [];
    try {
      suggestions = (await godaddyFetch(token, "GET", `/suggestions?query=${encodeURIComponent(query)}&pageSize=5`, undefined, { fetchImpl })) || [];
    } catch { suggestions = []; }
    for (const s of suggestions.slice(0, 5)) {
      const d = String(s.domain || "").toLowerCase();
      if (!d || d === raw || results.some((r) => r.domain === d)) continue;
      try { results.push(entryFromAvailability(await checkAvailability(token, d, fetchImpl))); } catch { /* drop uncheckable */ }
    }
    return { query: raw, results };
  }

  // QUOTE — a no-commitment price offer. The quote token is persisted server-side only.
  if (action === "quote") {
    const domain = normalizeHostname(input.domain);
    const period = Math.min(Math.max(Number(input.period) || 1, 1), 10);
    const autoRenew = input.auto_renew !== false;
    const profile = { autoRenew, privacy: true };
    const attached = await findAttached(domain);
    if (attached) throw takenError(attached);
    // Idempotent re-quote: the same domain + period refreshes the SAME offer row.
    const existing = (await rowsFor()).find((r) => r.status === "quoted" && r.period === period && r.domain === domain);
    const quote = await godaddyFetch(token, "POST", "/registration-quotes", { domain, period, profile }, { fetchImpl });
    if (!quote || quote.available === false) {
      // A taken name is a clean answer, not an error. Any stale offer for it is retired.
      if (existing) await svc.entities.GodaddyRegistration.update(existing.id, { status: "failed", error: "That domain was just taken by someone else. Pick another name." });
      return { available: false, domain };
    }
    if (!quote.quoteToken) throw err(502, "GoDaddy didn't return a purchase offer. Please try again.", "QUOTE_TOKEN_MISSING");
    const payload = {
      domain, period, status: "quoted", auto_renew: autoRenew, profile,
      quote_token: quote.quoteToken,
      quote_expires_at: quote.expiresAt || null,
      price_value: quote.price?.value ?? null, price_currency: quote.price?.currencyCode || "USD",
      renewal_value: quote.renewalPrice?.value ?? null, renewal_currency: quote.renewalPrice?.currencyCode || null,
      agreements: (quote.requiredAgreements || []).map((a) => ({ agreement_type: a.agreementType, title: a.title, url: a.url || null })),
      fees: quote.fees || [],
      idempotency_key: existing?.idempotency_key || crypto.randomUUID(),
      error: null,
    };
    const row = existing
      ? await svc.entities.GodaddyRegistration.update(existing.id, payload)
      : await svc.entities.GodaddyRegistration.create({ project_id, workspace_id, ...payload });
    return { available: true, registration: view(row) };
  }

  // REGISTER — executes the offer with the minted Idempotency-Key; safe to retry.
  if (action === "register") {
    const row = await loadRow(input.registration_id);
    if (row.status === "pending" || row.status === "completed") return { registration: view(row, await findAttached(row.domain)) };
    if (row.status !== "quoted") throw err(409, "This offer can't be purchased anymore. Search for the domain again.", "OFFER_NOT_USABLE");
    if (row.quote_expires_at && Date.parse(row.quote_expires_at) <= Date.now()) {
      await svc.entities.GodaddyRegistration.update(row.id, { status: "failed", error: HUMAN_ERRORS.quote_expired });
      throw err(410, HUMAN_ERRORS.quote_expired, "OFFER_EXPIRED");
    }
    const attached = await findAttached(row.domain);
    if (attached) throw takenError(attached);
    const consent = {
      agreementTypes: (row.agreements || []).map((a) => a.agreement_type).filter(Boolean),
      agreedAt: new Date().toISOString(),
    };
    if ((row.fees || []).length) consent.acknowledgedFees = row.fees;
    let reg;
    try {
      reg = await godaddyFetch(token, "POST", "/registrations", {
        quoteToken: row.quote_token, domain: row.domain, period: row.period || 1, consent, profile: row.profile,
      }, { fetchImpl, idempotency_key: row.idempotency_key });
    } catch (e) {
      if (e.code === "quote_expired") {
        await svc.entities.GodaddyRegistration.update(row.id, { status: "failed", error: HUMAN_ERRORS.quote_expired });
        throw err(410, HUMAN_ERRORS.quote_expired, "OFFER_EXPIRED");
      }
      if (e.status === 409) {
        const human = humanize(409, e.code, null, "/registrations");
        await svc.entities.GodaddyRegistration.update(row.id, { status: "failed", error: human });
        throw err(409, human, "DOMAIN_TAKEN");
      }
      // Transient failures keep the offer intact: the same Idempotency-Key replays safely.
      throw e;
    }
    const updated = await svc.entities.GodaddyRegistration.update(row.id, {
      status: "pending",
      registration_id: reg?.registrationId || row.registration_id || null,
      operation_id: reg?.operationId || row.operation_id || null,
      started_at: new Date().toISOString(),
      last_polled_at: new Date().toISOString(),
    });
    return { registration: view(updated, await findAttached(row.domain)) };
  }

  // Poll one pending row to its next state. COMPLETED provisions serving DNS and attaches
  // the domain as active — ownership is proven by the GoDaddy account holding the zone, so
  // no TXT challenge is needed for a bought domain (external domains keep their challenge).
  const pollOne = async (row) => {
    if (row.status !== "pending") return row;
    const op = await godaddyFetch(token, "GET", `/operations/${row.operation_id}`, undefined, { fetchImpl }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    const now = new Date().toISOString();
    const status = op?.status || null;
    if (!status || status === "CONFIRMED" || status === "EXECUTING") {
      return svc.entities.GodaddyRegistration.update(row.id, { attempts: (row.attempts || 0) + 1, last_polled_at: now });
    }
    if (status === "FAILED") {
      const human = op.error ? humanize(500, op.error.name || null, op.error.message || null, "/operations") : "Registration failed. Please try again.";
      return svc.entities.GodaddyRegistration.update(row.id, { status: "failed", error: human, completed_at: now });
    }
    // COMPLETED
    const expires_at = op.result?.expiresAt || null;
    const dns = await provisionRecords(token, row.domain, fetchImpl);
    let planError = null;
    let attached = await findAttached(row.domain);
    if (!attached) {
      attached = await createDomainWithinLimit(svc, { id: workspace_id }, {
        project_id, hostname: row.domain, environment: "production",
        status: dns.ok ? "active" : "error",
        verified_at: dns.ok ? now : null,
        last_error: dns.ok ? null : dns.error,
        is_primary: false, added_by,
      }).catch((e) => {
        if (e?.code === "PLAN_LIMIT_REACHED") planError = PLAN_LIMIT_MESSAGE;
        return null;
      });
    } else if (dns.ok && attached.status !== "active") {
      attached = await svc.entities.CustomDomain.update(attached.id, { status: "active", verified_at: attached.verified_at || now, last_error: null });
    }
    return svc.entities.GodaddyRegistration.update(row.id, {
      status: "completed", completed_at: now, expires_at, dns_ok: dns.ok,
      error: dns.ok ? (planError || null) : dns.error,
    });
  };

  if (action === "poll") {
    const row = await loadRow(input.registration_id);
    const fresh = await pollOne(row);
    return { registration: view(fresh, await findAttached(fresh.domain)) };
  }

  // RESUME — pick up registrations left in flight by an earlier session.
  if (action === "resume") {
    const pending = (await svc.entities.GodaddyRegistration.filter({ project_id, status: "pending" }, "-created_date", 10)).slice(0, 5);
    const registrations = [];
    for (const row of pending) {
      const fresh = await pollOne(row).catch(() => row);
      registrations.push(view(fresh, await findAttached(fresh.domain).catch(() => null)));
    }
    return { registrations };
  }

  // DNS_PROVISION — the retryable connect step for a registered domain.
  const row = await loadRow(input.registration_id);
  if (row.status !== "completed") throw err(400, "The domain isn't registered yet, so it can't be connected.", "NOT_COMPLETED");
  const dns = await provisionRecords(token, row.domain, fetchImpl);
  let planError = null;
  let attached = await findAttached(row.domain);
  const now = new Date().toISOString();
  if (!attached) {
    attached = await createDomainWithinLimit(svc, { id: workspace_id }, {
      project_id, hostname: row.domain, environment: "production",
      status: dns.ok ? "active" : "error",
      verified_at: dns.ok ? now : null,
      last_error: dns.ok ? null : dns.error,
      is_primary: false, added_by,
    }).catch((e) => {
      if (e?.code === "PLAN_LIMIT_REACHED") planError = PLAN_LIMIT_MESSAGE;
      return null;
    });
  } else {
    attached = await svc.entities.CustomDomain.update(attached.id, dns.ok
      ? { status: "active", verified_at: attached.verified_at || now, last_error: null }
      : { status: "error", last_error: dns.error });
  }
  const fresh = await svc.entities.GodaddyRegistration.update(row.id, { dns_ok: dns.ok, error: dns.ok ? (planError || null) : dns.error });
  return { registration: view(fresh, attached) };
}
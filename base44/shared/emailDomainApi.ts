// Custom email-domain management surface over the DOCUMENTED Base44 management API
// (docs.base44.com/api-reference):
//   GET    /api/apps/{app_id}/custom-email-domains            — list email domains
//   POST   /api/apps/{app_id}/custom-email-domains            — enable sending for a domain
//   POST   /api/apps/{app_id}/custom-email-domains/replace    — replace the email domain
//   POST   /api/apps/{app_id}/custom-email-domains/configure  — retry / re-check setup
//   DELETE /api/apps/{app_id}/custom-email-domains            — disable sending
//
// Boundaries (fail closed, no invention):
//   • the credential is the app's OWN Base44 personal access token, read ONLY server-side and
//     handed in here as `token`; the NexusAI nxpat_ token system is never used for it and the
//     token is never returned, logged or persisted;
//   • `dns_records[]` and every status travel VERBATIM between the API, the EmailDomain
//     persistence mirror and the responses — this app never generates, modifies, defaults or
//     invents a CNAME value or a status. The only status ever treated as meaningful is the
//     documented `active` ("only active sends mail");
//   • the surface is bounded to THIS app's management scope: `app_id` is the pre-populated
//     BASE44_APP_ID, never a client input;
//   • an unset PAT or app id refuses with 503 BEFORE anything else runs.

export const EMAIL_DOMAIN_API_BASE = "https://app.base44.com";
export const EMAIL_DOMAIN_ACTIONS = ["list", "create", "replace", "configure", "disable"];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const nowIso = () => new Date().toISOString();

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Verbatim projection of ONE email-domain row the documented responses carry. Absent fields
 * stay absent/null — nothing is defaulted; an unrecognized payload is dropped rather than
 * guessed into shape.
 */
export function normalizeApiEmailDomain(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.domain !== "string" || !raw.domain.trim()) return null;
  const status = raw.configuration_status !== undefined ? raw.configuration_status : raw.status;
  const records = Array.isArray(raw.dns_records) ? raw.dns_records : [];
  return {
    domain: raw.domain.trim().toLowerCase(),
    sender_name: typeof raw.sender_name === "string" ? raw.sender_name : null,
    from_email: typeof raw.from_email === "string" ? raw.from_email : null,
    email_domain_id: typeof raw.email_domain_id === "string" ? raw.email_domain_id
      : typeof raw.id === "string" ? raw.id : null,
    status: typeof status === "string" ? status : null,
    dns_records: records,
    last_check: typeof raw.last_check === "string" ? raw.last_check : null,
    provider_id: typeof raw.provider_id === "string" ? raw.provider_id : null,
    external: raw.external === true,
    enabled_at: typeof raw.enabled_at === "string" ? raw.enabled_at : null,
  };
}

/** One documented-endpoint call. Non-2xx and unreachable both fail closed with the API's own verdict relayed. */
async function callManagementApi({ token, app_id, method, path, body = null, query = null, fetchImpl = null }) {
  const f = fetchImpl || fetch;
  const url = new URL(`${EMAIL_DOMAIN_API_BASE}/api/apps/${encodeURIComponent(String(app_id))}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await f(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw httpError(502, `The Base44 management API is unreachable: ${String(e?.message || e).slice(0, 200)}`, "BASE44_API_UNREACHABLE");
  }
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const detail = payload?.detail?.message || payload?.detail || payload?.message || payload?.error;
    throw httpError(
      Number.isInteger(res.status) && res.status >= 400 && res.status < 600 ? res.status : 502,
      typeof detail === "string" && detail ? detail : `The Base44 management API refused the request (HTTP ${res.status})`,
      "BASE44_API_ERROR",
    );
  }
  return payload;
}

// --- persistence mirror -------------------------------------------------------
// EmailDomain rows mirror the API's state verbatim, per project. The mirror is refreshed only
// from successful API responses, so a stale row can never claim an `active` domain the API no
// longer reports — the list sync prunes what the API stopped returning.

async function upsertRow(svc, projectId, workspaceId, norm) {
  if (!norm || !norm.email_domain_id) return null;
  const fields = {
    domain: norm.domain, sender_name: norm.sender_name, from_email: norm.from_email,
    email_domain_id: norm.email_domain_id, status: norm.status, dns_records: norm.dns_records,
    last_check: norm.last_check, provider_id: norm.provider_id, external: norm.external,
    enabled_at: norm.enabled_at, synced_at: nowIso(),
  };
  const existing = (await svc.entities.EmailDomain.filter(
    { project_id: projectId, email_domain_id: norm.email_domain_id }, "-created_date", 5,
  ).catch(() => [])).find((r) => r.domain === norm.domain);
  if (existing) return svc.entities.EmailDomain.update(existing.id, fields);
  return svc.entities.EmailDomain.create({ project_id: projectId, workspace_id: workspaceId, ...fields });
}

async function syncFromList(svc, projectId, workspaceId, norms) {
  for (const norm of norms) await upsertRow(svc, projectId, workspaceId, norm);
  const listed = new Set(norms.map((n) => n.domain));
  for (const row of await svc.entities.EmailDomain.filter({ project_id: projectId }, "-created_date", 50).catch(() => [])) {
    if (!listed.has(row.domain)) await svc.entities.EmailDomain.delete(row.id).catch(() => {});
  }
}

async function updateByDomain(svc, projectId, norm) {
  if (!norm) return;
  for (const row of await svc.entities.EmailDomain.filter({ project_id: projectId, domain: norm.domain }, "-created_date", 5).catch(() => [])) {
    await svc.entities.EmailDomain.update(row.id, {
      ...(norm.status ? { status: norm.status } : {}),
      ...(norm.last_check ? { last_check: norm.last_check } : {}),
      synced_at: nowIso(),
    }).catch(() => {});
  }
}

async function removeRows(svc, projectId, domain = null) {
  const filter = domain ? { project_id: projectId, domain } : { project_id: projectId };
  for (const row of await svc.entities.EmailDomain.filter(filter, "-created_date", 50).catch(() => [])) {
    await svc.entities.EmailDomain.delete(row.id).catch(() => {});
  }
}

/**
 * THE sending-capability lookup used by the messaging layer. Returns the project's ACTIVE
 * custom email domain, or null — `active` is the documented "sends mail" state and it is read
 * only from the persisted management-API mirror, never inferred.
 */
export async function activeEmailDomain(svc, projectId) {
  const rows = await svc.entities.EmailDomain
    .filter({ project_id: String(projectId || ""), status: "active" }, "-created_date", 5)
    .catch(() => []);
  return rows[0] || null;
}

/**
 * THE five-action surface. `token` is the app's own Base44 management PAT (server-side secret),
 * `app_id` the pre-populated BASE44_APP_ID; both refuse closed when absent. Caller-side
 * validation (domain shape, documented from_email-domain equality) runs BEFORE any network
 * call; everything beyond it is the API's own verdict, relayed verbatim.
 */
export async function emailDomainSurface(svc, {
  token, app_id, action = "list", domain = null, sender_name = null, from_email = null,
  project_id = null, workspace_id = null, fetchImpl = null,
} = {}) {
  if (!token) throw httpError(503, "The Base44 management PAT is not configured for this app", "EMAIL_DOMAIN_SECRET_NOT_CONFIGURED");
  if (!app_id) throw httpError(503, "The Base44 app id is not configured for this app", "EMAIL_DOMAIN_APP_ID_MISSING");
  const act = String(action || "list");
  if (!EMAIL_DOMAIN_ACTIONS.includes(act)) throw httpError(400, `Unknown action "${act}"`, "EMAIL_DOMAIN_ACTION_UNKNOWN");

  const d = domain == null || domain === "" ? null : String(domain).trim().toLowerCase();
  if (d !== null && !HOSTNAME_RE.test(d)) {
    throw httpError(400, `"${domain}" is not a valid domain name`, "EMAIL_DOMAIN_INVALID");
  }

  if (act === "list") {
    const payload = await callManagementApi({ token, app_id, method: "GET", path: "/custom-email-domains", fetchImpl });
    const rows = (Array.isArray(payload?.email_domains) ? payload.email_domains : [])
      .map(normalizeApiEmailDomain).filter(Boolean);
    if (project_id) await syncFromList(svc, project_id, workspace_id, rows);
    return { action: act, email_domains: rows };
  }

  if (act === "create" || act === "replace") {
    if (!d) throw httpError(400, "domain is required", "EMAIL_DOMAIN_REQUIRED");
    const name = String(sender_name || "").trim();
    if (!name) throw httpError(400, "sender_name is required", "EMAIL_SENDER_NAME_REQUIRED");
    if (name.length > 200) throw httpError(400, "sender_name must be at most 200 characters", "EMAIL_SENDER_NAME_TOO_LONG");
    const from = String(from_email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(from)) throw httpError(400, "from_email must be a valid email address", "EMAIL_FROM_INVALID");
    if (from.split("@")[1] !== d) {
      throw httpError(400, "from_email's domain must be the domain being enabled", "EMAIL_FROM_DOMAIN_MISMATCH");
    }
    const body = { domain: d, sender_name: name, from_email: from };
    const payload = await callManagementApi({
      token, app_id,
      method: "POST",
      path: act === "create" ? "/custom-email-domains" : "/custom-email-domains/replace",
      body, fetchImpl,
    });
    const norm = normalizeApiEmailDomain(payload);
    if (!norm || !norm.email_domain_id) {
      throw httpError(502, "The Base44 management API returned no email domain identity", "BASE44_API_ERROR");
    }
    if (project_id) await upsertRow(svc, project_id, workspace_id, norm);
    return { action: act, email_domain: norm };
  }

  if (act === "configure") {
    const payload = await callManagementApi({
      token, app_id, method: "POST", path: "/custom-email-domains/configure",
      query: d ? { domain: d } : null, fetchImpl,
    });
    const norm = normalizeApiEmailDomain(payload);
    // The configure response carries no email domain identity — only an existing mirror row
    // is updated; nothing is created from it.
    if (project_id) await updateByDomain(svc, project_id, norm);
    return { action: act, email_domain: norm };
  }

  // disable — the documented DELETE. The API removes the setup; the mirror follows.
  await callManagementApi({
    token, app_id, method: "DELETE", path: "/custom-email-domains",
    query: d ? { domain: d } : null, fetchImpl,
  });
  if (project_id) await removeRows(svc, project_id, d);
  return { action: act, disabled: true };
}
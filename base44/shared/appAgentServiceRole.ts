// P-9.11P Tier 1 — the backend service-role agents READ surface (`base44.asServiceRole.agents`).
//
// DOCUMENTED (docs.base44.com SDK reference `agents` + client/service-role docs):
//   • `asServiceRole.agents` is the SAME AgentsModule interface, "invoked with the service role
//     for backend code that needs elevated permissions" — Base44-hosted backend functions only;
//   • getConversations() — all conversations from all agents in the app;
//   • getConversation(conversationId) → AgentConversation | undefined (missing resolves to undefined);
//   • listConversations(filterParams) — the documented filter fields: q, sort/sort_by, limit,
//     skip, fields. Nothing beyond the documented shape: unsupported keys, sorts, limits, skips
//     and field names are refused fail-closed (400), mirroring the certified user-mode list.
//
// DERIVED FROM EXISTING NEXUSAI CONTRACTS — explicitly NOT claimed as Base44 parity:
//   • Project scoping is the SAME sandbox data-namespace contract ctx.db / ctx.files use: the
//     executor captures the project id, the sandbox can never name another project, and
//     elevated access can never become cross-project access (enforced here by construction).
//   • Elevated reads are cross-user within the executing project only — mirroring ctx.db's
//     service-role data access. No end-user owner filter and no RLS gate applies to these reads.
//   • The bounded streaming read plan (batched server-side pages, in-memory data.* matching,
//     SAFETY_MAX ceiling) mirrors appData.ts's existing scalable query plan.
//
// P-9.11P TIER 2 — AUDITED: REFUSED / FAIL-CLOSED (read-only audit completed; variant A approved).
//   The documented AgentsModule write/notify surface — createConversation, updateConversation,
//   addMessage, subscribeToConversation, getWhatsAppConnectURL, getTelegramConnectURL — plus
//   every other undocumented op is deliberately NOT implemented on this service-role surface:
//   1. DOCUMENTED Base44 API surface: those ops are documented for the USER-mode client, where
//      every contract is defined through "the current user" — authentication is required, a
//      conversation "belongs to the user who created it", and created_by_id is the creator's id.
//   2. Base44 publishes NO service-role ownership/identity semantics: there is no documented
//      answer to whose identity, owner or created_by a service-role write would carry.
//   3. Base44 publishes NO cross-user write authorization for the service role: "elevated
//      permissions" is documented as a phrase only, never as a write scope over other users.
//   4. addMessage is additionally documented to "also update the realtime socket to notify any
//      subscribers" — NexusAI has no conversation realtime surface, so any implementation would
//      be incomplete parity even before the identity question.
//   5. Therefore implementing any of these would be NexusAI-derived behavior, NOT Base44 parity.
//   Resolution: audited fail-closed refusal — AGENT_OP_NOT_SUPPORTED for every non-read op.
//   No sentinel owner, no as_user_id, no realtime/socket layer, no billing change, no user-mode
//   Agents SDK change, and no change to the P-9.11C/E/I/P contracts.
import { CONVERSATIONS_ENTITY, MESSAGES_ENTITY, APP_AGENT_LIMITS, conversationView } from "./appAgentRuntime.ts";

const STREAM_BATCH = 500;
const SAFETY_MAX = 10000;
const SUPPORTED_FILTER_KEYS = ["q", "query", "sort", "sort_by", "limit", "skip", "fields"];
// The documented conversation projection keys (P-9.11I) a `fields` selection may name. `messages`
// exists only on the get read (the documented getConversation embeds them) and is deliberately
// not selectable on list — the list projection embeds no messages (P-9.11I).
const CONVERSATION_FIELDS = ["id", "app_id", "conversation_id", "agent_name", "title", "created_by_id", "created_at", "created_date", "updated_date", "metadata"];
const SUPPORTED_OPS = "getConversations, getConversation, listConversations";
// The audited Tier 2 refusal contract, exported so the parity suite can statically certify that
// the boundary names exactly the audited ops and the audited reason.
export const REFUSED_OPS = "createConversation, updateConversation, addMessage, subscribeToConversation, getWhatsAppConnectURL, getTelegramConnectURL, connect_link";
export const AUDITED_REFUSAL = "audited Tier 2 refusal (P-9.11P): documented service-role ownership/identity and cross-user write semantics are UNKNOWN — implementation would be NexusAI-derived, not Base44 parity";

const agentError = (status, code, message) => Object.assign(new Error(String(message || code)), { status, code });
const asc = (a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id));

/** Fail-closed validation of the DOCUMENTED filter surface only. Mirrors the certified
 *  user-mode list contract (AGENT_QUERY_INVALID / AGENT_SORT_INVALID / AGENT_LIMIT_INVALID) and
 *  validates the documented skip/fields with the same fail-closed shape. */
function validateListParams(params) {
  const p = params === undefined || params === null ? {} : params;
  if (typeof p !== "object" || Array.isArray(p)) {
    throw agentError(400, "AGENT_PARAMS_INVALID", "filterParams must be an object of documented filter fields (q, sort/sort_by, limit, skip, fields)");
  }
  const unknown = Object.keys(p).filter((k) => !SUPPORTED_FILTER_KEYS.includes(k));
  if (unknown.length) {
    throw agentError(400, "AGENT_PARAMS_INVALID", `unsupported filterParams field(s): ${unknown.join(", ")} (documented: q, sort/sort_by, limit, skip, fields)`);
  }
  let agentFilter = null;
  const metaFilters = [];
  const rawQ = p.q !== undefined ? p.q : p.query;
  if (rawQ !== undefined && rawQ !== null) {
    if (typeof rawQ !== "object" || Array.isArray(rawQ)) {
      throw agentError(400, "AGENT_QUERY_INVALID", "q must be an object of documented filter fields (agent_name, metadata.<key>)");
    }
    agentFilter = rawQ.agent_name != null ? String(rawQ.agent_name) : null;
    for (const [k, v] of Object.entries(rawQ)) {
      if (k === "agent_name") continue;
      const key = k.startsWith("metadata.") ? k.slice("metadata.".length) : null;
      if (!key || !key.trim() || key.length > 60) {
        throw agentError(400, "AGENT_QUERY_INVALID", `unsupported q field '${k}' (documented: agent_name, metadata.<key>)`);
      }
      metaFilters.push({ key, value: v });
    }
  }
  const rawSort = p.sort_by !== undefined ? p.sort_by : p.sort;
  const sort = rawSort === undefined || rawSort === null ? "-created_date" : String(rawSort);
  if (sort !== "created_date" && sort !== "-created_date") {
    throw agentError(400, "AGENT_SORT_INVALID", "sort must be 'created_date' or '-created_date'");
  }
  let limit = APP_AGENT_LIMITS.LIST_LIMIT;
  if (p.limit !== undefined && p.limit !== null) {
    const n = Number(p.limit);
    if (!Number.isInteger(n) || n < 1 || n > APP_AGENT_LIMITS.LIST_LIMIT) {
      throw agentError(400, "AGENT_LIMIT_INVALID", `limit must be a whole number between 1 and ${APP_AGENT_LIMITS.LIST_LIMIT}`);
    }
    limit = n;
  }
  let skip = 0;
  if (p.skip !== undefined && p.skip !== null) {
    const n = Number(p.skip);
    if (!Number.isInteger(n) || n < 0 || n > SAFETY_MAX) {
      throw agentError(400, "AGENT_SKIP_INVALID", `skip must be a whole number between 0 and ${SAFETY_MAX}`);
    }
    skip = n;
  }
  let fields = null;
  if (p.fields !== undefined && p.fields !== null) {
    if (!Array.isArray(p.fields) || !p.fields.length || p.fields.some((f) => typeof f !== "string" || !CONVERSATION_FIELDS.includes(f))) {
      throw agentError(400, "AGENT_FIELDS_INVALID", `fields must be a non-empty array of documented conversation fields (${CONVERSATION_FIELDS.join(", ")})`);
    }
    fields = [...new Set(p.fields)];
  }
  return { agentFilter, metaFilters, sort, limit, skip, fields };
}

export function createAppAgentsServiceRole(svc, { projectId } = {}) {
  const pid = String(projectId || "");
  if (!pid) throw new Error("createAppAgentsServiceRole: projectId is required (captured by the executor, never by sandbox code)");

  // Bounded streaming read of the project's conversation rows. `created_date` is a TOP-LEVEL
  // field, so both documented sort orders are the server's; the q conditions live in data.*
  // and are matched in memory per batch — the same plan appData.ts uses. Elevated access is
  // cross-user, but the server query is project-scoped, so it can never become cross-project.
  const listConversations = async (filterParams) => {
    const { agentFilter, metaFilters, sort, limit, skip, fields } = validateListParams(filterParams);
    const collected = [];
    let scanned = 0;
    let batchSkip = 0;
    while (collected.length < skip + limit && scanned < SAFETY_MAX) {
      const rows = await svc.entities.AppRecord.filter(
        { project_id: pid, entity_name: CONVERSATIONS_ENTITY }, sort, STREAM_BATCH, batchSkip,
      ).catch(() => []);
      if (!rows.length) break;
      for (const r of rows) {
        if (agentFilter && (r.data || {}).agent_name !== agentFilter) continue;
        if (!metaFilters.every((f) => {
          const stored = ((r.data || {}).metadata || {})[f.key];
          return stored !== undefined && String(stored) === String(f.value);
        })) continue;
        collected.push(r);
      }
      scanned += rows.length;
      batchSkip += rows.length;
      if (rows.length < STREAM_BATCH) break;
    }
    const conversations = collected.slice(skip, skip + limit).map((r) => {
      const view = conversationView(r);
      if (!fields) return view;
      const picked = {};
      for (const f of fields) picked[f] = view[f];
      return picked;
    });
    return { count: conversations.length, conversations };
  };

  const getConversation = async (conversationId) => {
    const id = String(conversationId ?? "");
    if (!id) throw agentError(400, "AGENT_CONVERSATION_ID_REQUIRED", "getConversation requires a conversation id");
    let row = null;
    try { row = await svc.entities.AppRecord.get(id); } catch { row = null; }
    // Another project's row (or a non-conversation row) is indistinguishable from a missing
    // one: the documented missing behavior is `undefined`, and nothing cross-project leaves.
    if (!row || row.project_id !== pid || row.entity_name !== CONVERSATIONS_ENTITY) return undefined;
    // The conversation's messages — cross-user rows of THIS project bound to it (the get read
    // embeds them, P-9.11I). Bounded scan of the same streaming plan, oldest-first.
    const messages = [];
    let scanned = 0;
    let batchSkip = 0;
    while (scanned < SAFETY_MAX) {
      const rows = await svc.entities.AppRecord.filter(
        { project_id: pid, entity_name: MESSAGES_ENTITY }, "created_date", STREAM_BATCH, batchSkip,
      ).catch(() => []);
      if (!rows.length) break;
      for (const r of rows) {
        if (String((r.data || {}).conversation_id || "") === row.id) messages.push(r);
      }
      scanned += rows.length;
      batchSkip += rows.length;
      if (rows.length < STREAM_BATCH) break;
    }
    messages.sort(asc);
    return conversationView(row, messages);
  };

  const api = {
    getConversations: async () => listConversations({}),
    getConversation,
    listConversations,
  };
  // Fail-closed boundary: ONLY the documented read ops exist on this surface. Every other
  // AgentsModule op — the writes, the realtime subscription and the channel connect URLs — is an
  // AUDITED Tier 2 refusal (see the header): the documented user-mode contracts cannot carry over
  // without a published service-role ownership/identity and cross-user write authorization, so
  // they are refused with AGENT_OP_NOT_SUPPORTED, never invented. This is a NEXUSAI boundary,
  // not a claim about Base44 behavior.
  return new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== "string" || prop in target) return target[prop];
      if (prop === "then" || prop === "catch") return undefined;
      return async () => {
        throw agentError(400, "AGENT_OP_NOT_SUPPORTED", `agents operation '${prop}' is not supported on the backend read surface (supported: ${SUPPORTED_OPS}; ${AUDITED_REFUSAL}; refused: ${REFUSED_OPS})`);
      };
    },
  });
}
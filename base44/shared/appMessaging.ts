// Email + push notification primitives for DEPLOYED generated apps.
//
// Design mirrors the existing file/auth primitives so there is ONE enforcement path:
//   • Project-scoped: every send is bound to the resolved project id, and its audit row is
//     written into that project's own data (AppRecord under the reserved entity `__messages`),
//     reusing the same storage primitive `__users` / `__sessions` / `__files` already use.
//   • Provider credentials never reach generated code: sending happens here, with the
//     service role, behind a transport abstraction. The sandbox only ever receives the
//     safe result (id / status), never a provider handle, token or endpoint.
//   • Provider abstraction: TRANSPORTS maps a transport name to an implementation.
//       - "platform" delivers through the platform's built-in integrations.
//       - "test"     records the message and delivers nothing. Used by tests so no real
//                    email or notification is ever sent.
//   • Validation + quotas are enforced server-side, before any provider call, on the
//     decoded payload — a caller cannot lie its way past them.
//
// Push limitation (documented, not silently swallowed): the platform's push transport
// addresses a PLATFORM user id, while a deployed app's end-users are project-scoped rows
// and are deliberately not platform users. So a push is always recorded as an in-app
// notification for the end-user, and is additionally delivered to a device only when that
// end-user row carries an explicit `platform_user_id` mapping.

import { USERS_ENTITY } from "./appAuth.ts";
import { FILES_ENTITY } from "./appFiles.ts";
import { holdIntegrationCredits, chargeWorkspace, INTEGRATION_CREDIT_RATES } from "./integrationCharges.ts";
import { activeEmailDomain } from "./emailDomainApi.ts";

export const MESSAGES_ENTITY = "__messages";
export const NOTIFICATIONS_ENTITY = "__notifications";

export const MESSAGING_LIMITS = {
  MAX_RECIPIENTS: 5,            // per send
  MAX_SUBJECT_CHARS: 200,
  MAX_BODY_CHARS: 100_000,
  MAX_PUSH_TITLE_CHARS: 100,
  MAX_PUSH_CONTENT_CHARS: 1000,
  MAX_EMAILS_PER_DAY: 200,      // per project
  // DOCUMENTED (Base44) SendEmail attachment contract: at most 5 attachments per send, ≤5 MB
  // each and ≤10 MB total, documents and images only.
  MAX_EMAIL_ATTACHMENTS: 5,
  MAX_EMAIL_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES: 10 * 1024 * 1024,
  MAX_PUSH_PER_DAY: 500,        // per project
  AUDIT_SCAN: 500,              // bounded window used for quota counting
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function asList(value) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

// --- email attachments (DOCUMENTED Base44 SendEmail contract) -----------------
// Each attachment is { filename, content } with base64 content the caller built, or
// { filename, file_url } where file_url is a file THIS project uploaded — resolved through the
// project's own public upload records, so anything else fails closed (a caller-chosen file can
// never mail this project's data to a stranger). Whether the platform applies additional
// content screening on delivery beyond this byte/extension contract is UNKNOWN — nothing is
// invented here. Returns the normalized attachment list, or null when none were given.
export const EMAIL_ATTACHMENT_EXTS = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "csv", "txt", "md", "ics", "xlsx", "docx",
]);

async function assertEmailAttachments(svc, projectId, attachments) {
  if (attachments == null) return null;
  if (!Array.isArray(attachments)) {
    throw httpError(400, "attachments must be a list of { filename, content | file_url }", "EMAIL_ATTACHMENT_INVALID");
  }
  if (attachments.length > MESSAGING_LIMITS.MAX_EMAIL_ATTACHMENTS) {
    throw httpError(400, `At most ${MESSAGING_LIMITS.MAX_EMAIL_ATTACHMENTS} attachments per email`, "EMAIL_TOO_MANY_ATTACHMENTS");
  }
  const checked = [];
  let total = 0;
  for (const a of attachments) {
    if (!a || typeof a !== "object" || Array.isArray(a)) {
      throw httpError(400, "Each attachment must be an object with filename and exactly one of content or file_url", "EMAIL_ATTACHMENT_INVALID");
    }
    const filename = String(a.filename || "").trim();
    const ext = filename.toLowerCase().split(".").pop() || "";
    if (!filename || filename.includes("/") || filename.includes("\\") || !EMAIL_ATTACHMENT_EXTS.has(ext)) {
      throw httpError(400, `Attachment "${filename || "(unnamed)"}" must be a document or image (${[...EMAIL_ATTACHMENT_EXTS].join(", ")})`, "EMAIL_ATTACHMENT_TYPE_REJECTED");
    }
    const hasContent = a.content != null;
    const hasUrl = a.file_url != null && String(a.file_url).trim() !== "";
    if (hasContent === hasUrl) {
      throw httpError(400, `Attachment "${filename}" needs exactly one of content or file_url`, "EMAIL_ATTACHMENT_INVALID");
    }
    if (hasContent) {
      let bytes = 0;
      try { bytes = atob(String(a.content)).length; } catch {
        throw httpError(400, `Attachment "${filename}" content is not valid base64`, "EMAIL_ATTACHMENT_INVALID");
      }
      if (bytes > MESSAGING_LIMITS.MAX_EMAIL_ATTACHMENT_BYTES) {
        throw httpError(413, `Attachment "${filename}" exceeds the 5 MB limit`, "EMAIL_ATTACHMENT_TOO_LARGE");
      }
      total += bytes;
      checked.push({ filename, content: String(a.content) });
    } else {
      const fileUrl = String(a.file_url).trim();
      const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: FILES_ENTITY }, "-created_date", 500).catch(() => []);
      const row = rows.find((r) => (r.data || {}).file_url === fileUrl);
      if (!row) {
        throw httpError(403, "Attachment file_url must be a file this app uploaded", "EMAIL_ATTACHMENT_FOREIGN_FILE");
      }
      const size = Number((row.data || {}).size || 0);
      if (size > MESSAGING_LIMITS.MAX_EMAIL_ATTACHMENT_BYTES) {
        throw httpError(413, `Attachment "${filename}" exceeds the 5 MB limit`, "EMAIL_ATTACHMENT_TOO_LARGE");
      }
      total += size;
      checked.push({ filename, file_url: fileUrl });
    }
    if (total > MESSAGING_LIMITS.MAX_EMAIL_ATTACHMENTS_TOTAL_BYTES) {
      throw httpError(413, "Attachments exceed the 10 MB total limit per email", "EMAIL_ATTACHMENTS_TOO_LARGE");
    }
  }
  return checked;
}

// --- transports --------------------------------------------------------------
// A transport receives the already-validated message plus the service-role client. It
// returns { delivered, provider, detail? }. It never returns credentials.
const TRANSPORTS = {
  test: {
    async email() { return { delivered: false, provider: "test" }; },
    async push() { return { delivered: false, provider: "test" }; },
  },
  platform: {
    async email(svc, { to, subject, text, html, from_name, attachments }) {
      const payload = { to, subject };
      if (html) payload.html = html;
      if (text) payload.text = text;
      if (from_name) payload.from_name = from_name;
      if (attachments?.length) payload.attachments = attachments;
      await svc.integrations.Core.SendEmail(payload);
      return { delivered: true, provider: "platform" };
    },
    async push(svc, { platform_user_id, title, content, action_label, action_url }) {
      // Only reachable when the end-user row carries an explicit platform user mapping.
      if (!platform_user_id) return { delivered: false, provider: "platform", detail: "no device mapping for this user" };
      const payload = { user_id: platform_user_id, title, content };
      if (action_label) payload.action_label = action_label;
      if (action_url) payload.action_url = action_url;
      await svc.integrations.Core.SendPushNotification(payload);
      return { delivered: true, provider: "platform" };
    },
  },
};

function transportFor(name) {
  const t = TRANSPORTS[String(name || "platform")];
  if (!t) throw httpError(400, `Unknown messaging transport "${name}"`, "MESSAGING_TRANSPORT_UNKNOWN");
  return t;
}

// --- quota -------------------------------------------------------------------
// Counts this project's sends of one kind in the last 24h over a bounded window.
async function assertQuota(svc, projectId, kind, cost) {
  const limit = kind === "email" ? MESSAGING_LIMITS.MAX_EMAILS_PER_DAY : MESSAGING_LIMITS.MAX_PUSH_PER_DAY;
  const rows = await svc.entities.AppRecord.filter(
    { project_id: projectId, entity_name: MESSAGES_ENTITY }, "-created_date", MESSAGING_LIMITS.AUDIT_SCAN,
  );
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let used = 0;
  for (const r of rows) {
    const d = r.data || {};
    if (d.kind !== kind) continue;
    if (Date.parse(d.sent_at || r.created_date || 0) < cutoff) continue;
    used += Number(d.recipient_count) || 1;
  }
  if (used + cost > limit) {
    throw httpError(429, `Daily ${kind} limit reached for this app (${limit}). Try again later.`, "MESSAGING_QUOTA_EXCEEDED");
  }
}

// Audit row. Bodies are NOT stored — only lengths and a short subject/title — so the audit
// trail can never become a copy of user content or of anything a body happened to contain.
async function audit(svc, projectId, row) {
  const record = await svc.entities.AppRecord.create({
    project_id: projectId, entity_name: MESSAGES_ENTITY,
    data: { ...row, sent_at: new Date().toISOString() },
  });
  return record.id;
}

// --- email -------------------------------------------------------------------
export async function sendEmail(svc, projectId, input = {}, { transport = "platform" } = {}) {
  const to = asList(input.to);
  if (!to.length) throw httpError(400, "At least one recipient is required", "EMAIL_NO_RECIPIENT");
  if (to.length > MESSAGING_LIMITS.MAX_RECIPIENTS) {
    throw httpError(400, `At most ${MESSAGING_LIMITS.MAX_RECIPIENTS} recipients per email`, "EMAIL_TOO_MANY_RECIPIENTS");
  }
  const invalid = to.filter((e) => !EMAIL_RE.test(e.toLowerCase()));
  if (invalid.length) throw httpError(400, `Invalid email address: ${invalid[0]}`, "EMAIL_INVALID_RECIPIENT");

  const subject = String(input.subject || "").trim();
  if (!subject) throw httpError(400, "Subject is required", "EMAIL_NO_SUBJECT");
  if (subject.length > MESSAGING_LIMITS.MAX_SUBJECT_CHARS) {
    throw httpError(400, `Subject exceeds ${MESSAGING_LIMITS.MAX_SUBJECT_CHARS} characters`, "EMAIL_SUBJECT_TOO_LONG");
  }
  const text = input.text == null ? "" : String(input.text);
  const html = input.html == null ? "" : String(input.html);
  if (!text && !html) throw httpError(400, "Either text or html body is required", "EMAIL_NO_BODY");
  if (text.length > MESSAGING_LIMITS.MAX_BODY_CHARS || html.length > MESSAGING_LIMITS.MAX_BODY_CHARS) {
    throw httpError(413, `Body exceeds ${MESSAGING_LIMITS.MAX_BODY_CHARS} characters`, "EMAIL_BODY_TOO_LARGE");
  }
  const from_name = String(input.from_name || "").slice(0, 80);
  // DOCUMENTED (Base44) attachment contract — validated fail-closed BEFORE the quota check and
  // credit hold, so a refused send consumes neither.
  const attachments = await assertEmailAttachments(svc, projectId, input.attachments);

  await assertQuota(svc, projectId, "email", to.length);

  // P-9.2: ~1 integration credit per DELIVERED email (Base44-verified rate). The hold (worst
  // case: every recipient) is placed BEFORE the first send and refuses the whole send
  // fail-closed when the workspace has nothing to spend; the charge lands afterwards for the
  // recipients actually delivered. The internal "test" transport delivers nothing, so it neither
  // holds nor charges; an unresolvable project id (a verification namespace) charges nobody.
  const charge_ws = transport === "test" ? null : await chargeWorkspace(svc, projectId);
  // DOCUMENTED (Base44): an email sent from an ACTIVE custom email domain costs ~2 integration
  // credits instead of ~1 — one-time passwords, password resets and app invitations included,
  // since every built-in send rides the custom domain while it is active. The rate resolves
  // from the PERSISTED management-API state only: a domain that is not verifiably `active`
  // keeps the standard rate, and no status is ever inferred here.
  const emailRate = (await activeEmailDomain(svc, projectId))
    ? INTEGRATION_CREDIT_RATES.email_custom_domain
    : INTEGRATION_CREDIT_RATES.email;
  const hold = charge_ws ? await holdIntegrationCredits(svc, {
    workspace_id: charge_ws, project_id: projectId,
    credits: emailRate * to.length,
    key: `email:${crypto.randomUUID()}`,
    reason: `SendEmail · ${emailRate} credit(s) per email${emailRate > 1 ? " (custom email domain)" : ""}`,
  }) : null;

  const impl = transportFor(transport);
  const results = [];
  for (const recipient of to) {
    // Delivery failure of one recipient is reported, never thrown away and never fatal
    // to the others; the audit row records the outcome either way.
    try {
      const r = await impl.email(svc, { to: recipient, subject, text, html, from_name, ...(attachments?.length ? { attachments } : {}) });
      results.push({ to: recipient, ...r });
    } catch (e) {
      results.push({ to: recipient, delivered: false, provider: transport, error: String(e?.message || e).slice(0, 200) });
    }
  }
  // P-9.2: the charge lands AFTER delivery, for the recipients actually delivered — a send
  // where nothing went out costs nothing.
  const deliveredCount = results.filter((r) => r.delivered).length;
  await hold?.settle(deliveredCount * emailRate, "SendEmail · integration charge", { operation: "email", delivered: deliveredCount, rate: emailRate });
  const id = await audit(svc, projectId, {
    kind: "email", transport, subject: subject.slice(0, 200),
    recipient_count: to.length, recipients: to,
    body_chars: text.length + html.length, has_html: !!html,
    attachment_count: attachments?.length || 0,
    delivered_count: results.filter((r) => r.delivered).length,
  });
  return { id, kind: "email", transport, recipients: to.length, delivered: results.filter((r) => r.delivered).length, results };
}

// --- push --------------------------------------------------------------------
// Recipient is an END-USER id of this project (an `__users` row), never a platform user id:
// a generated app must not be able to address platform accounts.
export async function sendPush(svc, projectId, input = {}, { transport = "platform" } = {}) {
  const userId = String(input.user_id || "").trim();
  if (!userId) throw httpError(400, "user_id is required", "PUSH_NO_RECIPIENT");
  const title = String(input.title || "").trim();
  const content = String(input.content || "").trim();
  if (!title) throw httpError(400, "title is required", "PUSH_NO_TITLE");
  if (!content) throw httpError(400, "content is required", "PUSH_NO_CONTENT");
  if (title.length > MESSAGING_LIMITS.MAX_PUSH_TITLE_CHARS) {
    throw httpError(400, `title exceeds ${MESSAGING_LIMITS.MAX_PUSH_TITLE_CHARS} characters`, "PUSH_TITLE_TOO_LONG");
  }
  if (content.length > MESSAGING_LIMITS.MAX_PUSH_CONTENT_CHARS) {
    throw httpError(413, `content exceeds ${MESSAGING_LIMITS.MAX_PUSH_CONTENT_CHARS} characters`, "PUSH_CONTENT_TOO_LARGE");
  }

  // Project scope + existence check: an id from another project is not a valid recipient.
  let userRow = null;
  try { userRow = await svc.entities.AppRecord.get(userId); } catch { userRow = null; }
  let isRecipient = !!userRow && userRow.project_id === projectId && userRow.entity_name === USERS_ENTITY;
  if (!isRecipient) {
    // The project's authenticated end users (AppUser — the identity the inbox session resolves).
    let appUser = null;
    try { appUser = await svc.entities.AppUser.get(userId); } catch { appUser = null; }
    isRecipient = !!appUser && appUser.project_id === projectId && appUser.status !== "disabled";
  }
  if (!isRecipient) {
    throw httpError(404, "Recipient not found", "PUSH_RECIPIENT_NOT_FOUND");
  }

  await assertQuota(svc, projectId, "push", 1);

  // P-9.2: ~1 integration credit per DELIVERED notification (Base44-verified rate). Hold before
  // the send, fail-closed; the internal "test" transport delivers nothing and charges nothing.
  const charge_ws = transport === "test" ? null : await chargeWorkspace(svc, projectId);
  const hold = charge_ws ? await holdIntegrationCredits(svc, {
    workspace_id: charge_ws, project_id: projectId,
    credits: INTEGRATION_CREDIT_RATES.push,
    key: `push:${crypto.randomUUID()}`,
    reason: `SendPushNotification · ${INTEGRATION_CREDIT_RATES.push} credit per notification`,
  }) : null;

  const impl = transportFor(transport);
  let result;
  try {
    result = await impl.push(svc, {
      platform_user_id: (userRow.data || {}).platform_user_id || null,
      title, content, action_label: input.action_label, action_url: input.action_url,
    });
  } catch (e) {
    result = { delivered: false, provider: transport, error: String(e?.message || e).slice(0, 200) };
  }
  // P-9.2: 1 credit per DELIVERED notification — nothing delivered means no charge, hold released.
  await hold?.settle(result.delivered ? INTEGRATION_CREDIT_RATES.push : 0, "SendPushNotification · integration charge", { operation: "push", delivered: !!result.delivered });

  // Always recorded as an in-app notification for the end-user, so the app has a delivery
  // surface even when no device mapping exists. Owner-scoped, like every other user row.
  const notification = await svc.entities.AppRecord.create({
    project_id: projectId, entity_name: NOTIFICATIONS_ENTITY, owner_id: userId,
    unread: true,
    data: { title, content, action_label: input.action_label || "", action_url: input.action_url || "", read: false, created_at: new Date().toISOString() },
  });

  const id = await audit(svc, projectId, {
    kind: "push", transport, subject: title.slice(0, 200), recipient_count: 1, recipients: [userId],
    body_chars: content.length, delivered_count: result.delivered ? 1 : 0, notification_id: notification.id,
  });
  return { id, kind: "push", transport, notification_id: notification.id, delivered: !!result.delivered, detail: result.detail || result.error || null };
}

export async function listNotifications(svc, projectId, userId, { limit = 50 } = {}) {
  const rows = await svc.entities.AppRecord.filter(
    { project_id: projectId, entity_name: NOTIFICATIONS_ENTITY, owner_id: String(userId) },
    "-created_date", Math.min(Number(limit) || 50, 200),
  );
  return rows.map((r) => ({ id: r.id, ...(r.data || {}) }));
}

// The messaging API handed to generated backend functions (ctx.email / ctx.push).
export function createServerMessaging(svc, projectId, { transport = "platform" } = {}) {
  const opts = { transport };
  return {
    email: {
      send: (input) => sendEmail(svc, projectId, input || {}, opts),
      limits: { max_recipients: MESSAGING_LIMITS.MAX_RECIPIENTS, max_body_chars: MESSAGING_LIMITS.MAX_BODY_CHARS, max_per_day: MESSAGING_LIMITS.MAX_EMAILS_PER_DAY },
    },
    push: {
      send: (input) => sendPush(svc, projectId, input || {}, opts),
      list: (userId, options) => listNotifications(svc, projectId, userId, options || {}),
      limits: { max_content_chars: MESSAGING_LIMITS.MAX_PUSH_CONTENT_CHARS, max_per_day: MESSAGING_LIMITS.MAX_PUSH_PER_DAY },
    },
  };
}
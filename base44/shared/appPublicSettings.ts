// AppModule parity (SDK 0.8.52): the DOCUMENTED `base44.app.getPublicSettings()` surface —
// `GET /apps/public/prod/public-settings/by-id/{appId}` — dispatched onto the EXISTING
// public-serving gate. ONE module owns the visibility→public_settings mapping and the
// documented 403 error envelope, shared verbatim by the deployed runtime ("app" action in
// appRuntime) and the builder preview (scope "app" in previewIntegrations), so both surfaces
// answer identically.
//
// No engine, gate, schema or visibility semantic is introduced here: the decision is still
// assertPublicServing's (deploy.ts), unchanged, and the ONLY data ever returned is
// { id, public_settings } — never the project row, its auth settings or any other field.
//
// Visibility → public_settings (Base44's documented values, applied to the EXISTING enum):
//   'public'    → "public_without_login"
//   'private'   → "private_with_login"
//   'workspace' → "workspace_with_login"
// Base44's "public_with_login" has NO equivalent in NexusAI's visibility enum and none is
// invented here (UNKNOWN — deliberately unclaimed).
//
// Error mapping (the documented AppModule contract: rejects 403 with data.extra_data.reason).
// Applied ONLY where the existing gate state provides direct evidence; every other refusal is
// preserved VERBATIM:
//   • 401 AUTH_REQUIRED — the visitor has no valid end-user session → the documented
//     "auth_required" (the visitor must sign in).
//   • 403 NOT_A_WORKSPACE_MEMBER — the session RESOLVED (a registered app user) and access was
//     still refused → the documented "user_not_registered" (a signed-in visitor with no access
//     to this app).
//   • WORKSPACE_NOT_ENTITLED (402) / PROJECT_ARCHIVED (404) / APP_UNPUBLISHED (503) and any
//     other refusal pass through untouched — archived/unpublished/entitlement behavior is
//     unchanged by design.
import { assertPublicServing } from "./deploy.ts";

/** The operation vocabulary of the "app" scope. getPublicSettings is parameterless. */
export const APP_PUBLIC_SETTINGS_OPS = ["get_public_settings"];

/** The EXISTING visibility enum → the documented Base44 public_settings value. */
export function publicSettingsFor(project) {
  const visibility = project.visibility || "public";
  if (visibility === "workspace") return "workspace_with_login";
  if (visibility === "private") return "private_with_login";
  return "public_without_login";
}

/**
 * The documented getPublicSettings contract for ONE project. The session token (if any) is the
 * project's own end-user session — resolved by the EXISTING gate, exactly like every other
 * public action. Throws the documented 403 envelope where the gate's state provides direct
 * evidence; otherwise rethrows the gate's refusal unchanged.
 */
export async function handleAppPublicSettings(svc, project, { sessionToken } = {}) {
  try {
    await assertPublicServing(svc, project, { sessionToken, action: "app" });
  } catch (e) {
    if (e?.code === "AUTH_REQUIRED") {
      throw Object.assign(new Error(e.message || "Sign in required"), {
        status: 403, code: "AUTH_REQUIRED", extra_data: { reason: "auth_required" },
      });
    }
    if (e?.code === "NOT_A_WORKSPACE_MEMBER") {
      throw Object.assign(new Error(e.message || "Access denied"), {
        status: 403, code: "NOT_A_WORKSPACE_MEMBER", extra_data: { reason: "user_not_registered" },
      });
    }
    throw e;
  }
  return { id: project.id, public_settings: publicSettingsFor(project) };
}
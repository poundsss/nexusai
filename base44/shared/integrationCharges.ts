// P-9.2 — flat integration-credit charges for platform-service operations.
//
// The ONLY rates in this module are the ones Base44 publishes officially
// (docs.base44.com/Account-and-billing/Credits): GenerateImage ~1 credit per image,
// ExtractDataFromUploadedFile ~1 credit per call, SendEmail ~1 credit per email,
// SendPushNotification ~1 credit per notification, UploadFile ~1 credit per upload;
// GenerateVideo ~5 credits per second of video; GenerateSpeech ~1 credit per 50
// characters, up to 100 per call. TranscribeAudio is priced nowhere in the docs
// (UNKNOWN) and carries NO rate.
// Nothing else is charged here and no rate is invented — operations Base44 does not price
// (search, db access, external calls with the app's own API key) stay free, and the
// custom-domain email multiplier is deliberately NOT implemented: its applicability to this
// infrastructure is unconfirmed.
//
// Charging rides the EXISTING canonical ledger — reserve / recordEvent / releaseReservation —
// never a second billing path, and never `platform_integration_credits` metadata in its place:
//   hold → operation → settle on success (charge + release), hold release on failure;
//   • fail-closed: the hold is refused with INSUFFICIENT_CREDITS BEFORE the operation begins;
//   • exactly-once: hold/charge/release keys all derive from ONE logical-operation key, so a
//     replayed operation settles the SAME entries instead of moving credits twice;
//   • delivered-then-charged: the charge lands after the work succeeded, for exactly what was
//     delivered (allowNegative — delivered work is never made free by a racing spend), and a
//     failure releases the hold and charges nothing;
//   • message pool untouched: every movement is credit_type "integration".
import { reserve, releaseReservation, recordEvent } from "./ledger.ts";

export const INTEGRATION_CREDIT_RATES = {
  generate_image: 1,
  file_extraction: 1,
  email: 1,
  // DOCUMENTED (Base44): an email sent from an ACTIVE custom email domain consumes ~2
  // integration credits, against ~1 for the standard sending domain — every built-in email
  // type included (send-email integrations, one-time passwords, password resets, invitations).
  email_custom_domain: 2,
  push: 1,
  upload: 1,
  // DOCUMENTED (Base44) media rates: video ~5 credits per second of generated video;
  // speech ~1 credit per 50 characters, capped at 100 per call. Transcription is unpriced
  // (UNKNOWN) and deliberately carries no rate here.
  video_per_second: 5,
  speech_chars_per_credit: 50,
  speech_max_credits: 100,
};

/** Speech charge for a text: ceil(chars/50), capped at 100 — the documented typical formula. */
export const speechCreditsFor = (text) =>
  Math.min(
    INTEGRATION_CREDIT_RATES.speech_max_credits,
    Math.ceil(String(text ?? "").length / INTEGRATION_CREDIT_RATES.speech_chars_per_credit),
  );

/**
 * The workspace a project-scoped operation charges. An unresolvable project (a throwaway
 * verification namespace) charges nobody — the platform's own smoke tests are not billed to an
 * account that did nothing.
 */
export async function chargeWorkspace(svc, project_id) {
  if (!project_id) return null;
  const project = await svc.entities.Project.get(project_id).catch(() => null);
  return project?.workspace_id || null;
}

/**
 * Places the up-front hold for one flat-charged operation and hands back its settlement handle.
 * `credits` is the WORST case (the operation may deliver less — settle charges only what was
 * actually delivered and releases the rest of the hold). Refuses with INSUFFICIENT_CREDITS when
 * the integration pool cannot cover the hold, before the operation begins.
 */
export async function holdIntegrationCredits(svc, { workspace_id, project_id = null, user_id = null, credits, key, reason }) {
  const amount = Math.round((Number(credits) || 0) * 1e6) / 1e6;
  if (!workspace_id || !(amount > 0)) return null;
  const scoped = `intchg:${workspace_id}:${String(key).slice(0, 180)}`;
  await reserve(svc, {
    workspace_id, user_id, project_id, credits: amount,
    idempotency_key: `${scoped}:hold`, reason: reason || "Integration operation reservation",
  }, "integration");
  const release = (why) => releaseReservation(svc, {
    workspace_id, project_id, credits: amount, idempotency_key: `${scoped}:release`, reason: why,
  }, "integration");
  return {
    credits: amount,
    /** Charges `delivered` credits (clamped to the hold) and releases the hold. Idempotent by key. */
    settle: async (delivered = amount, chargeReason = null, metadata = {}) => {
      const charge = Math.min(Math.max(Math.round((Number(delivered) || 0) * 1e6) / 1e6, 0), amount);
      const res = charge > 0 ? await recordEvent(svc, {
        workspace_id, user_id, project_id, event_type: "ai_charge", amount: -charge,
        credit_type: "integration", idempotency_key: `${scoped}:charge`,
        reason: chargeReason || reason || "Integration operation charge", metadata,
      }, { allowNegative: true }) : null;
      await release("Reservation released at settlement");
      return { charged: res && !res.duplicate ? charge : 0, duplicate: !!res?.duplicate };
    },
    /** A failed operation charges nothing and hands the hold back. */
    fail: () => release("Reservation released: operation failed"),
  };
}
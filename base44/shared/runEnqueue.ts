// AI run enqueue service. ONE enqueue path for the builder UI and the MCP server:
// persisting the AIRun record is what starts the background executor workflow, which
// owns planning, generation, build, repair, commit, versioning and credit accounting.
import { guardRunEnqueue, apiError } from "./platformApi.ts";
// One trace id per top-level operation, minted HERE — the run's entry point — so every later
// phase, worker, retry and tool call correlates back to this request.
import { newTraceId } from "./tracing.ts";
// THE shared reference-image contract: stored http(s) file URLs only, capped and de-duplicated.
import { normalizeImageUrls } from "./attachments.ts";
// P-16C1 (documented): manual model selection is a Builder-plan entitlement.
import { resolveModelSelection } from "./subscriptions.ts";
// Referral (Slice 2): the user message this enqueue persists is one of the two referrer-reward
// conditions. Detection rides this EXISTING production path; fail-safe below.
import { maybeGrantReferrerReward } from "./referral.ts";

export async function enqueueRun(base44, { project, prompt, mode = "default", conversationId, modelId = null, imageUrls = null, initiatedByUserId = null, parentAgentRunId = null }) {
  const text = String(prompt || "").trim();
  if (!text) throw apiError("INVALID_INPUT", "prompt is required");
  if (text.length > 8000) throw apiError("INVALID_INPUT", "prompt too long (max 8000 characters)");
  const images = normalizeImageUrls(imageUrls);

  // P-16C1 (documented Base44): manual model selection requires a Builder plan or higher —
  // below it, Auto only. Enforced SERVER-side here, never just in the UI; Auto (null) and
  // every caller's existing payload stay unchanged.
  if (modelId) {
    const selection = await resolveModelSelection(base44, { workspace_id: project.workspace_id });
    if (!selection.ok) {
      throw apiError("MODEL_SELECTION_PLAN_REQUIRED", `Manual model selection requires a Builder plan or higher (plan "${selection.plan_code}" allows Auto only)`, 403);
    }
  }

  // Concurrency/volume rails + retry idempotency: an identical in-flight prompt is reused.
  const { reused } = await guardRunEnqueue(base44, project, text);
  // A retried enqueue re-attaches to the in-flight run AND its existing trace, so the retry is
  // part of the same logical operation rather than a second, uncorrelated one.
  if (reused) return { run_id: reused.id, status: reused.status, phase: reused.phase || "plan", conversation_id: reused.conversation_id, trace_id: reused.trace_id || null, reused_existing: true };

  let convId = conversationId;
  if (!convId) {
    const conv = await base44.entities.Conversation.create({ project_id: project.id, title: text.slice(0, 80) });
    convId = conv.id;
  }
  await base44.entities.Message.create({ project_id: project.id, conversation_id: convId, role: "user", content: text });

  const now = new Date().toISOString();
  const run = await base44.entities.AIRun.create({
    project_id: project.id, conversation_id: convId, status: "QUEUED", phase: "plan", mode, prompt: text, steps: [],
    started_at: now, heartbeat_at: now, trace_id: newTraceId(),
    // The version this run starts from — re-checked before commit to detect a concurrent run.
    base_version_number: project.version_count || 0,
    // User-selected model preference (null = let the router decide). The router still validates
    // capability and budget; an incompatible or unaffordable preference falls back with a reason.
    preferred_model_id: modelId || null,
    // Omitted entirely for a text-only run, so an existing caller's payload is unchanged.
    ...(images.length ? { image_urls: images } : {}),
    // Delegated runs (Agent → Builder) are created by the service principal; this records the
    // real user they act for. Omitted for a normal Builder run, which keeps using created_by_id.
    ...(initiatedByUserId ? { initiated_by_user_id: String(initiatedByUserId) } : {}),
    // Explicit ownership link for Agent-delegated runs; omitted for a normal Builder run.
    ...(parentAgentRunId ? { parent_agent_run_id: String(parentAgentRunId) } : {}),
  });

  // Referral (Slice 2), fail-safe: the user's message is one of the two referrer-reward
  // conditions. Never breaks the enqueue.
  try {
    await maybeGrantReferrerReward(base44.asServiceRole || base44, {
      user_id: initiatedByUserId || run.created_by_id || null,
      workspace_id: project.workspace_id, project_id: project.id, event: "message",
    });
  } catch {}

  return { run_id: run.id, status: "QUEUED", phase: "plan", conversation_id: convId, trace_id: run.trace_id, reused_existing: false };
}
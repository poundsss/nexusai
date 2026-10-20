// Compare models: enqueue TWO parallel AI runs of the same prompt under two different
// models so the user can compare outputs side by side. Reuses the EXISTING run pipeline —
// creating each AIRun record (status QUEUED) fires the "AI Run Executor" workflow, which
// drives planning -> generation -> build -> commit using the run's preferred_model_id.
//
// Why a dedicated endpoint (not two aiRun calls): enqueueRun dedups an identical in-flight
// prompt (guardRunEnqueue), so a second aiRun with the same prompt would reuse the first
// run instead of starting a second one under a different model. Compare intentionally
// wants two parallel runs of the same prompt, so it creates both AIRun records here
// (shared conversation + a single user message) and lets each executor run independently.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";
import { resolveModelSelection } from "../../shared/subscriptions.ts";
import { normalizeImageUrls } from "../../shared/attachments.ts";
import { newTraceId } from "../../shared/tracing.ts";

const NON_TERMINAL = ["QUEUED", "RUNNING", "CONTEXT_LOADING", "PLANNING", "EXECUTING", "VALIDATING", "REPAIRING"];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });
    if (prompt.length > 8000) return Response.json({ error: "prompt too long (max 8000 characters)" }, { status: 400 });
    // Model A may be null (Auto); Model B must be a concrete model and differ from A.
    const modelA = body.model_a || null;
    const modelB = body.model_b || null;
    if (!modelB) return Response.json({ error: "model_b is required" }, { status: 400 });
    if (modelA && modelA === modelB) return Response.json({ error: "Pick two different models to compare" }, { status: 400 });

    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id);

    // Manual model selection is a Builder-plan entitlement (P-16C1); enforce for any non-Auto pick.
    if (modelA || modelB) {
      const selection = await resolveModelSelection(base44, { workspace_id: project.workspace_id });
      if (!selection.ok) {
        return Response.json({ error: `Manual model selection requires a Builder plan or higher (plan "${selection.plan_code}" allows Auto only)`, code: "MODEL_SELECTION_PLAN_REQUIRED" }, { status: 403 });
      }
    }

    // Compare launches 2 runs at once; the project must have room for both.
    await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspace.id }), action: "ai_run", workspace_id: workspace.id, cost: 2 });
    const recent = await base44.entities.AIRun.filter({ project_id: project.id }, "-created_date", 25);
    const active = recent.filter((r) => NON_TERMINAL.includes(r.status));
    if (active.length > 0) {
      return Response.json({ error: `This project already has ${active.length} AI run(s) in progress. Wait for them to finish before comparing.`, code: "RUN_LIMIT_REACHED" }, { status: 429 });
    }

    const images = normalizeImageUrls(body.image_urls);
    let convId = body.conversation_id;
    if (!convId) {
      const conv = await base44.entities.Conversation.create({ project_id: project.id, title: prompt.slice(0, 80) });
      convId = conv.id;
    }
    await base44.entities.Message.create({ project_id: project.id, conversation_id: convId, role: "user", content: prompt });

    const now = new Date().toISOString();
    const base = {
      project_id: project.id, conversation_id: convId, status: "QUEUED", phase: "plan", mode: "default",
      prompt, steps: [], started_at: now, heartbeat_at: now, base_version_number: project.version_count || 0,
      ...(images.length ? { image_urls: images } : {}),
    };
    const runA = await base44.entities.AIRun.create({ ...base, trace_id: newTraceId(), preferred_model_id: modelA });
    const runB = await base44.entities.AIRun.create({ ...base, trace_id: newTraceId(), preferred_model_id: modelB });

    return Response.json({ run_a_id: runA.id, run_b_id: runB.id, conversation_id: convId }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}
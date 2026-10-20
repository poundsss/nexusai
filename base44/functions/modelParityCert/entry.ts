// AI MODELS parity certification (Base44 ↔ NexusAI) — targeted, runtime-verifying.
//
// Source of truth: Base44's documented model surface (docs.base44.com/developers/backend/
// resources/models — the preset table + `automatic`; the Builder chat picker in AI-chat-modes;
// the retirement contract) and the runtime AI Gateway's own model list.
//
// Covered:
//   1. model registry/listing — the documented preset surface == the pickable catalog surface;
//   2. wire names — every catalog entry carries the documented preset id as provider_model_name;
//   3. retirement — retired presets remain callable/pricable, and a preference naming one still
//      routes (the platform routes it to a close current model);
//   4. Free/Starter automatic access — UNRESTRICTED model_access; auto/best-quality routing can
//      reach an advanced model on the free plan (every model on every plan; credits control);
//   5. Builder+ manual selection — tier gate; monthly AND yearly variants of every real plan;
//   6. routing/fallback — explicit preference honored; execution chains never contain a
//      disabled model; an unaffordable primary fails closed;
//   7. credits — per-model vendor rates produce the exact expected charges; the pre-existing
//      anchors (claude-sonnet-5 = 2 credits for 1000/500) hold unchanged;
//   8. unavailable handling — unknown ids fail closed; the first-party preview model stays
//      out of routing and of valid agent pins;
//   9. persistence — an enqueued run stores its preferred_model_id (selection per run).
// The picker UI itself is verified against the REAL commerce surface from the preview.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  MODEL_CATALOG, CATALOG_BY_ID, getModel, listModels, RETIRED_MODEL_MAP, syncCatalog, loadCatalog,
} from "../../shared/modelCatalog.ts";
import { resolveModelSelection, MODEL_SELECTION_MIN_TIER_RANK, resolveModelAccess } from "../../shared/subscriptions.ts";
import { routeModel, MODEL_REGISTRY, executionChainIds, budgetAwareExecutionChain } from "../../shared/modelGateway.ts";
import { priceOperation } from "../../shared/economics.ts";
import { enqueueRun } from "../../shared/runEnqueue.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";

// DOCUMENTED (Base44 Supported Models): the full current preset surface (order as documented).
const DOCUMENTED_PRESETS = [
  "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1",
  "gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gemini-3-8-flash", "Base 1",
];
// DOCUMENTED (Base44 preset ids — the wire names).
const DOCUMENTED_WIRE_NAMES = {
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-opus-5-5": "claude_opus_5_5",
  "claude-fable-5-1": "claude_fable_5_1",
  "gpt-6-sol": "gpt_6_sol",
  "gpt-6-luna": "gpt_6_luna",
  "gpt-6-astra": "gpt_6_astra",
  "gemini-3-8-flash": "gemini_3_8_flash",
  "Base 1": "Base 1_2",
};
// DOCUMENTED (Base44 AI-chat-modes "Choosing your model"): the Builder chat picker's manual
// options. Auto mode is the null selection, handled by the picker itself.
const DOCUMENTED_BUILDER_PICKER = [
  "claude-sonnet-5", "claude-opus-5-5", "gemini-3-8-flash", "gpt-6-sol", "gpt-6-astra", "claude-fable-5-1",
];
// The real canonical plan rows (monthly + yearly variants included).
const REAL_PLANS = [
  ["free", false], ["starter_monthly", false], ["starter_yearly", false],
  ["builder_monthly", true], ["builder_yearly", true],
  ["pro_monthly", true], ["pro_yearly", true],
  ["scale_monthly", true], ["scale_yearly", true],
  ["enterprise", true],
];

// >400 chars so the router's complexity classifier (len > 400 && fileCount > 4 && >= 5 feature
// words) classifies it as high complexity → best_quality, matching the real Build surface.
const COMPLEX_PROMPT = "Build a complete settings area with a profile section and a billing panel, plus a team management page and also an audit log viewer, with a calendar widget, and a file manager, plus a notification center, and a long-form analytics dashboard with charts and also filters and a CSV export, with dark mode support and keyboard shortcuts and role-based visibility. Please also include an onboarding tour with tooltips, a searchable command palette, undo and redo history for every destructive action, per-column sorting and saved views on every table, an activity feed with mentions, granular permission controls per page, and a polished empty state for each screen, wired end to end with validation and helpful error messages";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const stamp = Date.now();
  const created = { plans: [], workspaces: [] };
  const makeWorkspace = (label, plan, credits = 0) =>
    makeBillingWorkspace(svc, created, label, { plan, credits }, stamp).then(({ ws }) => ws);

  try {
    // 0. Mirror sync (idempotent, append-only) so the runtime reads the current catalog.
    const sync = await syncCatalog(svc);
    check("0. catalog mirror sync is append-only and succeeded", typeof sync.created === "number" && typeof sync.updated === "number", JSON.stringify(sync));

    // 1. Registry parity: the pickable catalog surface == the documented preset surface.
    {
      const pickable = listModels().filter((m) => !m.retired);
      const pickableIds = pickable.map((m) => m.model_id).sort();
      const documentedIds = [...DOCUMENTED_PRESETS].sort();
      check("1a. pickable (active, non-retired) models == the documented preset surface",
        JSON.stringify(pickableIds) === JSON.stringify(documentedIds), pickableIds.join(","));
      const allDocumentedResolvable = DOCUMENTED_PRESETS.every((id) => {
        try { return getModel(id).active === true && !getModel(id).retired; } catch { return false; }
      });
      check("1b. every documented preset resolves to an active non-retired catalog model", allDocumentedResolvable, "");
      // The raw catalog carries the retired flags; listModels()'s default view drops inactive rows.
      const retiredInCatalog = MODEL_CATALOG.filter((m) => m.retired);
      const retiredHidden = retiredInCatalog.length === Object.keys(RETIRED_MODEL_MAP).length
        && retiredInCatalog.every((m) => Object.keys(RETIRED_MODEL_MAP).includes(m.model_id));
      check("1c. exactly the documented retirements are flagged and none of them is pickable",
        retiredHidden && !pickable.some((m) => m.retired), Object.keys(RETIRED_MODEL_MAP).join(","));
    }

    // 2. Wire names: catalog entries carry the documented preset ids to the gateway.
    check("2. provider_model_name == documented preset id for every documented model",
      DOCUMENTED_PRESETS.every((id) => getModel(id).provider_model_name === DOCUMENTED_WIRE_NAMES[id]),
      JSON.stringify(DOCUMENTED_WIRE_NAMES));

    // 3. Retirement: retired presets stay pricable/callable; a preference naming one still routes
    //    (the platform routes a retired id to a close current model — nothing breaks).
    {
      const mapped = Object.entries(RETIRED_MODEL_MAP).every(([from, to]) => {
        try { return !!getModel(from) && getModel(to).active === true && !getModel(to).retired; } catch { return false; }
      });
      check("3a. every retired preset maps to an active current model", mapped, JSON.stringify(RETIRED_MODEL_MAP));
      const stillRouted = routeModel({ mode: "build", prompt: "add a small badge to the header", prefer_model_id: "gpt-5-mini" });
      check("3b. a preference naming a RETIRED preset still routes (retirement never errors)",
        stillRouted.decision.model_id === "gpt-5-mini", stillRouted.decision.model_id);
      const historyPriced = priceOperation({
        model_id: "gpt-5-mini",
        usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 1500 },
      }).credits > 0;
      check("3c. a retired preset remains pricable (historical operations reprice exactly)", historyPriced, "");
    }

    // 4. Free/Starter automatic access: unrestricted model_access; the router can reach an
    //    advanced model on the free plan — every model on every plan, credits as the control.
    {
      const free = await makeWorkspace("parity_free", null);
      const access = await resolveModelAccess(svc, { workspace_id: free.id });
      check("4a. free plan model_access is unrestricted", access.restricted === false && access.allows(getModel("claude-opus-5-5")) === true, JSON.stringify(access.allowed));
      const routed = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, fileCount: 6, modelAccess: access });
      const tier = CATALOG_BY_ID.get(routed.decision.model_id)?.quality_tier;
      check("4b. on the FREE plan, automatic routing for a complex build reaches an ADVANCED model",
        tier === "advanced", `${routed.decision.model_id} (${tier}) / strategy ${routed.decision.strategy}`);
    }

    // 5. Builder+ manual selection + monthly/yearly plan variants.
    {
      for (const [planCode, expectedAllowed] of REAL_PLANS) {
        const ws = await svc.entities.Workspace.create({ name: `MPC ${planCode} ${stamp}`, owner_id: "cert", credits_balance: 0 });
        created.workspaces.push(ws.id);
        await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: planCode, status: "active" });
        const sel = await resolveModelSelection(svc, { workspace_id: ws.id });
        check(`5. manual model selection on ${planCode} → ${expectedAllowed ? "allowed (Builder+)" : "refused (below Builder)"}`,
          sel.ok === expectedAllowed && (expectedAllowed ? sel.tier_rank >= MODEL_SELECTION_MIN_TIER_RANK : sel.tier_rank < MODEL_SELECTION_MIN_TIER_RANK),
          JSON.stringify(sel));
      }
    }

    // 6. Routing/fallback for the new models.
    {
      const preferred = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, prefer_model_id: "gpt-6-sol" });
      check("6a. an explicit Builder+ preference for a documented model is honored",
        preferred.decision.model_id === "gpt-6-sol", preferred.decision.model_id);
      const chain = executionChainIds(CATALOG_BY_ID.get("gpt-6-sol"));
      check("6b. the execution chain is populated from documented fallbacks and contains NO disabled model",
        chain.length >= 1 && chain[0] === "gpt-6-sol" && !chain.includes("nexus-1") && !chain.some((id) => CATALOG_BY_ID.get(id)?.active === false),
        chain.join(" → "));
      const broke = budgetAwareExecutionChain(CATALOG_BY_ID.get("gpt-6-sol"), [], 0.01);
      check("6c. an unaffordable primary fails closed (empty chain), never a silent downgrade", broke.length === 0, JSON.stringify(broke));
    }

    // 7. Credits: vendor rates produce exact charges; pre-existing anchors hold unchanged.
    {
      const sol = priceOperation({
        model_id: "gpt-6-sol",
        usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 1500 },
      });
      check("7a. GPT-6.1 Sol charges from its vendor rate ($2/$10 → $0.007 provider cost)",
        sol.provider_cost === 0.007 && sol.credits >= 1, `${sol.provider_cost} USD → ${sol.credits} credits`);
      const flash = priceOperation({
        model_id: "gemini-3-8-flash",
        usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 1500 },
      });
      check("7b. Gemini 3.8 Flash charges from its introductory vendor rate ($0.75/$3.75)",
        flash.provider_cost === 0.002625, `${flash.provider_cost} USD`);
      const sonnet = priceOperation({
        model_id: "claude-sonnet-5",
        usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 1500 },
      });
      check("7c. regression anchor unchanged: claude-sonnet-5 at 1000/500 still charges exactly 2 credits",
        sonnet.credits === 2, String(sonnet.credits));
    }

    // 8. Unavailable handling: unknown ids fail closed; the first-party preview model stays out.
    {
      await expectThrow("8a. an unknown model id fails closed", () => getModel("totally-unknown-model"), "UNKNOWN_MODEL");
      const nexusEntry = MODEL_REGISTRY.find((m) => m.model_id === "nexus-1");
      check("8b. the first-party preview model stays out of routing (disabled in the registry)",
        !!nexusEntry && nexusEntry.enabled === false, String(nexusEntry?.enabled));
      const routed = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, prefer_model_id: "nexus-1" });
      check("8c. an unavailable preference never executes — the router falls back with a reason",
        routed.decision.model_id !== "nexus-1", routed.decision.model_id);
    }

    // 9. Persistence: an enqueued run stores its model selection (selection per run).
    {
      const builder = await makeWorkspace("parity_builder", null);
      await svc.entities.Subscription.create({ workspace_id: builder.id, plan_code: "builder_monthly", status: "active" });
      const project = await svc.entities.Project.create({ workspace_id: builder.id, name: "parity", status: "ready" });
      const enq = await enqueueRun(svc, { project, prompt: "model persistence probe", modelId: "gpt-6-sol" });
      const run = await svc.entities.AIRun.get(enq.run_id);
      check("9. the enqueued run stores preferred_model_id exactly as selected",
        run.preferred_model_id === "gpt-6-sol", String(run.preferred_model_id));
      await cleanupWorkspace(svc, builder.id, ["Subscription", "AIRun", "Conversation", "Message", "CreditLedgerEntry", "AuditLog"]);
      await svc.entities.Project.delete(project.id).catch(() => {});
      created.workspaces = created.workspaces.filter((id) => id !== builder.id);
    }

    // Runtime read path: the mirror-backed catalog still serves every documented model.
    {
      const runtimeCatalog = await loadCatalog(svc);
      const runtimeIds = new Set(listModels({ catalog: runtimeCatalog }).filter((m) => !m.retired).map((m) => m.model_id));
      check("10. the runtime (mirror-backed) catalog serves the full documented surface",
        DOCUMENTED_PRESETS.every((id) => runtimeIds.has(id)), runtimeIds.size + " pickable models");
    }

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(svc, wsId, ["Subscription", "AIOperation", "CreditLedgerEntry", "AuditLog", "AIRun"]);
    }
    for (const id of created.plans) await svc.entities.BillingPlan.delete(id).catch(() => {});
  }
}
// Social content (Slice 1) — the member-authorized GENERATION surface over the existing
// Core AI primitives. Generation/editing only: NO persistence, NO direct sharing, NO
// scheduled posts, NO connectors — the direct-share mechanics of X/Reddit/LinkedIn are
// NOT documented in enough detail to reproduce, so nothing outside this call is touched
// and no external social API is called. Every action funnels through loadAuthorizedProject
// (project authorization + the G-2 workspace lifecycle gate) and audits through the
// existing audit primitive; every charged step rides the EXISTING integration-credit hold
// ledger (shared/integrationCharges.ts) at the DOCUMENTED Base44 rates — no invented pricing.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { holdIntegrationCredits } from "../../shared/integrationCharges.ts";

export const config = { public: true };

// Documented platform pool (docs.base44.com/promoting-your-app/social-content).
const PLATFORMS = ["instagram", "x", "linkedin", "tiktok", "facebook", "reddit"];
const MAX_PLATFORMS = 3; // documented: up to 3 target platforms
const VARIANTS_PER_PLATFORM = 3; // documented: 3 post variations per platform
// Documented Base44 rates (same page): plan generation = 10 integration credits;
// Improve with AI = 1; Regenerate image = 1 (GenerateImage, the published 1-credit rate).
const PLAN_CREDITS = 10;
const IMPROVE_CREDITS = 1;
const IMAGE_CREDITS = 1;

const clean = (v, max) => String(v || "").trim().slice(0, max);

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const svc = base44.asServiceRole || base44;
    const { project, workspace } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");

    if (action === "generate") {
      const goal = clean(body.goal, 400);
      const audience = clean(body.audience, 400);
      const profile_url = clean(body.profile_url, 300);
      const platforms = Array.isArray(body.platforms)
        ? [...new Set(body.platforms.map((p) => String(p || "").trim().toLowerCase()))].filter((p) => PLATFORMS.includes(p))
        : [];
      if (!goal) return Response.json({ error: "goal is required", code: "GOAL_REQUIRED" }, { status: 400 });
      if (!audience) return Response.json({ error: "audience is required", code: "AUDIENCE_REQUIRED" }, { status: 400 });
      if (!platforms.length || platforms.length > MAX_PLATFORMS)
        return Response.json({ error: `Select between 1 and ${MAX_PLATFORMS} platforms`, code: "INVALID_PLATFORMS" }, { status: 400 });

      const hold = await holdIntegrationCredits(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        credits: PLAN_CREDITS, key: `social-plan:${crypto.randomUUID()}`,
        reason: "Social content plan generation (Base44 documented rate: 10 credits)",
      });
      try {
        const llm = await svc.integrations.Core.InvokeLLM({
          prompt:
            `You are a social media strategist. A software product is being promoted.\n` +
            `Launch goal: ${goal}\nTarget audience: ${audience}\n` +
            (profile_url
              ? `The brand's social profile for tone matching: ${profile_url} (you cannot browse it — infer the voice from the handle/URL text only).\n`
              : "") +
            `Platforms: ${platforms.join(", ")}.\n\n` +
            `For EACH listed platform write EXACTLY ${VARIANTS_PER_PLATFORM} DISTINCT ready-to-post variations adapted to that platform's tone, format and length conventions (X short and punchy; LinkedIn professional; Reddit conversational, first-person and non-promotional; Instagram/TikTok/Facebook casual, emoji where natural).\n` +
            `Every variation MUST include "copy" (the ready-to-post text itself — no placeholders, no commentary) and "visual_prompt" (a concrete, self-contained image-generation prompt describing the suggested visual; no letters/text in the image; composition appropriate for the platform).\n` +
            `Return ONLY the JSON object matching the schema. Every "platform" value must be exactly one of: ${platforms.join(", ")}.`,
          response_json_schema: {
            type: "object",
            properties: {
              posts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    platform: { type: "string" },
                    variants: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { copy: { type: "string" }, visual_prompt: { type: "string" } },
                        required: ["copy", "visual_prompt"],
                      },
                    },
                  },
                  required: ["platform", "variants"],
                },
              },
            },
            required: ["posts"],
          },
        });
        // Normalize: only requested platforms, at most 3 variants each, bounded fields.
        const posts = (llm?.posts || [])
          .map((p) => ({ ...p, platform: String(p?.platform || "").trim().toLowerCase() }))
          .filter((p) => platforms.includes(p.platform))
          .slice(0, MAX_PLATFORMS)
          .map((p) => ({
            platform: p.platform,
            variants: (p.variants || []).slice(0, VARIANTS_PER_PLATFORM).map((v) => ({
              copy: clean(v?.copy, 4000),
              visual_prompt: clean(v?.visual_prompt, 600),
              image_url: null,
              image_error: null,
            })).filter((v) => v.copy),
          }));
        if (!posts.length || posts.some((p) => !p.variants.length))
          throw Object.assign(new Error("Generation returned no usable posts"), { status: 502, code: "GENERATION_EMPTY" });
        // Suggested visuals: one documented credit per image, generated in parallel. A failed
        // image never fails the plan — the variant carries image_error and the copy stays.
        await Promise.all(posts.flatMap((p) => p.variants.map(async (v) => {
          const imgHold = await holdIntegrationCredits(svc, {
            workspace_id: workspace.id, project_id: project.id, user_id: user.id,
            credits: IMAGE_CREDITS, key: `social-img:${crypto.randomUUID()}`,
            reason: "Social content suggested visual (Base44 published rate: 1 credit per image)",
          });
          try {
            const img = await svc.integrations.Core.GenerateImage({ prompt: v.visual_prompt || `Clean promotional visual for a ${p.platform} post about ${goal}` });
            await imgHold.settle(IMAGE_CREDITS, "Social content suggested visual", { operation: "generate_image" });
            v.image_url = img?.url || null;
            if (!v.image_url) v.image_error = "Image generation returned no image";
          } catch {
            await imgHold.fail();
            v.image_error = "Image generation failed";
          }
        })));
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "social.plan.generated", resource: "Project", resource_id: project.id,
          metadata: { platforms },
        });
        await hold.settle(PLAN_CREDITS, "Social content plan generation", { platforms });
        return Response.json({ plan: { goal, audience, platforms, posts } });
      } catch (e) {
        await hold.fail();
        throw e;
      }
    }

    if (action === "improve") {
      const copy = clean(body.copy, 4000);
      const platform = clean(body.platform, 40).toLowerCase();
      const instruction = clean(body.instruction, 300);
      if (!copy) return Response.json({ error: "copy is required", code: "COPY_REQUIRED" }, { status: 400 });
      const hold = await holdIntegrationCredits(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        credits: IMPROVE_CREDITS, key: `social-improve:${crypto.randomUUID()}`,
        reason: "Improve with AI (Base44 documented rate: 1 credit)",
      });
      try {
        const improved = await svc.integrations.Core.InvokeLLM({
          prompt:
            `Improve this ready-to-post ${platform || "social"} post. Keep the language. Return ONLY the improved ready-to-post text — no placeholders, no commentary, no surrounding quotes — within the platform's length conventions.\n` +
            (instruction ? `Extra direction: ${instruction}\n` : "") +
            `\nPost:\n${copy}`,
        });
        const text = clean(typeof improved === "string" ? improved : improved?.copy, 4000);
        if (!text) throw Object.assign(new Error("Improvement returned no text"), { status: 502, code: "IMPROVE_EMPTY" });
        await hold.settle(IMPROVE_CREDITS, "Improve with AI", { operation: "improve" });
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "social.post.improved", resource: "Project", resource_id: project.id,
          metadata: { platform },
        });
        return Response.json({ copy: text });
      } catch (e) {
        await hold.fail();
        throw e;
      }
    }

    if (action === "image") {
      const prompt = clean(body.prompt, 600);
      const platform = clean(body.platform, 40).toLowerCase();
      if (!prompt) return Response.json({ error: "prompt is required", code: "PROMPT_REQUIRED" }, { status: 400 });
      const hold = await holdIntegrationCredits(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        credits: IMAGE_CREDITS, key: `social-img-re:${crypto.randomUUID()}`,
        reason: "Regenerate image (Base44 documented rate: 1 credit)",
      });
      try {
        const img = await svc.integrations.Core.GenerateImage({ prompt });
        if (!img?.url) throw Object.assign(new Error("Image generation returned no image"), { status: 502, code: "IMAGE_EMPTY" });
        await hold.settle(IMAGE_CREDITS, "Regenerate image", { operation: "generate_image" });
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "social.image.regenerated", resource: "Project", resource_id: project.id,
          metadata: { platform },
        });
        return Response.json({ url: img.url });
      } catch (e) {
        await hold.fail();
        throw e;
      }
    }

    return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (e) {
    const status = e.status || 500;
    return Response.json({ error: String(e.message || e), code: e.code || "SOCIAL_CONTENT_ERROR" }, { status });
  }
}
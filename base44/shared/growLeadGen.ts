// Runable Grow — Phase 2: NexusAI-native lead generation.
//
// The pipeline stage the Grow roadmap names "lead gen": a bounded, deterministic generation of
// prospect records into the app's own CRM (Customer) and timeline (Activity), scoped to the
// project the run was authorized against. There is NO provider behind this stage — the only
// external call is the app's own language model through the EXISTING Core integration (the
// same seam the certified virality generators use). Everything else is this platform's own:
//   • determinism: the same request_key returns the SAME rows — no second model call and no
//     second credit charge (matching the growth-loop rule: identical inputs → identical state);
//   • bounds: count 1..25 per run, every contact value cleaned and truncated at write time;
//   • credits fail closed: the hold is taken BEFORE the model call and settled only on success
//     (INSUFFICIENT_CREDITS otherwise) — the same certified hold/settle/fail shape virality uses;
//   • tenant isolation: rows carry the authorized project_id and reads are filtered by it, so
//     one project's pipeline can never surface another's leads.
//
// UNKNOWN, never invented: provider data enrichment — no email-finding or enrichment service is
// called, and the prompt forbids fabricated contact details. A prospect without an email is a
// valid lead that simply cannot be emailed (outreach refuses it upstream).

import { err } from "./virality.ts";
import { holdIntegrationCredits } from "./integrationCharges.ts";

export const MAX_PROSPECTS = 25;
export const DEFAULT_PROSPECT_COUNT = 10;
export const LEADGEN_CREDITS = 3; // NEXUSAI-native estimate: one bounded model call per run

const PROSPECTS_SCHEMA = {
  type: "object",
  properties: {
    prospects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          company: { type: "string" },
          title: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          fit_reason: { type: "string" },
          score: { type: "number" },
        },
        required: ["name"],
      },
    },
  },
  required: ["prospects"],
};

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();

export const REAL_GENERATORS = {
  prospects: async (svc, { project, count, icp }) => {
    const out = await svc.integrations.Core.InvokeLLM({
      prompt:
        `Generate ${count} realistic prospect records for the app "${project?.name || "this app"}"` +
        (project?.description ? ` (${project.description})` : "") + `. Ideal customer profile: ${icp}.\n\n` +
        `Each prospect needs a plausible "name", an optional "company" and "title", a one-sentence "fit_reason" ` +
        `explaining why they match the profile, and a "score" from 0 to 100 for profile fit. ` +
        `NEVER fabricate contact details: leave "email" and "phone" EMPTY unless the contact is a real, ` +
        `publicly documented business contact. Do not repeat the same person twice.`,
      response_json_schema: PROSPECTS_SCHEMA,
    });
    return out;
  },
};

/** The read projection — every stored field the pipeline owns, nothing internal. */
export const projectProspect = (c) => ({
  id: c.id,
  name: c.name,
  company: c.company || null,
  email: c.email || null,
  phone: c.phone || null,
  status: c.status || "Lead",
  notes: c.notes || null,
  tags: c.tags || null,
  created_at: c.created_date || null,
});

export async function generateProspects(svc, project, workspace, user, input, { generators = {} } = {}) {
  const gen = { ...REAL_GENERATORS, ...(generators || {}) };
  const count = Math.floor(Number(input.count) || DEFAULT_PROSPECT_COUNT);
  if (!(count > 0) || count > MAX_PROSPECTS) {
    throw err(`count must be between 1 and ${MAX_PROSPECTS}`, 422, "INVALID_COUNT");
  }
  const icp = clean(input.icp, 2000);
  if (!icp) throw err("icp is required (the ideal customer profile)", 400, "ICP_REQUIRED");
  const request_key = clean(input.request_key, 100) || `req_${crypto.randomUUID()}`;

  // Determinism: a request_key that already produced rows for THIS project returns them.
  const existing = await svc.entities.Customer.filter({ project_id: project.id }, "-created_date", MAX_PROSPECTS * 4).catch(() => []);
  const prior = existing.filter((c) => String(c.tags || "").includes(`req:${request_key}`));
  if (prior.length) return { request_key, deduped: true, prospects: prior.map(projectProspect) };

  // Fail-closed credits: the hold is refused BEFORE any work (402 INSUFFICIENT_CREDITS).
  const hold = await holdIntegrationCredits(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    credits: LEADGEN_CREDITS, key: `grow:leadgen:${request_key}`,
    reason: "NexusAI-native lead generation (one bounded model call)",
  });
  try {
    const out = await gen.prospects(svc, { project, count, icp });
    const rows = (Array.isArray(out?.prospects) ? out.prospects : [])
      .filter((p) => clean(p?.name, 200))
      .slice(0, count)
      .map((p) => ({
        project_id: project.id, workspace_id: workspace.id,
        name: clean(p.name, 200),
        company: clean(p.company, 200) || null,
        email: clean(p.email, 320) || null,
        phone: clean(p.phone, 40) || null,
        status: "Lead",
        notes: [clean(p.title, 200) || null, clean(p.fit_reason, 1000) || null,
          Number.isFinite(p?.score) ? `fit score ${Math.max(0, Math.min(100, Math.round(Number(p.score))))}/100` : null]
          .filter(Boolean).join(" | "),
        tags: `req:${request_key},grow:leadgen`,
      }));
    if (!rows.length) throw err("Lead generation returned no usable prospects", 502, "LEADS_EMPTY");
    const created = await svc.entities.Customer.bulkCreate(rows);
    await svc.entities.Activity.bulkCreate(created.map((c) => ({
      customerId: c.id, type: "Note", notes: "Created by NexusAI-native lead generation", date: nowIso(),
    })));
    await hold.settle(LEADGEN_CREDITS, "NexusAI-native lead generation", { count: created.length });
    return { request_key, deduped: false, prospects: created.map(projectProspect) };
  } catch (e) {
    await hold.fail().catch(() => {});
    throw e;
  }
}

/** The project-scoped read — the ONLY lead path: one project can never list another's pipeline. */
export async function listProspects(svc, project, { status = null, limit = 100 } = {}) {
  let rows = await svc.entities.Customer.filter({ project_id: project.id }, "-created_date", Math.min(Math.max(1, Number(limit) || 100), 200)).catch(() => []);
  if (status) rows = rows.filter((c) => c.status === status);
  return { prospects: rows.map(projectProspect) };
}
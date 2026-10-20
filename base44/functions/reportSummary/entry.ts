import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";

// Activity carries no project_id: it is scoped through its customer ids, counted in bounded chunks.
const IN_CHUNK = 500;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let body: any = {};
    try { body = await req.json(); } catch (_) {}

    const customerId = body.customerId || body.customer_id;
    const type = body.type || body.kind || "Note";
    const notes = body.notes || body.note || "Generated report summary";

    // Least privilege: reading needs project.read; creating an Activity needs project.write.
    let project;
    try {
      ({ project } = await loadAuthorizedProject(base44, user, String(body.project_id || ""), customerId ? "project.write" : "project.read"));
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: e.status || 403 });
    }

    const db = base44.asServiceRole.entities;
    const scope = { project_id: project.id };

    // Server-side totals: no record-count ceiling (the legacy array read stops at 5,000).
    const agg = await db.Customer.aggregate({ query: scope, groupBy: "status", sum: "deal_value" });
    const statusCounts: Record<string, number> = {};
    let totalCustomers = 0;
    let totalValue = 0;
    for (const row of agg.rows || []) {
      const st = row.status || "Lead";
      statusCounts[st] = (statusCounts[st] || 0) + (Number(row.count) || 0);
      totalCustomers += Number(row.count) || 0;
      totalValue += Number(row.sum_deal_value) || 0;
    }

    // Every customer id of the project, cursor-paged (ids only).
    const customerIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page: any = await db.Customer.filter(scope, { limit: 5000, fields: ["id"], ...(cursor ? { cursor } : {}) });
      for (const c of page.items || []) customerIds.push(String(c.id));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);

    let totalActivities = 0;
    for (let i = 0; i < customerIds.length; i += IN_CHUNK) {
      totalActivities += await db.Activity.count({ customerId: { $in: customerIds.slice(i, i + IN_CHUNK) } });
    }

    let createdActivity = null;
    if (customerId) {
      if (!customerIds.includes(String(customerId))) {
        return Response.json({ error: "Customer not found in this project" }, { status: 404 });
      }
      createdActivity = await db.Activity.create({
        customerId: String(customerId),
        type: ["Call", "Email", "Meeting", "Note"].includes(type) ? type : "Note",
        notes: String(notes),
        created_by: "System",
        date: new Date().toISOString(),
      });
    }

    return Response.json({
      success: true,
      totalCustomers,
      totalActivities,
      totalPipelineValue: totalValue,
      statusCounts,
      activity: createdActivity,
    }, { status: 200 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
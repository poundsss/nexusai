import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let requestBody: any = {};
    try { requestBody = await req.json(); } catch (_) {}

    const rawEmail = requestBody && requestBody.email;
    if (!rawEmail || typeof rawEmail !== "string") {
      return Response.json({ error: "A valid email address is required." }, { status: 400 });
    }

    const email = rawEmail.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!emailRegex.test(email)) {
      return Response.json({ error: "Invalid email address format." }, { status: 400 });
    }

    // Least privilege: the caller must be able to read the named project; lookups never cross it.
    let project;
    try {
      ({ project } = await loadAuthorizedProject(base44, user, String(requestBody.project_id || ""), "project.read"));
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: e.status || 403 });
    }

    try {
      const scope = { project_id: project.id };
      let matches = await base44.asServiceRole.entities.Customer.filter({ ...scope, email }, "created_date", 1);
      if (!matches || matches.length === 0) {
        const projectCustomers = await base44.asServiceRole.entities.Customer.filter(scope, "-created_date", 500);
        const found = projectCustomers.find((c: any) => c.email && typeof c.email === "string" && c.email.trim().toLowerCase() === email);
        if (found) matches = [found];
      }
      if (!matches || matches.length === 0) {
        return Response.json({ error: "No customer found with that email address." }, { status: 404 });
      }
      const customer = matches[0];
      return Response.json({ customer: { id: customer.id, name: customer.name, email: customer.email } }, { status: 200 });
    } catch (err: any) {
      console.log("Error querying customer lookup:", err.message);
      return Response.json({ error: "Internal server error while searching for customer." }, { status: 500 });
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
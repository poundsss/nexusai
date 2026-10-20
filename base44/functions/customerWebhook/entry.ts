import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { secrets } from "base44:runtime";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function (req: Request): Promise<Response> {
  try {
    // 1. authenticate: shared-secret header (the platform strips 'authorization'
    // before it reaches a webhook, so the signature travels in a custom header).
    const expected = secrets.get("WEBHOOK_SECRET");
    const presented = req.headers.get("x-webhook-token");
    if (!presented || presented !== expected) {
      console.log("rejected webhook: bad or missing x-webhook-token");
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: any = null;
    try { body = await req.json(); } catch (_) {}
    if (!body || typeof body !== "object") {
      return Response.json({ error: "json object body required" }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);

    // 2. validate
    const errors: string[] = [];
    if (body.event !== "customer.created") errors.push("unsupported event");
    const externalId = typeof body.external_id === "string" ? body.external_id.trim() : "";
    if (!externalId) errors.push("external_id is required");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) errors.push("email is invalid");
    if (errors.length) {
      console.log("validation rejected: " + errors.join("; "));
      return Response.json({ error: "validation failed", details: errors }, { status: 422 });
    }

    // 3. normalize + write to the database (service role: no user auth on a webhook).
    const record = {
      external_id: externalId,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Unknown",
      email: email,
      status: "Lead",
    };
    const saved = await base44.asServiceRole.entities.Customer.create(record);
    console.log("created Customer " + saved.id + " for external_id " + externalId);

    // 4. sanitized result
    return Response.json(
      { ok: true, id: saved.id, external_id: saved.external_id, email: saved.email, status: saved.status },
      { status: 201 }
    );
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
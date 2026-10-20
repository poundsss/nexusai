// The primitive platform API (#27).
//
// One authenticated surface over the ONE server-side executor: publish the contract, invoke a
// primitive, and read a project's invocation history. It adds no execution logic of its own —
// authorization, validation, idempotency, billing, tracing and error classification all live in
// shared/primitives.ts, so an HTTP caller and a generated app get identical behaviour.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { invokePrimitive, listPrimitiveInvocations, describePrimitives, PRIMITIVE_CONTRACT_VERSION } from "../../shared/primitives.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "capabilities");

  // The contract itself is credential-free and safe to publish unauthenticated.
  if (action === "capabilities" || action === "describe") {
    return Response.json({ contract_version: PRIMITIVE_CONTRACT_VERSION, ...describePrimitives() });
  }

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });

    if (action === "invoke") {
      // `options` is deliberately NOT forwarded from the client: transports, provider overrides
      // and routing overrides are server-side concerns only.
      const res = await invokePrimitive(base44, {
        primitive: body.primitive, version: body.version || null, input: body.input || {},
        project_id: body.project_id, actor: "user", user,
        idempotency_key: body.idempotency_key || null,
        trace_id: body.trace_id || null, run_id: body.run_id || null,
      });
      const status = res.ok ? 200
        : res.error.category === "authorization" ? 403
          : res.error.category === "not_found" ? 404
            : res.error.category === "validation" ? 422
              : res.error.category === "conflict" ? 409
                : res.error.category === "rate_limit" ? 429
                  : res.error.category === "timeout" ? 504
                    : res.error.category === "provider" ? 502 : 500;
      return Response.json(res, { status });
    }
    if (action === "invocations") {
      return Response.json(await listPrimitiveInvocations(base44, user, {
        project_id: body.project_id, primitive: body.primitive || null, limit: body.limit || 50,
      }));
    }
    return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "PRIMITIVE_API_ERROR", details: e.details || null }, { status: e.status || 500 });
  }
}
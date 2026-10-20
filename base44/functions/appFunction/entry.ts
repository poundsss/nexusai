// Invokes one of a generated project's backend functions, server-side.
// This is the endpoint the preview's `server.<name>(payload)` bridge calls. The caller is
// authorized against the project first; the function body then runs in the interpreter
// sandbox with project-scoped db access and its declared secrets.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { executeProjectFunction, loadProjectFunction } from "../../shared/functionRuntime.ts";
import { loadProjectIntegrations } from "../../shared/integrations.ts";
import { runProjectFunctionFetch } from "../../shared/appFetch.ts";
// G-A: the invoke path additionally accepts genuine multipart/form-data (SDK 0.8.52 wire).
import { isMultipartInvoke, parseMultipartInvokeBody } from "../../shared/multipartInvoke.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // G-A: multipart/form-data invoke requests (the documented SDK 0.8.52 wire for File
    // parameters) are parsed into the SAME envelope the invoke branch already reads; the JSON
    // path is untouched. functions.fetch is NOT changed — a multipart fetch-mode body carries
    // no `fetch` args and is refused by that branch as before.
    const body = isMultipartInvoke(req) ? await parseMultipartInvokeBody(req) : await req.json();
    const { project } = await loadAuthorizedProject(base44, user, body.project_id);
    const name = String(body.function_name || "");

    // Service role: the generated app's records live under the platform's own entities,
    // and webhooks share this executor. Scoping is enforced inside the executor.
    const svc = base44.asServiceRole;
    const entities = (await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200))
      .map((e) => ({ id: e.id, name: e.name, fields: e.fields || {} }));

    const integrations = await loadProjectIntegrations(svc, project.id);

    // functions.fetch (documented raw-HTTP surface): additive branch. The caller's path/init
    // are validated and executed through the SAME executor, and the raw envelope returns
    // whatever the function's status is — a function 4xx/5xx is a Response for the caller,
    // never a bridge error. Only an infrastructure refusal (unknown function, invalid args)
    // surfaces as { error }, which the bridge turns into a rejected promise. The invoke
    // branch below is untouched.
    if (body.mode === "fetch") {
      // Streaming (additive, multi-frame bridge): when the bridge requests streaming, a
      // stream-capable handler result is returned as a RAW passthrough Response (the marker
      // header tells the host to frame chunks); any other result keeps the exact buffered
      // envelope below, so the existing fetch contract is byte-identical.
      const out = await runProjectFunctionFetch(svc, {
        project, entities, integrations, args: body.fetch || {},
        streaming: body.stream === true,
        signal: req.signal || null,
        loadSource: (fnName) => loadProjectFunction(svc, project.id, fnName),
      });
      if (out.__stream__) {
        return new Response(out.body, { status: out.status, headers: { ...out.headers, "x-nexus-stream": "1" } });
      }
      return Response.json({ result: out });
    }

    const { source } = await loadProjectFunction(svc, project.id, name);

    const result = await executeProjectFunction(svc, {
      project, entities, integrations, name, source, trigger: body.trigger === "test" ? "test" : "frontend",
      requestId: crypto.randomUUID(),
      request: {
        method: String(body.method || "POST").toUpperCase(),
        query: body.query || {},
        headers: {},
        body: body.payload ?? null,
      },
    });

    return Response.json({
      status: result.status, body: result.body, logs: result.logs,
      duration_ms: result.duration_ms, invocation_id: result.invocation_id, error: result.error,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}
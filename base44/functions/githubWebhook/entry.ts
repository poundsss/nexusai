// Public GitHub push-webhook receiver.
//
// URL: <this function's URL>?project_id=<id>
//
// This endpoint has NO user session — authenticity comes entirely from the GitHub HMAC
// signature. All request handling — signature verification, replay protection, parsing,
// validation and import enqueue — lives in shared/githubWebhook.ts, so the endpoint and
// its test exercise exactly the same code.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleGithubWebhook } from "../../shared/githubWebhook.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("project_id");
  const rawBody = await req.text();
  const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));

  const result = await handleGithubWebhook(svc, { projectId, rawBody, headers, now: Date.now() });
  return Response.json(result.body, { status: result.status });
}
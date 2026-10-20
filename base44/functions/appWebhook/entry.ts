// Public webhook endpoint for generated projects.
//
// URL: <this function's URL>?project_id=<id>&fn=<functionName>
//
// All request handling — signature verification, rate limiting, replay protection, delivery,
// retry scheduling and audit — lives in shared/webhookEndpoint.ts, so the endpoint and its
// end-to-end test run the same code.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleWebhookRequest } from "../../shared/webhookEndpoint.ts";

export default async function (req) {
  return handleWebhookRequest(createClientFromRequest(req).asServiceRole, req);
}
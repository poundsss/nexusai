// Microsoft Teams connector-event handler — HTTP entry. Invoked by a workflow whose connector
// trigger is `integration_type=microsoft_teams` (event `created`/`updated`/`deleted`). The workflow's
// `invoke_backend_function` step passes the platform-decoded Graph notification envelope as
// `args: { data: "${ .trigger.data }" }`, so the handler receives `body.data` = `{ value: [...] }`
// (the Graph change-notification batch).
//
// This thin wrapper wires the REAL Base44 managed-connector connection
// (`getConnection('microsoft_teams')`) and the REAL Microsoft Graph transport to the shared core
// (shared/graphWebhookHandler.ts), so the entry and its certification harness run exactly the same
// logic.
//
// The Base44 platform authenticates the Graph delivery and decodes the `value[]` envelope BEFORE
// this handler runs — so this function performs NO Graph signature verification, NO subscription
// lifecycle and NO clientState check (per the audited Base44 managed-connector contract). It is
// distinct from `msGraphConnectorEvent`, which is the NATIVE Outlook/OneDrive receiver with its own
// `GraphSubscription` contract and is not reused here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleGraphWebhook } from "../../shared/graphWebhookHandler.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  // The workflow step passes the trigger payload as `args.data`; the handler receives it as
  // `body.data`. Fall back to the raw body for direct (non-workflow) invocations.
  const data = Array.isArray(body?.data?.value) ? body.data : Array.isArray(body?.value) ? body : body?.data || {};

  const result = await handleGraphWebhook({
    data,
    connector: "microsoft_teams",
    getConnection: () => base44.asServiceRole.connectors.getConnection("microsoft_teams"),
  });

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
// Gmail mailbox handler — HTTP entry. Invoked by the "Gmail Mailbox" workflow's
// `invoke_backend_function` step with `args: { data: "${ .trigger.data }" }`, so the handler
// receives the platform-pre-enriched trigger data under `body.data` (`{ has_new_non_draft_messages,
// new_message_ids, ... }`).
//
// This thin wrapper wires the REAL Base44 managed-connector connection (`getConnection('gmail')`)
// and the REAL Gmail messages API transport to the shared core (shared/gmailMailboxHandler.ts),
// so the entry and its certification harness run exactly the same logic.
//
// The Base44 platform authenticates the Gmail Pub/Sub delivery and pre-enriches the payload BEFORE
// this handler runs — so this function performs NO Pub/Sub auth, NO historyId tracking and NO
// signature verification (per the audited Base44 managed-connector contract).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleGmailMailbox } from "../../shared/gmailMailboxHandler.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  // The workflow step passes the trigger payload as `args.data`; the handler receives it as
  // `body.data`. Fall back to the raw body for direct (non-workflow) invocations.
  const data = body?.data?.new_message_ids ? body.data : body?.new_message_ids ? body : body?.data || {};

  const result = await handleGmailMailbox({
    data,
    getConnection: () => base44.asServiceRole.connectors.getConnection("gmail"),
  });

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
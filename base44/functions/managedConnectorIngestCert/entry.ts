// Focused certification for the shared managed-connector ingestion core + connector event catalog.
//
// Exercises the REAL core (shared/managedConnectorIngest.ts) and REAL catalog
// (shared/connectorEventCatalog.ts) through the REAL dispatch path (emitConnector →
// dispatchWorkflowEvent → startWorkflowRun) with scripted payloads only — no real provider
// delivery, no provider subscription, no external state.
//
// The core is the post-verification surface: a receiver has ALREADY verified the delivery. So this
// cert calls ingestConnectorDelivery directly (the contract a verified receiver relies on) and
// covers the nine required behaviors:
//   1. dispatch (a verified delivery dispatches a run);
//   2. normalization (the minimum common envelope);
//   3. provider-native event preservation (run.trigger.event is the verbatim event);
//   4. dedupe (a redelivered delivery_id → duplicate, no new run);
//   5. malformed delivery (missing event → fail closed);
//   6. unknown event (not in the catalog → fail closed);
//   7. unknown connector (not in the catalog → fail closed);
//   8. jq condition (a top-level condition gates dispatch);
//   9. idempotency (a replayed delivery is idempotent — no second run);
//  10. catalog (the registered connectors/events are present with correct sources/implementation).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { ingestConnectorDelivery } from "../../shared/managedConnectorIngest.ts";
import {
  connectorIds, connectorEventKnown, connectorEventImplemented, describeConnectorEventCatalog,
} from "../../shared/connectorEventCatalog.ts";
import { finalizeConnectorWorkflow, runsForWorkflow } from "../../shared/connectorEventCertHelpers.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `mci-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [] };
  let project = null, workspace = null;

  try {
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);

    // A plain connector workflow (no condition) for the dispatch/dedupe/normalization checks, and
    // a conditioned one (jq over the payload) added before the jq-condition check.
    await finalizeConnectorWorkflow(svc, { project, workspace, key: "mci-plain", name: "MCI Plain", connector: "slack", event: "message" });

    const runs = () => runsForWorkflow(svc, project.id, "mci-plain");
    const condRuns = () => runsForWorkflow(svc, project.id, "mci-cond");

    // --- 1. dispatch: a verified delivery dispatches a run ---
    const r1 = await ingestConnectorDelivery(svc, { project, connector: "slack", event: "message", delivery_id: "d1", payload: { text: "hi" } });
    h.check("1 a verified delivery dispatches a run",
      r1.ok === true && r1.duplicate === false && r1.matched === 1 && (await runs()).length === 1,
      `ok=${r1.ok} dup=${r1.duplicate} matched=${r1.matched} runs=${(await runs()).length}`);

    // --- 2. normalization: the minimum common envelope ---
    h.check("2 the envelope is normalized to {connector,event,delivery_id,received_at,data}",
      r1.envelope.connector === "slack" && r1.envelope.event === "message" && r1.envelope.delivery_id === "d1"
      && typeof r1.envelope.received_at === "string" && /\d{4}-\d{2}-\d{2}T/.test(r1.envelope.received_at)
      && r1.envelope.data && r1.envelope.data.text === "hi",
      `conn=${r1.envelope.connector} evt=${r1.envelope.event} did=${r1.envelope.delivery_id} data=${JSON.stringify(r1.envelope.data)}`);

    // --- 3. provider-native event preservation: the run's trigger.event is the verbatim event ---
    const run1 = (await runs())[0];
    h.check("3 the provider-native event name is preserved verbatim on the run",
      run1?.trigger?.source === "connector" && run1?.trigger?.event === "message",
      `source=${run1?.trigger?.source} event=${run1?.trigger?.event}`);

    // --- 4. dedupe: a redelivered delivery_id is a duplicate, no new run ---
    const before = (await runs()).length;
    const r2 = await ingestConnectorDelivery(svc, { project, connector: "slack", event: "message", delivery_id: "d1", payload: { text: "hi" } });
    h.check("4 a redelivered delivery_id is deduplicated (no new run)",
      r2.ok === true && r2.duplicate === true && r2.matched === 0 && (await runs()).length === before,
      `dup=${r2.duplicate} matched=${r2.matched} runs=${(await runs()).length}`);

    // --- 5. malformed delivery: missing event is rejected fail-closed, no run ---
    const r3 = await ingestConnectorDelivery(svc, { project, connector: "slack", event: "", delivery_id: "d-bad", payload: {} });
    h.check("5 a malformed delivery (missing event) is rejected fail-closed",
      r3.ok === false && r3.code === "ENVELOPE_MALFORMED" && r3.matched === 0 && (await runs()).length === before,
      `ok=${r3.ok} code=${r3.code}`);

    // --- 6. unknown event: an event not in the catalog is rejected (gmail has no `*`) ---
    const r4 = await ingestConnectorDelivery(svc, { project, connector: "gmail", event: "bogus", delivery_id: "d-unk", payload: {} });
    h.check("6 an unknown event is rejected fail-closed",
      r4.ok === false && r4.code === "UNKNOWN_CONNECTOR_EVENT" && r4.matched === 0,
      `ok=${r4.ok} code=${r4.code}`);

    // --- 7. unknown connector ---
    const r5 = await ingestConnectorDelivery(svc, { project, connector: "nope", event: "x", delivery_id: "d-nc", payload: {} });
    h.check("7 an unknown connector is rejected fail-closed",
      r5.ok === false && r5.code === "UNKNOWN_CONNECTOR",
      `ok=${r5.ok} code=${r5.code}`);

    // --- 8. jq condition: finalize a conditioned workflow; truthy dispatches, falsy does not ---
    await finalizeConnectorWorkflow(svc, { project, workspace, key: "mci-cond", name: "MCI Cond", connector: "slack", event: "message", condition: `.text == "hi"` });
    const r6 = await ingestConnectorDelivery(svc, { project, connector: "slack", event: "message", delivery_id: "d-cond-yes", payload: { text: "hi" } });
    const condYes = await condRuns();
    const r7 = await ingestConnectorDelivery(svc, { project, connector: "slack", event: "message", delivery_id: "d-cond-no", payload: { text: "yo" } });
    const condNo = await condRuns();
    // mci-plain has no condition so it matches both; mci-cond matches only when .text == "hi".
    // The falsy delivery must NOT add a cond run, so condNo === condYes (both 1) — the gate held.
    h.check("8 a jq condition gates dispatch (truthy dispatches, falsy does not)",
      r6.matched === 2 && condYes.length === 1 && r7.matched === 1 && condNo.length === condYes.length,
      `yesMatched=${r6.matched} condRuns=${condYes.length} noMatched=${r7.matched} condNoRuns=${condNo.length}`);

    // --- 9. idempotency: a replayed delivery_id is idempotent (no second run) ---
    const r8 = await ingestConnectorDelivery(svc, { project, connector: "slack", event: "message", delivery_id: "d-cond-yes", payload: { text: "hi" } });
    h.check("9 a replayed delivery is idempotent (core dedup → duplicate, no new run)",
      r8.duplicate === true && r8.matched === 0 && (await condRuns()).length === 1,
      `dup=${r8.duplicate} condRuns=${(await condRuns()).length}`);

    // --- 10. catalog: the registered connectors/events are present with correct sources ---
    const cat = describeConnectorEventCatalog();
    h.check("10 the catalog registers the implemented connectors/events with correct sources",
      connectorIds().includes("slack") && connectorIds().includes("github") && connectorIds().includes("gmail")
      && connectorEventKnown("slack", "message") && connectorEventKnown("slack", "reaction_added")
      && connectorEventKnown("github", "push") && connectorEventKnown("github", "pull_request")
      && !connectorEventKnown("gmail", "bogus")
      && connectorEventImplemented("slack", "message") && !connectorEventImplemented("gmail", "mailbox")
      && cat.connectors.slack.events.some((e) => e.name === "message" && e.source === "base44_confirmed")
      && cat.connectors.googlecalendar.events.some((e) => e.name === "events" && e.implemented)
      && cat.connectors.googledrive.events.some((e) => e.name === "changes" && e.implemented)
      && cat.connectors.googledrive.events.some((e) => e.name === "file" && e.implemented)
      && cat.connectors.microsoft_teams.events.some((e) => e.name === "created" && e.source === "provider_native"),
      `ids=${connectorIds().length} slackAny=${connectorEventKnown("slack", "reaction_added")} ghAny=${connectorEventKnown("github", "pull_request")}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    await purgeBy(svc, "WorkflowRun", { project_id: project?.id });
    await purgeBy(svc, "WorkflowDefinition", { project_id: project?.id });
    // Non-inline connector runs enqueue durable workflow.advance jobs; deleting the runs without
    // the jobs leaves retrying orphans that starve later queue workers.
    await purgeBy(svc, "BackgroundJob", { project_id: project?.id });
    // Replay CacheEntry rows for the scratch project (shared github_webhook_replay namespace).
    const replayRows = await svc.entities.CacheEntry.filter({ namespace: "github_webhook_replay" }, "-created_date", 300).catch(() => []);
    for (const row of replayRows) {
      if (scratch.projects.some((pid) => String(row.cache_key || "").includes(pid))) {
        await svc.entities.CacheEntry.delete(row.id).catch(() => {});
      }
    }
    for (const pid of scratch.projects) await svc.entities.Project.delete(pid).catch(() => {});
    if (scratch.workspace) await cleanupWorkspace(svc, scratch.workspace, []);
  }
  return Response.json(h.summary());
}
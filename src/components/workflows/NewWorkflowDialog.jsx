import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ConnectorTriggerFields from "@/components/workflows/ConnectorTriggerFields";

// New Workflow entry point — creates the next DRAFT through the EXISTING certified create flow
// (the workflows endpoint's create action). No new workflow type, no suggestions: the same
// trigger shapes the existing WorkflowCard editor manages, and steps are added afterward.
const TRIGGER_OPTIONS = [
  { id: "manual", label: "Manual" },
  { id: "event", label: "Event" },
  { id: "schedule", label: "Scheduled" },
  { id: "connector", label: "Connector" },
];

export default function NewWorkflowDialog({ projectId, open, onOpenChange, onCreated }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tType, setTType] = useState("manual");
  const [tConnector, setTConnector] = useState("");
  const [tEvent, setTEvent] = useState("");
  const [tCondition, setTCondition] = useState("");
  const [tCron, setTCron] = useState("");
  const [tFn, setTFn] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(""); setDescription(""); setTType("manual"); setTConnector(""); setTEvent(""); setTCondition(""); setTCron(""); setTFn(""); };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const trigger = { type: tType };
      if (tType === "connector") {
        if (tConnector.trim()) trigger.connector = tConnector.trim();
        if (tEvent.trim()) trigger.event = tEvent.trim();
        // DOCUMENTED (Base44): slack/slackbot connector automations REQUIRE a trigger condition —
        // sent only when the user typed one; finalization enforces it.
        if ((tConnector === "slack" || tConnector === "slackbot") && tCondition.trim()) {
          trigger.condition = tCondition.trim();
        }
      }
      if (tType === "event" && tEvent.trim()) trigger.event = tEvent.trim();
      if (tType === "schedule") {
        if (tCron.trim()) trigger.cron = tCron.trim();
        if (tFn.trim()) trigger.function_name = tFn.trim();
      }
      await base44.functions.invoke("workflows", {
        project_id: projectId, action: "create",
        name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), trigger,
      });
      toast({ title: "Workflow created as a draft" });
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not create workflow", description: e.response?.data?.error || e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
        </DialogHeader>
        <div className="space-y-2.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workflow name"
            aria-label="Workflow name"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 ring-ring"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            aria-label="Workflow description"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 ring-ring"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={tType} onChange={(e) => setTType(e.target.value)} aria-label="Trigger type" className="rounded-md border border-border bg-background px-2 py-1 text-[11.5px]">
              {TRIGGER_OPTIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            {tType === "connector" && (
              <ConnectorTriggerFields connector={tConnector} event={tEvent} condition={tCondition} onCondition={setTCondition} onConnector={setTConnector} onEvent={setTEvent} />
            )}
            {tType === "event" && (
              <input value={tEvent} onChange={(e) => setTEvent(e.target.value)} placeholder="event name, e.g. order.created" className="min-w-[180px] flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring" />
            )}
            {tType === "schedule" && (
              <>
                <input value={tCron} onChange={(e) => setTCron(e.target.value)} placeholder="cron expression" className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" />
                <input value={tFn} onChange={(e) => setTFn(e.target.value)} placeholder="function name" className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" />
              </>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/60">Created as a draft — add steps, then Validate and Finalize it from the workflow card.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => onOpenChange(false)} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-40 transition-colors">Cancel</button>
          <button onClick={create} disabled={busy || !name.trim()} className="flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-[12px] font-semibold hover:opacity-90 disabled:opacity-30 transition-opacity">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Create workflow
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
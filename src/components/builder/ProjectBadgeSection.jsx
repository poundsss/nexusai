import React, { useEffect, useState } from "react";
import { BadgeCheck, Loader2, Eye, EyeOff, Lock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Switch } from "@/components/ui/switch";

// Platform Badge visibility — the documented Base44 project-level "Made with Base44" attribution
// toggle. The badge is shown by default; hiding it is Starter+ gated. The server is the source of
// truth: this UI only reflects the server-resolved `entitled` flag and refuses to send a hide
// request the server will reject. A private app's badge is always hidden (effective_hidden), and
// the toggle is disabled in that case.
export default function ProjectBadgeSection({ project }) {
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setState({ loading: true });
    try {
      const res = await base44.functions.invoke("projectBadge", { action: "get", project_id: project?.id });
      setState({ loading: false, ...res.data });
    } catch (err) {
      setState({ loading: false, error: err.response?.data?.error || err.message });
    }
  };

  useEffect(() => { load(); }, [project?.id]);

  const onToggle = async (checked) => {
    setBusy(true);
    try {
      const res = await base44.functions.invoke("projectBadge", { action: "set", project_id: project.id, badge_hidden: checked });
      setState({ loading: false, ...res.data });
      toast({ title: checked ? "Badge hidden" : "Badge shown", description: checked ? "The attribution badge is hidden on your published app." : "The attribution badge appears on your published app." });
    } catch (err) {
      toast({ variant: "destructive", title: "Could not change badge", description: err.response?.data?.error || err.message });
      load();
    } finally { setBusy(false); }
  };

  const privateApp = state.visibility === "private";
  const entitled = !!state.entitled;

  return (
    <section className="rounded-md border border-border p-4 md:col-span-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
        <BadgeCheck className="h-3.5 w-3.5" />Platform badge
      </h3>
      {state.loading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
      ) : state.error ? (
        <p className="text-[12px] text-destructive">{state.error}</p>
      ) : (
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Switch
                checked={!!state.badge_hidden}
                disabled={busy || privateApp || !entitled}
                onCheckedChange={onToggle}
              />
              <span className="text-[12px] font-medium">
                {privateApp ? "Always hidden (private app)" : state.badge_hidden ? "Hidden" : "Shown"}
              </span>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              The “Made with Base44” attribution badge appears on your published app by default.
              {privateApp
                ? " Private apps never show the badge."
                : entitled
                  ? " Hiding it requires an active Starter or higher plan; the badge reappears if you downgrade."
                  : " Hiding it requires an active Starter or higher plan."}
            </p>
          </div>
          <div className="shrink-0 text-right">
            {privateApp ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground"><EyeOff className="h-3.5 w-3.5" />Auto-hidden</span>
            ) : entitled ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-600 dark:text-emerald-400"><Eye className="h-3.5 w-3.5" />Starter+</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground"><Lock className="h-3.5 w-3.5" />Starter+</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
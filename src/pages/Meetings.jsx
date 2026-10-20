import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import ConnectorIcon from "@/components/plugins/ConnectorIcon";
import MeetingRow from "@/components/meetings/MeetingRow";
import AccountPage from "@/components/shell/AccountPage";
import { beginConnectorConnect } from "@/components/plugins/ConnectorRegistry";

// MEETINGS — 1:1 with the Base44 "Meeting notes" surface: the heading + subtitle, two
// connection cards (Google Calendar, Microsoft Outlook) and the meeting list
// (Scheduled + Join / Recording / Notes). Connections run through the certified
// delegatedOAuth contract (list/begin) — the same calls the Connections page makes;
// meetings and their notes live in the Meeting entity.
const SERVICES = [
  { id: "googlecalendar", label: "Google Calendar" },
  { id: "microsoft", label: "Microsoft Outlook" },
];

export default function Meetings() {
  const { workspace } = useWorkspace();
  const [projectId, setProjectId] = useState("");
  const [creds, setCreds] = useState(null);
  const [meetings, setMeetings] = useState(null);
  const [connecting, setConnecting] = useState(null);

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 1 })
      .then((d) => setProjectId((cur) => cur || d.projects?.[0]?.id || ""))
      .catch(() => {});
  }, [workspace]);

  const load = useCallback(async () => {
    if (!projectId) { setCreds([]); return; }
    setCreds(null);
    try {
      const res = await base44.functions.invoke("delegatedOAuth", { action: "list", project_id: projectId });
      setCreds(res.data?.credentials || []);
    } catch {
      setCreds([]);
    }
    base44.entities.Meeting.filter({}, { sort: "-starts_at", limit: 50 })
      .then((page) => setMeetings(page.items || []))
      .catch(() => setMeetings([]));
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const connected = (id) => (creds || []).some((c) => c.provider_id === id);

  // The real existing connection flow: delegatedOAuth begin (with this app's callback as the
  // redirect target) → the provider's consent screen → /oauth/callback completes it.
  const connect = async (serviceId) => {
    if (!projectId) { toast({ variant: "destructive", title: "No app selected" }); return; }
    setConnecting(serviceId);
    try {
      const ok = await beginConnectorConnect(projectId, serviceId);
      if (!ok) toast({ variant: "destructive", title: "No authorization URL returned" });
    } catch (e) {
      toast({ variant: "destructive", title: "Connect failed", description: e.response?.data?.error || e.message });
    } finally { setConnecting(null); }
  };

  const loading = !workspace || !projectId || creds === null;

  return (
    <AccountPage
      loading={loading}
      title="Meeting notes"
      subtitle="Superagent joins your meetings as a notetaker and saves the notes and action items to your agent's library."
      maxW="max-w-4xl"
    >
      {/* Connection cards — 1:1 with the Base44 Meeting notes connect rows. */}
      <div className="space-y-2.5 mb-7">
        {SERVICES.map((s) => {
          const isConnected = connected(s.id);
          return (
            <div key={s.id} className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 shadow-sm">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
                <ConnectorIcon name={s.id} className="h-10 w-10 rounded-lg" />
              </span>
              <span className="text-[13.5px] font-semibold flex-1 min-w-0 truncate">{s.label}</span>
              {isConnected ? (
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />Connected
                </span>
              ) : (
                <button
                  onClick={() => connect(s.id)}
                  disabled={connecting === s.id}
                  className="rounded-md bg-muted px-4 py-2 text-[12.5px] font-medium text-foreground shadow-sm hover:bg-accent disabled:opacity-50 transition-colors"
                >
                  {connecting === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Meeting list */}
      {meetings === null ? (
        <div className="py-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : meetings.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground py-8 text-center rounded-xl border border-border bg-card border-dashed">
          No meetings yet — upcoming meetings you add to the calendar appear here.
        </p>
      ) : (
        <div className="space-y-2.5">
          {meetings.map((m) => <MeetingRow key={m.id} meeting={m} />)}
        </div>
      )}
    </AccountPage>
  );
}
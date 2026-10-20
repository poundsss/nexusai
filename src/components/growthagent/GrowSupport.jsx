import React, { useCallback, useEffect, useState } from "react";
import { Loader2, LifeBuoy } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { formatDistanceToNow } from "date-fns";
import GrowProjectPicker from "@/components/growthagent/GrowProjectPicker";

// Grow Support — a read-only, project-scoped projection of the certified OUTBOUND-ONLY support
// history (shared/growSupport.ts through the member-authorized `support` endpoint, action=history).
// Every field below is shown VERBATIM from the endpoint's rows: subject, queue status, attempts,
// created_at and the targeted contact. This surface reads only — it never schedules a message,
// never sends anything and never invents inbound reply handling (which stays UNIMPLEMENTED).
const STATUS_TONE = {
  pending: "text-amber-600 dark:text-amber-300",
  leased: "text-[#2563eb] dark:text-[#60a5fa]",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-300",
  dead_letter: "text-red-600 dark:text-red-300",
  cancelled: "text-muted-foreground",
};

export default function GrowSupport({ workspace }) {
  const [projectId, setProjectId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unauthorized, setUnauthorized] = useState(false);

  // The exact call the panel makes: the certified member-authorized `support` history endpoint.
  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    try {
      const res = await base44.functions.invoke("support", { project_id: pid, action: "history" });
      setMessages(res.data?.messages || []);
    } catch (e) {
      const code = e?.response?.data?.code;
      if (e?.response?.status === 403 || code === "NOT_A_MEMBER") setUnauthorized(true);
      else setError(e?.response?.data?.error || e?.message || "Could not load the support history");
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (projectId) load(projectId); }, [projectId, load]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-8">
      <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={(v) => { setProjectId(v); setMessages(null); }} />

      {loading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : unauthorized ? (
        <div className="rounded-xl border border-border bg-muted/50 px-5 py-10 text-center">
          <p className="text-[15px] font-medium text-foreground">Not authorized</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">You don't have access to this project's support history.</p>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">{error}</div>
      ) : messages.length === 0 ? (
        <div className="py-20 text-center">
          <LifeBuoy className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-[15px] font-medium text-foreground">No support messages yet</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground max-w-sm mx-auto leading-relaxed">
            Outbound support messages to this project's contacts will appear here once scheduled.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {messages.map((m) => (
            <div key={m.job_id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <LifeBuoy className="h-3.5 w-3.5 text-[#2563eb] dark:text-[#60a5fa] mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground truncate">{m.subject || "(no subject)"}</p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    {m.attempts === null || m.attempts === undefined ? "" : `${m.attempts} attempts · `}
                    {m.created_at ? formatDistanceToNow(new Date(m.created_at), { addSuffix: true }) : "—"}
                  </p>
                </div>
                <span className={`shrink-0 text-[11px] font-semibold uppercase ${STATUS_TONE[m.status] || "text-muted-foreground"}`}>{m.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
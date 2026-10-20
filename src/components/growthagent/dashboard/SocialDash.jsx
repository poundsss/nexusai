import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtWhen } from "./dashBits";

// Social Media dashboard — the project's REAL virality pipeline state and its persisted publish
// calendar (ViralityScheduledPost rows ARE the calendar), through the certified virality surface
// reads only. Statuses pass through verbatim; per-platform metrics are counts of real rows.
const PLATFORMS = [
  { id: "instagram", label: "Instagram" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "x_twitter", label: "X / Twitter" },
  { id: "tiktok", label: "TikTok" },
];

const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function SocialDash({ projectId, onConfigure, reloadKey }) {
  const [state, setState] = useState(null);
  const [posts, setPosts] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [st, cal] = await Promise.allSettled([
      base44.functions.invoke("virality", { action: "state", project_id: pid }),
      base44.functions.invoke("virality", { action: "calendar_list", project_id: pid }),
    ]);
    setState(st.status === "fulfilled" ? st.value.data : null);
    // calendar_list returns the rows as a BARE ARRAY (the rows ARE the calendar).
    setPosts(cal.status === "fulfilled" ? (Array.isArray(cal.value.data) ? cal.value.data : (cal.value.data.posts || cal.value.data.calendar || [])) : null);
    setErrors({
      state: st.status === "rejected" ? errOf(st.reason) : null,
      calendar: cal.status === "rejected" ? errOf(cal.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  const count = (st) => (posts || []).filter((p) => p.status === st).length;

  return (
    <div className="min-w-0">
      <div className="mb-5 flex flex-wrap gap-1.5">
        {PLATFORMS.map((p) => (
          <ConfigureButton key={p.id} onClick={() => onConfigure(p.id)} />
        )).map((el, i) => <span key={PLATFORMS[i].id} className="inline-flex items-center gap-2"><span className="text-[11.5px] text-muted-foreground">{PLATFORMS[i].label}</span>{el}</span>)}
      </div>

      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section title="Content pipeline state">
            {errors.state ? <StateNote tone="error" title="Pipeline state unavailable" detail={errors.state} />
              : state ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Stage" value={state.stage || UNAVAILABLE} />
                  <Stat label="Strategy" value={state.strategy_text ? "present" : UNAVAILABLE} hint={state.strategy_text ? `${String(state.strategy_text).length} chars on file` : "no strategy generated yet"} />
                  <Stat label="Plan" value={state.plan ? "present" : UNAVAILABLE} hint={state.plan?.plan_id ? `plan ${state.plan.plan_id}` : null} />
                </div>
              ) : null}
            {state?.last_error ? <div className="mt-2"><StateNote tone="error" title="Last pipeline error" detail={<Verbatim value={state.last_error} />} /></div> : null}
          </Section>

          <Section title="Publish calendar (persisted rows)">
            {errors.calendar ? <StateNote tone="error" title="Calendar unavailable" detail={errors.calendar} />
              : !posts ? null
              : posts.length === 0 ? <StateNote tone="empty" title="No calendar posts yet" detail="Zero is a real count — nothing was scheduled. Plan content through Configure / launch." />
              : (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Scheduled" value={fmtInt(count("scheduled"))} />
                    <Stat label="Posted" value={fmtInt(count("posted"))} />
                    <Stat label="Failed" value={fmtInt(count("failed"))} />
                    <Stat label="Proposals" value={fmtInt(count("proposal"))} />
                  </div>
                  <div className="space-y-2">
                    {[...posts].sort((a, b) => String(a.scheduled_at || "").localeCompare(String(b.scheduled_at || ""))).map((p) => (
                      <div key={p.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
                        <div className="flex items-center gap-2 text-[12px]">
                          <p className="min-w-0 flex-1 truncate font-medium text-foreground">{p.title || p.body || "(untitled post)"}</p>
                          <span className="text-[11px] font-semibold uppercase text-muted-foreground">{p.status}</span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{p.platform || UNAVAILABLE} · {fmtWhen(p.scheduled_at)}{p.publish_error ? ` · ${p.publish_error}` : ""}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
          </Section>
        </>
      )}
    </div>
  );
}
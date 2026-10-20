import React, { useState } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// One row of the meeting list, 1:1 with the Base44 Meeting notes surface:
// flat rows on the page background (no cards) — muted title + relative time on the
// left, overlapping initials avatars + "N people", and the right-side action set
// by status (Scheduled + Join / Recording / Notes).
function initials(list) {
  return list || [];
}

export default function MeetingRow({ meeting }) {
  const [openNotes, setOpenNotes] = useState(false);
  const [notes, setNotes] = useState(meeting.notes || "");
  const [saving, setSaving] = useState(false);
  const people = initials(meeting.participants).length || 0;

  const when = () => {
    const d = meeting.starts_at ? new Date(meeting.starts_at) : null;
    if (!d || isNaN(d.getTime())) return "";
    const mins = Math.round((d.getTime() - Date.now()) / 60000);
    if (mins > 1) return `In ${mins} minutes`;
    if (mins >= -2) return "Starting now";
    const yesterday = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, yesterday)) {
      const h = d.getHours(); const m = String(d.getMinutes()).padStart(2, "0");
      const ampm = h >= 12 ? "PM" : "AM"; const h12 = h % 12 || 12;
      return `Yesterday, ${h12}:${m} ${ampm}`;
    }
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  const join = () => {
    if (meeting.meet_url) window.open(meeting.meet_url, "_blank", "noopener");
    else toast({ variant: "destructive", title: "No meeting link", description: "This meeting has no join URL yet." });
  };

  const saveNotes = async () => {
    setSaving(true);
    try {
      await base44.entities.Meeting.update(meeting.id, { notes });
      toast({ title: "Notes saved" });
      setOpenNotes(false);
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e.response?.data?.error || e.message });
    } finally { setSaving(false); }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent/60">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-foreground/70">{meeting.title}</div>
        <div className="text-[12.5px] text-muted-foreground mt-0.5">{when()}</div>
        <div className="mt-2 flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {initials(meeting.participants).map((ini, i) => (
              <span key={`${ini}-${i}`} className="grid h-5 w-5 place-items-center rounded-full bg-muted text-[8.5px] font-medium text-muted-foreground ring-2 ring-background">
                {ini}
              </span>
            ))}
          </span>
          <span className="text-[12px] text-muted-foreground">{people} {people === 1 ? "person" : "people"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-0.5 shrink-0">
          {meeting.status === "scheduled" && (
          <>
            <span className="rounded-md bg-muted px-3 py-1.5 text-[12.5px] text-muted-foreground">Scheduled</span>
            <button
              onClick={join}
              className="rounded-md bg-muted-foreground px-4 py-2 text-[12.5px] font-medium text-background shadow-sm hover:bg-muted-foreground/90 transition-colors"
            >
              Join
            </button>
          </>
        )}
        {meeting.status === "recording" && (
          <span className="rounded-md bg-muted px-3 py-1.5 text-[12.5px] text-muted-foreground">Recording</span>
        )}
        {meeting.status === "done" && (
          <button
            onClick={() => setOpenNotes((v) => !v)}
            className="flex items-center gap-1.5 rounded-md border border-border px-3.5 py-2 text-[12.5px] text-muted-foreground hover:bg-accent transition-colors"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${openNotes ? "rotate-180" : ""}`} />
            Notes
          </button>
        )}
      </div>
      {meeting.status === "done" && openNotes && (
        <div className="mt-2 px-2 pb-1 border-t border-border pt-3">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes and action items…"
            className="w-full min-h-[96px] rounded-lg border border-border bg-background p-3 text-[13px] outline-none focus:ring-1 ring-ring resize-y"
          />
          <div className="mt-2 flex justify-end">
            <button
              onClick={saveNotes}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-muted-foreground px-4 py-2 text-[12.5px] font-medium text-background shadow-sm hover:bg-muted-foreground/90 disabled:opacity-50 transition-colors"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save notes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
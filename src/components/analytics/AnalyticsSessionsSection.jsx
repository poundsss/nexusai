import React, { useEffect, useState } from "react";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";
import { Button } from "@/components/ui/button";

const PAGE = 25;

// Sessions for one application, one bounded page at a time.
//
// The server returns only its own scrubbed session projection and bounds the page size, so this
// renders whatever came back and never asks for an unbounded list. `returned === PAGE` is the only
// signal a further page may exist — the session query reports no total.
export default function AnalyticsSessionsSection({ query }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    query("sessions", { limit: PAGE, offset: page * PAGE })
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) { setData(null); setError(e.response?.data?.error || e.message || "Sessions unavailable"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, page]);

  const sessions = data?.sessions || [];
  return (
    <Section title="Sessions" description={`Page ${page + 1}${data ? ` · ${data.returned} shown` : ""}`}>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : loading && !data ? (
        <p className="text-[13px] text-muted-foreground">Loading sessions…</p>
      ) : (
        <>
          <DataList
            empty="No sessions in this environment."
            columns={[
              { key: "session_key", label: "Session", mono: true, render: (s) => s.session_key },
              { key: "status", label: "Status", render: (s) => <span className="text-muted-foreground">{s.status}</span> },
              { key: "actor", label: "Actor", render: (s) => <span className="text-muted-foreground">{s.app_user_id ? "Signed in" : "Anonymous"}</span> },
              { key: "entry_page", label: "Entry page", mono: true, render: (s) => s.entry_page || "—" },
              { key: "event_count", label: "Events", align: "right", render: (s) => (s.event_count ?? 0).toLocaleString() },
              { key: "started_at", label: "Started", align: "right", render: (s) => <span className="text-muted-foreground">{s.started_at ? new Date(s.started_at).toLocaleString() : "—"}</span> },
            ]}
            rows={sessions}
          />
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={loading || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
            <Button variant="outline" size="sm" disabled={loading || sessions.length < PAGE} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </>
      )}
    </Section>
  );
}
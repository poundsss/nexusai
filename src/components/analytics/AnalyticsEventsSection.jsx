import React, { useEffect, useState } from "react";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";
import { Button } from "@/components/ui/button";

const PAGE = 25;

// Recent events, one bounded page at a time. Only the server's scrubbed projection is rendered, and
// property values are never displayed — a credential-like field can therefore never reach the screen.
export default function AnalyticsEventsSection({ query }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    query("events", { limit: PAGE, offset: page * PAGE })
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) { setData(null); setError(e.response?.data?.error || e.message || "Events unavailable"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, page]);

  const events = data?.events || [];
  return (
    <Section title="Recent events" description={`Page ${page + 1}${data ? ` · ${data.total_matched} matched` : ""}`}>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : loading && !data ? (
        <p className="text-[13px] text-muted-foreground">Loading events…</p>
      ) : (
        <>
          <DataList
            empty="No events in this range."
            columns={[
              { key: "event_name", label: "Event", mono: true, render: (e) => e.event_name },
              { key: "event_type", label: "Type", render: (e) => <span className="text-muted-foreground">{e.event_type}</span> },
              { key: "page", label: "Page", mono: true, render: (e) => e.page || "—" },
              { key: "properties", label: "Properties", align: "right", render: (e) => <span className="text-muted-foreground">{Object.keys(e.properties || {}).length} field(s)</span> },
              { key: "occurred_at", label: "When", align: "right", render: (e) => <span className="text-muted-foreground">{e.occurred_at ? new Date(e.occurred_at).toLocaleString() : "—"}</span> },
            ]}
            rows={events}
          />
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={loading || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
            <Button variant="outline" size="sm" disabled={loading || !data?.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </>
      )}
    </Section>
  );
}
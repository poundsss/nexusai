import React, { useCallback, useEffect, useState } from "react";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";
import { Button } from "@/components/ui/button";
import EventSchemaForm from "./EventSchemaForm";

// The project's registered event definitions.
//
// Lists through the existing `schemas` action and writes through `register_schema`; both are
// authorized server-side, so an operator without analytics.manage sees the list and gets the
// server's refusal when saving instead of a client-side guess.
export default function AnalyticsSchemasSection({ query }) {
  const [schemas, setSchemas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | { schema } | { schema: null }
  const [saved, setSaved] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    return query("schemas")
      .then((d) => { setSchemas(d.schemas || []); setError(null); })
      .catch((e) => { setSchemas(null); setError(e.response?.data?.error || e.message || "Schemas unavailable"); })
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const submit = async (input) => {
    const d = await query("register_schema", input);
    setEditing(null);
    setSaved(`${d.schema.event_name} v${d.schema.event_version} saved.`);
    await load();
  };

  return (
    <Section
      title="Event schemas"
      description="A name plus version is one immutable definition — saving an existing pair updates it."
      actions={!editing && <Button size="sm" variant="outline" onClick={() => { setSaved(null); setEditing({ schema: null }); }}>Register schema</Button>}
    >
      {editing && (
        <div className="mb-4">
          <EventSchemaForm initial={editing.schema} onSubmit={submit} onCancel={() => setEditing(null)} />
        </div>
      )}
      {error ? (
        <p className="text-[13px] text-destructive">{error}</p>
      ) : loading && !schemas ? (
        <p className="text-[13px] text-muted-foreground">Loading schemas…</p>
      ) : (
        <>
          <DataList
            empty="No event schemas registered. Events are accepted without a declared shape."
            columns={[
              { key: "event_name", label: "Event", mono: true, render: (s) => s.event_name },
              { key: "event_version", label: "Version", render: (s) => `v${s.event_version}` },
              { key: "event_type", label: "Category", render: (s) => <span className="text-muted-foreground">{s.event_type}</span> },
              { key: "status", label: "Status", render: (s) => <span className={s.status === "active" ? "" : "text-muted-foreground"}>{s.status}</span> },
              { key: "required", label: "Required", align: "right", render: (s) => (s.required_properties || []).length },
              { key: "strict", label: "Strict", render: (s) => (s.strict ? "Yes" : "No") },
              { key: "edit", label: "", align: "right", render: (s) => <Button size="sm" variant="ghost" onClick={() => { setSaved(null); setEditing({ schema: s }); }}>Edit</Button> },
            ]}
            rows={schemas || []}
          />
          {saved && <p className="mt-3 text-[12.5px] text-muted-foreground">{saved}</p>}
        </>
      )}
    </Section>
  );
}
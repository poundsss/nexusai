import React from "react";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString();

// Error analytics. Only the server's structured, scrubbed error fields are rendered — codes,
// categories and pages — never a payload, a property value or a credential-like field.
export default function AnalyticsErrorsSection({ errors }) {
  return (
    <Section title="Errors" description={`${fmt(errors?.total_errors)} error events, ${fmt(errors?.affected_users)} affected users.`}>
      <div className="grid gap-6 md:grid-cols-2">
        <DataList
          empty="No errors in this range."
          columns={[
            { key: "key", label: "Error code", mono: true, render: (r) => r.key },
            { key: "count", label: "Count", align: "right", render: (r) => fmt(r.count) },
          ]}
          rows={errors?.by_code || []}
        />
        <DataList
          empty="No error pages in this range."
          columns={[
            { key: "key", label: "Page", mono: true, render: (r) => r.key },
            { key: "count", label: "Count", align: "right", render: (r) => fmt(r.count) },
          ]}
          rows={errors?.by_page || []}
        />
      </div>
    </Section>
  );
}
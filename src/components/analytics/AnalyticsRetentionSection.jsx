import React from "react";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString();

// Server-computed retention cohorts for the selected, bounded window.
export default function AnalyticsRetentionSection({ retention }) {
  const totals = retention?.totals || {};
  return (
    <Section
      title="Retention"
      description={`${fmt(totals.actors)} actors, ${fmt(totals.retained)} returned within ${retention?.period_days || 7} days (${totals.retention_rate || 0}%).`}
    >
      <DataList
        empty="No cohorts in this range."
        columns={[
          { key: "cohort", label: "Cohort", mono: true, render: (r) => r.cohort },
          { key: "actors", label: "Actors", align: "right", render: (r) => fmt(r.actors) },
          { key: "retained", label: "Retained", align: "right", render: (r) => fmt(r.retained) },
          { key: "retention_rate", label: "Rate", align: "right", render: (r) => `${r.retention_rate}%` },
        ]}
        rows={retention?.cohorts || []}
      />
    </Section>
  );
}
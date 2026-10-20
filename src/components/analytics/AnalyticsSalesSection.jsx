import React from "react";
import Section from "@/components/shell/Section";
import MetricRow from "@/components/shell/MetricRow";
import DataList from "@/components/shell/DataList";

// Sales Overview for one application — Stripe payments only, matching the documented Base44
// "Sales Overview" surface. Totals (gross, net, transactions, customers, refunds) plus the most
// recent transactions. Reads through the authorized analytics operator API.
const money = (cents, currency = "USD") =>
  new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);

export default function AnalyticsSalesSection({ sales }) {
  if (!sales) return null;
  const totals = sales.totals || {};
  return (
    <Section
      title="Sales overview"
      description="Payments processed through Stripe for this application — gross, net, transactions, customers and refunds."
    >
      <div className="space-y-5">
        <MetricRow
          items={[
            { label: "Gross", value: money(totals.gross_cents, "USD"), sub: "Stripe payments" },
            { label: "Net", value: money(totals.net_cents, "USD"), sub: "after refunds" },
            { label: "Transactions", value: Number(totals.transactions || 0).toLocaleString(), sub: "charge events" },
            { label: "Customers", value: Number(totals.customers || 0).toLocaleString(), sub: "unique buyers" },
            { label: "Refunds", value: money(totals.refunds_cents, "USD"), sub: `${Number(totals.refund_count || 0)} refund(s)` },
          ]}
        />
        <DataList
          empty="No Stripe transactions in this range yet."
          columns={[
            { key: "occurred_at", label: "When", render: (t) => <span className="text-muted-foreground">{t.occurred_at ? new Date(t.occurred_at).toLocaleString() : "—"}</span> },
            { key: "event_type", label: "Type", render: (t) => <span className="capitalize">{String(t.event_type || "—").replace(/_/g, " ")}</span> },
            { key: "status", label: "Status", render: (t) => <span className="capitalize text-muted-foreground">{t.status || "—"}</span> },
            { key: "plan_code", label: "Plan", mono: true, render: (t) => t.plan_code || "—" },
            { key: "amount_cents", label: "Amount", align: "right", render: (t) => money(t.amount_cents, t.currency || "USD") },
          ]}
          rows={sales.recent || []}
        />
      </div>
    </Section>
  );
}
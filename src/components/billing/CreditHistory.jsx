import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Loader2, ArrowDownLeft, ArrowUpLeft, RotateCcw, Coins } from "lucide-react";

// Credit history from the authoritative ledger statement. Shows purchases, AI usage,
// refunds and adjustments with timestamps and amounts. Only credit amounts are shown —
// provider monetary costs are never exposed to non-admin users.
function impactOf(amount, reservedDelta, pool) {
  const held = Number(reservedDelta) || 0;
  if (amount) return `${amount > 0 ? "+" : "−"}${Math.abs(amount).toLocaleString()} ${pool} balance`;
  if (held > 0) return `Holds ${held.toLocaleString()} ${pool}`;
  if (held < 0) return `Releases ${Math.abs(held).toLocaleString()} ${pool} hold`;
  return "No change";
}

export default function CreditHistory({ workspaceId, limit = 30 }) {
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("commerce", { action: "statement", workspace_id: workspaceId, limit });
      setEntries(res.data?.entries || res.data || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (workspaceId) load(); }, [workspaceId]);

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="text-[12px] text-destructive">{error}</div>;

  const rows = Array.isArray(entries) ? entries : (entries?.entries || []);

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-[13px] text-muted-foreground">
        <Coins className="h-6 w-6 mx-auto mb-2 text-muted-foreground/30" />
        No credit transactions yet.
      </div>
    );
  }

  const ICON = { purchase: ArrowDownLeft, credit_purchase: ArrowDownLeft, subscription_started: ArrowDownLeft, ai_usage: ArrowUpLeft, usage: ArrowUpLeft, refund: RotateCcw, admin_adjustment: Coins, adjustment: Coins };
  const TONE = { purchase: "text-emerald-600", credit_purchase: "text-emerald-600", subscription_started: "text-emerald-600", ai_usage: "text-muted-foreground", usage: "text-muted-foreground", refund: "text-blue-600", admin_adjustment: "text-amber-600", adjustment: "text-amber-600" };

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="min-w-full divide-y divide-border text-left text-[13px]">
        <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5">Type</th>
            <th className="px-4 py-2.5">Pool</th>
            <th className="px-4 py-2.5 text-right">Amount</th>
            <th className="px-4 py-2.5">Balance impact</th>
            <th className="px-4 py-2.5">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => {
            const type = r.event_type || r.type || r.entry_type || "adjustment";
            const amount = r.credits ?? r.amount ?? 0;
            const positive = amount > 0;
            const Icon = ICON[type] || Coins;
            const tone = TONE[type] || "text-muted-foreground";
            const pool = r.credit_type === "integration" ? "Integration" : "Message";
            return (
              <tr key={r.id || i} className="hover:bg-muted/30">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Icon className={`h-3.5 w-3.5 ${tone}`} />
                    <span className="capitalize">{type.replace(/[._]/g, " ")}</span>
                    {r.reason && <span className="text-[11px] text-muted-foreground/60 truncate">· {r.reason}</span>}
                  </div>
                </td>
                <td className="px-4 py-2.5">{pool}</td>
                <td className={`px-4 py-2.5 text-right font-mono tabular-nums font-medium ${positive ? "text-emerald-600" : "text-foreground"}`}>
                  {positive ? "+" : ""}{amount.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{impactOf(amount, r.reserved_delta, pool)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {r.created_date ? new Date(r.created_date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
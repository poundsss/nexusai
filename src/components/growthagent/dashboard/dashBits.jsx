import React from "react";

// Shared, honest primitives for the Grow module dashboards. UNAVAILABLE ("—") is the ONLY way
// a dashboard may express data it has no input for — zero is reserved for a real measured 0.
export const UNAVAILABLE = "—";

export const fmtInt = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? UNAVAILABLE : Number(v).toLocaleString("en-US"));
export const fmtUsdFromMicros = (micros) => (micros == null || Number.isNaN(Number(micros)) ? UNAVAILABLE : `$${(Number(micros) / 1e6).toFixed(2)}`);
export const fmtUsd = (v) => (v == null || Number.isNaN(Number(v)) ? UNAVAILABLE : `$${Number(v).toFixed(2)}`);
export const fmtShare = (v) => (v == null || Number.isNaN(Number(v)) ? UNAVAILABLE : `${Math.round(Number(v) * 100)}%`);
export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : UNAVAILABLE);

// A value older than `days` (or missing) is STALE — a data-freshness judgment, never a value.
export const isStale = (iso, days = 8) => !iso || Date.now() - Date.parse(iso) > days * 86400000;

const TONE = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  empty: "border-border bg-muted/40 text-muted-foreground",
  disconnected: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  stale: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function Stat({ label, value, hint }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[15px] font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// A whole section's state: loading spinner, empty, disconnected, blocked, stale, or a real error.
export function StateNote({ tone = "empty", title, detail }) {
  return (
    <div className={`rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed ${TONE[tone] || TONE.empty}`}>
      <p className="font-medium">{title}</p>
      {detail ? <p className="mt-0.5 opacity-90">{detail}</p> : null}
    </div>
  );
}

// A measured funnel: stage label, value, bar width relative to the first stage. Values are
// REAL counts only — an unavailable stage is rendered "—" by fmtInt, never a fabricated 0.
export function Funnel({ stages }) {
  const base = Number(stages?.[0]?.value || 0);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {(stages || []).map((s, i) => {
        const v = s.value == null ? null : Number(s.value);
        const pct = v == null || base <= 0 ? 0 : Math.max(v > 0 ? 3 : 0, Math.round((v / base) * 100));
        return (
          <div key={s.label} className={`flex items-center gap-3 px-3 py-2.5 ${i ? "border-t border-border/60" : ""}`}>
            <span className="w-24 shrink-0 text-[12px] font-medium text-muted-foreground sm:w-28">{s.label}</span>
            <div className="h-6 min-w-0 flex-1 rounded-md bg-muted/60">
              <div className="h-full rounded-md bg-brand/25" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right text-[13px] font-semibold text-foreground sm:w-20">{fmtInt(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Section({ title, right, children }) {
  return (
    <section className="mt-6">
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </div>
      {children}
    </section>
  );
}

export function ConfigureButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-accent">
      Configure / launch
    </button>
  );
}

// Machine-checkable codes and blocker text are shown VERBATIM — never rewritten or translated.
export function Verbatim({ value }) {
  if (value == null || value === "") return <span className="text-muted-foreground">none</span>;
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">{value}</code>;
}
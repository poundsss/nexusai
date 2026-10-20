import React, { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, ScanSearch, ChevronRight, Wrench, CheckCircle2, ShieldAlert, Lightbulb, Clock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { formatDistanceToNow } from "date-fns";

// SEO & GEO checklist — Deploy pane section. A thin projection over the CERTIFIED SeoScan
// surface (base44/functions/seoScan: run/get/list through loadAuthorizedProject + audit).
// Scans are free and synchronous; the run action refuses unpublished projects (NOT_PUBLISHED
// surfaces as-is in the toast). No new persistence, no credits, no AI calls here.
//
// Checklist filters are a CLIENT projection over the persisted checks:
//   Urgent      = failed + critical (capped the score)
//   Recommended = failed + non-critical
//   Done        = passed
// "Fix with AI" only PRE-FILLS the Builder AI chat with a fix prompt (via onFixWithAI) —
// the user sends it themselves, exactly like Base44's checklist flow.
const FILTERS = [
  { key: "urgent", label: "Urgent", icon: ShieldAlert, tone: "text-destructive" },
  { key: "recommended", label: "Recommended", icon: Lightbulb, tone: "text-amber-600 dark:text-amber-400" },
  { key: "done", label: "Done", icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400" },
];

const bucketOf = (c) => (c.status === "passed" ? "done" : c.critical ? "urgent" : "recommended");
const fixPromptOf = (c) =>
  `Fix this SEO issue in my app and make it pass the scan: "${c.label}".${c.detail ? ` Context from the scan: ${c.detail}.` : ""} Keep everything else unchanged — this is a focused fix only.`;

const emptyCounts = { urgent: 0, recommended: 0, done: 0 };

export default function SeoChecklist({ projectId, onFixWithAI }) {
  const [scan, setScan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("urgent");
  const [openCheck, setOpenCheck] = useState(null);

  // Latest scan only — older version-bound rows stay in the append-only history.
  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("seoScan", { action: "list", project_id: projectId, limit: 1 });
      setScan(res.data?.scans?.[0] || null);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const runScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await base44.functions.invoke("seoScan", { action: "run", project_id: projectId });
      setScan(res.data.scan);
      setError(null);
      toast({ title: "Scan complete", description: `Score ${res.data.scan.score}/100 · grade ${res.data.scan.grade}` });
    } catch (e) {
      // Unpublished projects keep the certified NOT_PUBLISHED refusal, surfaced as-is.
      toast({ variant: "destructive", title: "Scan failed", description: e.response?.data?.error || e.message });
    } finally {
      setScanning(false);
    }
  };

  const checks = (scan?.categories || []).flatMap((cat) => (cat.checks || []).map((c) => ({ ...c, category: cat.category })));
  const counts = scan ? checks.reduce((m, c) => ({ ...m, [bucketOf(c)]: m[bucketOf(c)] + 1 }), emptyCounts) : emptyCounts;
  const visible = checks.filter((c) => bucketOf(c) === filter);
  const EMPTY_TEXT = { urgent: "No urgent issues — nothing is directly hurting visibility.", recommended: "No recommended improvements left.", done: "No passed checks yet." };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ScanSearch className="h-3.5 w-3.5" />SEO &amp; GEO
        </h3>
        <button
          onClick={runScan}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium text-foreground hover:bg-accent/60 disabled:opacity-50 transition-colors"
        >
          {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanSearch className="h-3 w-3" />}
          {scan ? "Scan again" : "Run scan"}
        </button>
      </div>

      {loading ? (
        <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : error ? (
        <div className="flex items-start gap-2 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-[12px]">{error}</div>
        </div>
      ) : !scan ? (
        <p className="p-3 text-[12px] text-muted-foreground/60">No scan yet — run one to see your app's SEO checklist.</p>
      ) : scan.status === "FAILED" ? (
        <p className="p-3 text-[12px] text-destructive">{scan.error || "The last scan failed."}</p>
      ) : (
        <div className="p-3">
          {/* Score row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className="text-[18px] font-semibold tabular-nums">{scan.score}<span className="text-muted-foreground/60 text-[12px]">/100</span></span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-bold uppercase">{scan.grade}</span>
            {scan.critical_capped && <span className="text-destructive text-[11px]">capped by critical issues</span>}
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground/60">
              <Clock className="h-3 w-3" />v{scan.version_number}{scan.completed_at ? ` · ${formatDistanceToNow(new Date(scan.completed_at), { addSuffix: true })}` : ""}
            </span>
          </div>

          {/* Filters */}
          <div className="mt-2.5 flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => { setFilter(f.key); setOpenCheck(null); }}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${filter === f.key ? "bg-foreground text-background" : "border border-border text-muted-foreground hover:text-foreground"}`}
              >
                <f.icon className={`h-3 w-3 ${filter === f.key ? "" : f.tone}`} />
                {f.label}
                <span className="tabular-nums opacity-70">{counts[f.key]}</span>
              </button>
            ))}
          </div>

          {/* Checklist */}
          {visible.length === 0 ? (
            <p className="mt-2 rounded-md border border-dashed border-border p-3 text-center text-[11.5px] text-muted-foreground/60">{EMPTY_TEXT[filter]}</p>
          ) : (
            <div className="mt-2 divide-y divide-border rounded-md border border-border">
              {visible.map((c) => {
                const open = openCheck === c.id;
                const failed = c.status !== "passed";
                return (
                  <div key={c.id}>
                    <button onClick={() => setOpenCheck(open ? null : c.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-accent/40 transition-colors">
                      <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? (c.critical ? "bg-destructive" : "bg-amber-500") : "bg-emerald-500"}`} />
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.critical && failed && <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">critical</span>}
                    </button>
                    {open && (
                      <div className="px-3 pb-2.5 pl-9">
                        {c.detail && <p className="text-[11.5px] text-muted-foreground">{c.detail}</p>}
                        <p className="mt-1 text-[10.5px] text-muted-foreground/60">category: {c.category} · weight {c.weight}</p>
                        {failed && onFixWithAI && (
                          <button
                            onClick={() => onFixWithAI(fixPromptOf(c))}
                            className="mt-2 flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium text-foreground hover:bg-accent/60 transition-colors"
                          >
                            <Wrench className="h-3 w-3" />Fix with AI
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-[10.5px] text-muted-foreground/60">Scan again after fixes to refresh the score. Scans are free.</p>
        </div>
      )}
    </div>
  );
}
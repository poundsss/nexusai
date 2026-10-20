import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, RefreshCw, Loader2, AlertTriangle, Wand2, Wrench, EyeOff, RotateCcw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Project security scan — the certified securityScan surface (run / get / ignore / restore).
// Read-only GET never starts a scan; run enqueues a background scan; ignore/restore manage the
// ignored_fingerprints lifecycle. Findings are never auto-fixed; "Fix with AI" only prefills the
// builder chat with the finding text (the existing onFixWithAI pattern).
const SCAN_GROUPS = [
  "rls_recommendations", "hardcoded_secrets", "backend_functions", "credit_protection",
  "dependency_vulnerabilities", "static_code_findings", "header_recommendations",
];
const GROUP_LABEL = {
  rls_recommendations: "Row-level security", hardcoded_secrets: "Hardcoded secrets",
  backend_functions: "Backend functions", credit_protection: "Credit protection",
  dependency_vulnerabilities: "Dependency vulnerabilities", static_code_findings: "Static code",
  header_recommendations: "Security headers",
};
const STATUS = {
  none: { label: "Not scanned", tone: "bg-muted text-muted-foreground" },
  pending: { label: "Pending", tone: "bg-amber-500/10 text-amber-600" },
  scanning: { label: "Scanning", tone: "bg-amber-500/10 text-amber-600" },
  up_to_date: { label: "Up to date", tone: "bg-emerald-500/10 text-emerald-600" },
  out_of_date: { label: "Out of date", tone: "bg-amber-500/10 text-amber-600" },
  scan_failed: { label: "Scan failed", tone: "bg-destructive/10 text-destructive" },
};
const SEV = {
  Critical: "text-destructive", High: "text-rose-600",
  Medium: "text-amber-600", Low: "text-muted-foreground",
};

function findingText(g, f) {
  const parts = [GROUP_LABEL[g] || g];
  if (f.title) parts.push(f.title);
  if (f.category) parts.push(f.category);
  if (f.file) parts.push(`${f.file}${f.line ? `:${f.line}` : ""}`);
  if (f.message) parts.push(f.message);
  if (f.package) parts.push(`${f.package}${f.version ? `@${f.version}` : ""}`);
  return parts.join(" · ");
}

// The "Fix" action prefills the builder chat with a SPECIFIC remediation the AI agent then applies
// through the EXISTING dependency mutation path (applyDependencyChange) — no package-update
// infrastructure is invented and nothing is auto-patched. The "Resolve with AI" fallback is used
// when no direct remediation path exists (fix_available false).
function dependencyFixPrompt(f) {
  if (f.fix_type === "pin_version") return `Pin the floating dependency \`${f.package}\` to the exact version \`${f.recommended_version}\` by updating the manifest range and regenerating the lockfile through the dependency update mechanism.`;
  if (f.fix_type === "upgrade") return `Upgrade the vulnerable dependency \`${f.package}\` from \`${f.version}\` to the fixed version \`${f.recommended_version}\` through the dependency update mechanism.`;
  if (f.fix_type === "lockfile") return `Regenerate the lockfile so \`${f.package}\` is pinned and integrity-verified, through the dependency update mechanism.`;
  return `Resolve this dependency security finding: ${f.package}@${f.version}.`;
}

export default function SecurityScanSection({ projectId, onFixWithAI, onCenterView }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await base44.functions.invoke("securityScan", { action: "get", project_id: projectId });
      setData(res.data);
    } catch (e) {
      setData({ error: e.response?.data?.error || e.message });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll while a scan is in flight.
  useEffect(() => {
    if (!data?.status || (data.status !== "pending" && data.status !== "scanning")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [data?.status, load]);

  const run = async () => {
    setRunning(true);
    try {
      const res = await base44.functions.invoke("securityScan", { action: "run", project_id: projectId, language: "en" });
      setData(res.data);
      toast({ title: res.data?.status === "up_to_date" ? "Scan is up to date" : "Scan started", description: res.data?.status === "up_to_date" ? "No changes since the last scan." : "Running a security scan in the background." });
    } catch (e) {
      toast({ variant: "destructive", title: "Scan could not start", description: e.response?.data?.error || e.message });
    } finally { setRunning(false); }
  };

  const ignore = async (fingerprint) => {
    setBusy(fingerprint);
    try {
      const res = await base44.functions.invoke("securityScan", { action: "ignore", project_id: projectId, fingerprint });
      setData(res.data);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not ignore", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };
  const restore = async (fingerprint) => {
    setBusy(fingerprint);
    try {
      const res = await base44.functions.invoke("securityScan", { action: "restore", project_id: projectId, fingerprint });
      setData(res.data);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not restore", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const status = data?.status || "none";
  const st = STATUS[status] || STATUS.none;
  const result = data?.result || null;
  const ignored = result?.ignored_fingerprints || [];
  const totalFindings = result ? SCAN_GROUPS.reduce((n, g) => n + ((result[g] || []).length), 0) : 0;

  return (
    <section className="rounded-md border border-border p-4 md:col-span-2">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Security scan</h3>
        <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${st.tone}`}>
          {status === "pending" || status === "scanning" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {st.label}
        </span>
        <button onClick={load} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" /></button>
        <button onClick={run} disabled={running || status === "pending" || status === "scanning"} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
          {status === "none" ? "Run scan" : "Re-scan"}
        </button>
      </div>

      {loading ? (
        <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : data?.error ? (
        <p className="flex items-center gap-1.5 text-[12px] text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{data.error}</p>
      ) : !result ? (
        <p className="text-[12px] text-muted-foreground/70">No scan result yet. Run a scan to see findings for this app.</p>
      ) : (
        <div className="space-y-3">
          {result.analysis_summary && <p className="text-[12.5px] text-muted-foreground">{result.analysis_summary}</p>}

          {data?.static_code_enabled === false && (
            <p className="flex items-center gap-1.5 text-[11.5px] text-amber-600"><ShieldAlert className="h-3.5 w-3.5" />Code-vulnerability scanning requires a Builder plan or higher. Other checks still ran.</p>
          )}

          {totalFindings === 0 && (
            <p className="text-[12px] text-emerald-600 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />No active findings across the scanned groups.</p>
          )}

          {SCAN_GROUPS.map((g) => {
            const findings = result[g] || [];
            if (!findings.length) return null;
            return (
              <div key={g} className="rounded-md border border-border">
                <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/60">
                  <span className="text-[11.5px] font-semibold">{GROUP_LABEL[g] || g}</span>
                  <span className="text-[10.5px] text-muted-foreground">{findings.length}</span>
                </div>
                <ul className="divide-y divide-border/40">
                  {findings.map((f, i) => (
                    <li key={f.fingerprint || i} className="px-2.5 py-1.5 text-[12px]">
                      <div className="flex items-start gap-2">
                        {f.severity && <span className={`shrink-0 text-[10px] font-semibold uppercase ${SEV[f.severity] || "text-muted-foreground"}`}>{f.severity}</span>}
                        <span className="min-w-0 flex-1 text-muted-foreground break-words">{findingText(g, f)}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {/* Type-specific fix actions (DOCUMENTED Base44): RLS recommendations → the
                              existing Data/permissions pane (review + apply, never auto-applied); code
                              findings → existing Fix-with-AI chat prefill. Dependency upgrade has no
                              existing UI update mechanism, so no fix action is offered there. Fixes are
                              never applied automatically. */}
                          {g === "rls_recommendations" && onCenterView && (
                            <button onClick={() => onCenterView("data")} title="Review permissions" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                              <ShieldCheck className="h-3 w-3" />
                            </button>
                          )}
                          {g === "static_code_findings" && onFixWithAI && (
                            <button onClick={() => onFixWithAI(`Fix this security finding: ${findingText(g, f)}`)} title="Fix with AI" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                              <Wand2 className="h-3 w-3" />
                            </button>
                          )}
                          {g === "dependency_vulnerabilities" && f.recommended_version && (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title="Recommended version">
                              → {f.recommended_version}
                            </span>
                          )}
                          {g === "dependency_vulnerabilities" && onFixWithAI && (
                            f.fix_available ? (
                              <button onClick={() => onFixWithAI(dependencyFixPrompt(f))} title="Fix" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                                <Wrench className="h-3 w-3" />
                              </button>
                            ) : (
                              <button onClick={() => onFixWithAI(`Investigate and resolve this dependency security finding: ${findingText(g, f)}. No known safe upgrade path is available — review the advisory and determine the safest remediation.`)} title="Resolve with AI" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                                <Wand2 className="h-3 w-3" />
                              </button>
                            )
                          )}
                          {f.fingerprint && (
                            <button onClick={() => ignore(f.fingerprint)} disabled={busy === f.fingerprint} title="Ignore" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                              {busy === f.fingerprint ? <Loader2 className="h-3 w-3 animate-spin" /> : <EyeOff className="h-3 w-3" />}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {ignored.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/20">
              <div className="px-2.5 py-1.5 border-b border-border/40 text-[11.5px] font-semibold flex items-center gap-2">
                <EyeOff className="h-3 w-3 text-muted-foreground" />Ignored findings
                <span className="text-[10.5px] text-muted-foreground">{ignored.length}</span>
              </div>
              <ul className="divide-y divide-border/40">
                {ignored.map((fp) => (
                  <li key={fp} className="px-2.5 py-1.5 flex items-center gap-2 text-[11.5px]">
                    <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{fp}</code>
                    <button onClick={() => restore(fp)} disabled={busy === fp} title="Restore" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                      {busy === fp ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
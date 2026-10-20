import React, { useCallback, useEffect, useState } from "react";
import { Package, Loader2, RefreshCw, ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Read-only dependency viewer — the certified `dependencies` listDependencies surface.
// No mutation: add/remove/update are not exposed. Vulnerability status is reported as the backend
// reports it (none_known / vulnerable / unknown); "unknown" never reads as "safe".
const RELATION_TONE = { direct: "text-brand", transitive: "text-muted-foreground" };
const VULN_TONE = {
  none_known: "text-emerald-600", vulnerable: "text-destructive", unknown: "text-muted-foreground",
};
const STATUS_TONE = {
  installed: "text-muted-foreground", outdated: "text-amber-600", conflicted: "text-destructive",
  unresolved: "text-amber-600", removed: "text-muted-foreground/50", vulnerable: "text-destructive", incompatible: "text-amber-600",
};

export default function DependenciesSection({ projectId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("dependencies", { action: "listDependencies", project_id: projectId });
      setData(res.data);
    } catch (e) {
      setData({ error: e.response?.data?.error || e.message });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const deps = data?.dependencies || [];
  const validation = data?.validation || {};

  return (
    <section className="rounded-md border border-border p-4 md:col-span-2">
      <div className="flex items-center gap-2 mb-3">
        <Package className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Dependencies</h3>
        <span className="text-[11px] text-muted-foreground/60">{deps.length} packages</span>
        <button onClick={load} className="ml-auto text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>

      {loading ? (
        <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : data?.error ? (
        <p className="flex items-center gap-1.5 text-[12px] text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{data.error}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted-foreground">
            <span>manifest: <span className={data.manifest_present ? "text-emerald-600" : "text-destructive"}>{data.manifest_present ? "present" : "missing"}</span></span>
            <span>lockfile: <span className={data.lockfile_present ? "text-emerald-600" : "text-amber-600"}>{data.lockfile_present ? "present" : "missing"}</span></span>
            {data.dependency_fingerprint && <span className="font-mono truncate">fingerprint {data.dependency_fingerprint.slice(0, 12)}…</span>}
            <span>validation: <span className={validation.status === "ok" ? "text-emerald-600" : "text-amber-600"}>{validation.status || "—"}</span></span>
          </div>

          {(validation.vulnerabilities || []).length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
              <p className="flex items-center gap-1.5 text-[12px] text-destructive"><ShieldAlert className="h-3.5 w-3.5" />{validation.vulnerabilities.length} known advisories</p>
              <ul className="mt-1.5 space-y-0.5">
                {validation.vulnerabilities.map((v, i) => (
                  <li key={i} className="text-[11.5px] text-muted-foreground">{v.package_name}@{v.resolved_version} · {v.advisory_id} ({v.severity})</li>
                ))}
              </ul>
            </div>
          )}
          {(validation.unknown_advisory_packages || []).length > 0 && (
            <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><AlertTriangle className="h-3 w-3" />No advisory data for: {validation.unknown_advisory_packages.join(", ")} — safety is unknown, not guaranteed.</p>
          )}

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Package</th>
                  <th className="px-2.5 py-1.5 font-medium">Resolved</th>
                  <th className="px-2.5 py-1.5 font-medium">Relation</th>
                  <th className="px-2.5 py-1.5 font-medium">Status</th>
                  <th className="px-2.5 py-1.5 font-medium">Advisories</th>
                </tr>
              </thead>
              <tbody>
                {deps.length === 0 ? (
                  <tr><td colSpan={5} className="px-2.5 py-4 text-center text-muted-foreground/60">No dependencies declared.</td></tr>
                ) : deps.map((d) => (
                  <tr key={d.dependency_id || d.package_name} className="border-t border-border/40">
                    <td className="px-2.5 py-1.5 font-mono">{d.package_name}</td>
                    <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{d.resolved_version}</td>
                    <td className={`px-2.5 py-1.5 ${RELATION_TONE[d.relation] || "text-muted-foreground"}`}>{d.relation}</td>
                    <td className={`px-2.5 py-1.5 ${STATUS_TONE[d.status] || "text-muted-foreground"}`}>{d.status}</td>
                    <td className={`px-2.5 py-1.5 ${VULN_TONE[d.vulnerability_status] || "text-muted-foreground"}`}>
                      {d.vulnerability_status === "none_known" ? (
                        <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" />none known</span>
                      ) : d.vulnerability_status === "vulnerable" ? (
                        <span className="flex items-center gap-1"><ShieldAlert className="h-3 w-3" />{d.vulnerabilities.length}</span>
                      ) : (
                        <span>unknown</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
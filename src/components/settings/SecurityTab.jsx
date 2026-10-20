import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Shield, ShieldCheck, ShieldAlert, KeyRound, ScrollText, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import PatSection from "@/components/settings/PatSection";
import { Link } from "react-router-dom";

export default function SecurityTab({ workspace, user }) {
  const [org, setOrg] = useState(null);
  const [ssoConnections, setSsoConnections] = useState([]);
  const [domains, setDomains] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const [orgs, logs] = await Promise.all([
        base44.entities.Organization.filter({ workspace_id: workspace.id }),
        base44.entities.AuditLog.filter({ workspace_id: workspace.id }, { sort: "-created_date", limit: 10 }).then((p) => p.items || []),
      ]);
      setOrg(orgs[0] || null);
      setAuditLogs(logs);
      if (orgs[0]) {
        const [conns, doms] = await Promise.all([
          base44.entities.SsoConnection.filter({ organization_id: orgs[0].id }),
          base44.entities.VerifiedDomain.filter({ organization_id: orgs[0].id }),
        ]);
        setSsoConnections(conns);
        setDomains(doms);
      }
    } catch (e) {
      // Organization may not exist yet for non-enterprise workspaces
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [workspace]);

  if (loading) return <div className="flex justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  const hasSSO = ssoConnections.length > 0;
  const verifiedDomains = domains.filter((d) => d.status === "verified");

  return (
    <div className="space-y-8">
      {/* SSO Status */}
      <section className="rounded-lg border border-border p-5">
        <div className="flex items-start gap-3">
          <span className={`h-10 w-10 rounded-lg grid place-items-center shrink-0 ${hasSSO ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
            {hasSSO ? <ShieldCheck className="h-5 w-5" /> : <Shield className="h-5 w-5" />}
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">Single Sign-On (SSO)</h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {hasSSO
                ? `${ssoConnections.length} SSO connection${ssoConnections.length > 1 ? "s" : ""} configured. SSO-enforced login is ${org?.sso_enforced ? "active" : "optional"}.`
                : "No SSO connections configured. SSO is available on Enterprise plans."}
            </p>
            {hasSSO && (
              <div className="mt-3 space-y-2">
                {ssoConnections.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[13px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <KeyRound className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="text-[11px] text-muted-foreground uppercase">{c.protocol}</span>
                    </div>
                    <span className={`text-[11px] font-medium rounded px-2 py-0.5 ${c.status === "active" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                      {c.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {verifiedDomains.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Verified domains</div>
                <div className="flex flex-wrap gap-2">
                  {verifiedDomains.map((d) => (
                    <span key={d.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[12px] font-mono">
                      <Lock className="h-3 w-3 text-emerald-600" />{d.domain}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* SCIM Status */}
      <section className="rounded-lg border border-border p-5">
        <div className="flex items-start gap-3">
          <span className={`h-10 w-10 rounded-lg grid place-items-center shrink-0 ${org?.scim_enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
            <Shield className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold">SCIM Provisioning</h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {org?.scim_enabled
                ? "SCIM is enabled. User provisioning and deprovisioning are automated through your IdP."
                : "SCIM is not enabled. Automated user provisioning is available on Enterprise plans."}
            </p>
          </div>
        </div>
      </section>

      {/* Personal access tokens */}
      <PatSection workspace={workspace} user={user} />

      {/* API access pointer */}
      <div className="rounded-lg border border-border p-4 flex items-center gap-3">
        <span className="h-9 w-9 rounded-lg grid place-items-center shrink-0 bg-muted text-muted-foreground"><KeyRound className="h-4 w-4" /></span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">API access</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Read your app data over REST with a personal access token.</p>
        </div>
        <Button asChild variant="outline" size="sm"><Link to="/api-access">Open API access</Link></Button>
      </div>

      {/* Recent Audit Log */}
      <section>
        <div className="flex items-center gap-1.5 mb-3">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Recent activity</h3>
        </div>
        {auditLogs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-[13px] text-muted-foreground">No audit events recorded yet.</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border text-left text-[13px]">
              <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <tr><th className="px-4 py-2.5">Action</th><th className="px-4 py-2.5">Resource</th><th className="px-4 py-2.5">When</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-2.5 font-mono text-xs">{log.action}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{log.resource || "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{log.created_date ? new Date(log.created_date).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
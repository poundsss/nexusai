import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Lock, ShieldCheck, Globe, RefreshCw, Power, AlertTriangle, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useEnterpriseOrg, useSsoConnections, useSsoDomains } from "@/hooks/useEnterprise";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import { base44 } from "@/api/base44Client";

function SecurityRow({ icon: Icon, title, status, ok, detail, to }) {
  const content = (
    <div className={`flex items-start gap-3 rounded-lg border p-4 transition-colors ${to ? "border-border hover:border-primary/30 cursor-pointer" : "border-border"}`}>
      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${ok ? "text-emerald-600" : "text-muted-foreground"}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[13px]">{title}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ok ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
            {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}{status}
          </span>
        </div>
        {detail && <p className="mt-1 text-[12px] text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
  return to ? <Link to={to}>{content}</Link> : content;
}

export default function EnterpriseSecurity() {
  const { workspace, capabilities } = useWorkspace();
  const org = useEnterpriseOrg(workspace?.id);
  const conns = useSsoConnections(workspace?.id);
  const domains = useSsoDomains(workspace?.id);
  const [auditLogs, setAuditLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);

  useEffect(() => {
    if (!workspace) return;
    base44.entities.AuditLog.filter({ workspace_id: workspace.id }, { sort: "-created_date", limit: 10 }).then((p) => p.items || [])
      .then((rows) => setAuditLogs(rows.filter((r) => (r.action || "").startsWith("sso.") || (r.action || "").startsWith("scim.") || (r.action || "").startsWith("member."))))
      .catch(() => {})
      .finally(() => setLogsLoading(false));
  }, [workspace]);

  if (org.loading) return <AccountPage loading title="Enterprise Security" subtitle="SSO enforcement, domain status, and access controls."><div /></AccountPage>;

  if (!org.org) return (
    <AccountPage title="Enterprise Security" subtitle="SSO enforcement, domain status, and access controls.">
      <EmptyState icon={Lock} title="No organization" description="Create an organization to configure enterprise security." action={<Link to="/enterprise" className="text-primary hover:underline text-[13px]">Go to organization</Link>} />
    </AccountPage>
  );

  if (org.error) return (
    <AccountPage title="Enterprise Security" subtitle="SSO enforcement, domain status, and access controls.">
      <ErrorState message={org.error} onRetry={org.reload} />
    </AccountPage>
  );

  const activeConnections = conns.connections.filter((c) => c.status === "active");
  const verifiedDomains = domains.domains.filter((d) => d.status === "verified");
  const canManage = (capabilities || []).includes("sso.manage");

  return (
    <AccountPage
      title="Enterprise Security"
      subtitle="SSO enforcement, domain status, and access controls. The server enforces all of these — this view reflects the current configuration."
    >
      {/* Security status grid */}
      <div className="grid gap-3 sm:grid-cols-2">
        <SecurityRow
          icon={Power}
          title="SSO Enforcement"
          status={org.org.sso_enforced ? "Enforced" : "Not enforced"}
          ok={org.org.sso_enforced}
          detail={org.org.sso_enforced ? "Users on verified domains must sign in through SSO." : "Users can sign in with a password."}
          to="/enterprise/sso"
        />
        <SecurityRow
          icon={ShieldCheck}
          title="SSO Connections"
          status={`${activeConnections.length} active`}
          ok={activeConnections.length > 0}
          detail={activeConnections.length === 0 ? "No active SSO connections configured." : `${activeConnections.length} SAML/OIDC connection${activeConnections.length > 1 ? "s" : ""} active.`}
          to="/enterprise/sso"
        />
        <SecurityRow
          icon={Globe}
          title="Verified Domains"
          status={`${verifiedDomains.length} verified`}
          ok={verifiedDomains.length > 0}
          detail={verifiedDomains.length === 0 ? "No verified domains — SSO routing is inactive." : `${verifiedDomains.length} domain${verifiedDomains.length > 1 ? "s" : ""} route to this organization.`}
          to="/enterprise/domains"
        />
        <SecurityRow
          icon={RefreshCw}
          title="SCIM Provisioning"
          status={org.org.scim_enabled ? "Enabled" : "Disabled"}
          ok={org.org.scim_enabled}
          detail={org.org.scim_enabled ? "Identity provider can push user lifecycle changes." : "Provisioning is paused."}
          to="/enterprise/scim"
        />
      </div>

      {/* Enforcement warning */}
      {org.org.sso_enforced && verifiedDomains.length === 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-600">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>SSO enforcement is enabled but no domains are verified. Enforcement has no effect until a domain is verified.</span>
        </div>
      )}

      {/* Recent activity */}
      <div className="mt-6">
        <h3 className="text-[14px] font-semibold mb-3">Recent Enterprise Activity</h3>
        {logsLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : auditLogs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] text-muted-foreground">No enterprise activity yet.</div>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border/40">
            {auditLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-3 px-3 py-2.5 text-[12px]">
                <span className="font-mono text-muted-foreground shrink-0">{new Date(log.created_date).toLocaleString()}</span>
                <span className="font-medium text-foreground">{log.action}</span>
                {log.resource && <span className="text-muted-foreground">{log.resource}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </AccountPage>
  );
}
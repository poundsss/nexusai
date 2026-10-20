import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Settings as SettingsIcon, Globe, ShieldCheck, KeyRound, Rocket, Database, Users, ExternalLink, Loader2, Lock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { formatDistanceToNow } from "date-fns";
import DomainsPane from "@/components/builder/DomainsPane";
import EmailDomainPane from "@/components/builder/EmailDomainPane";
import AuthSettingsSection from "@/components/builder/AuthSettingsSection";
import DangerZone from "@/components/builder/DangerZone";
import SecurityScanSection from "@/components/builder/SecurityScanSection";
import DependenciesSection from "@/components/builder/DependenciesSection";
import ProjectLogoSection from "@/components/builder/ProjectLogoSection";
import ProjectBadgeSection from "@/components/builder/ProjectBadgeSection";

// Builder Settings pane — project identity, public addresses, environments, security
// (application roles — permission strings evaluated server-side only) and domains. Role reads
// degrade safely when the account's access policy refuses them; nothing here mutates security.
export default function SettingsPane({ project, files, entities, versions, live, domains, onCenterView, onFixWithAI, onReload }) {
  const [roles, setRoles] = useState(undefined); // undefined = loading, null = restricted
  const [teams, setTeams] = useState(undefined);

  useEffect(() => {
    setRoles(undefined); setTeams(undefined);
    base44.entities.AppRole.filter({ project_id: project?.id }, "key", 50).then(setRoles).catch(() => setRoles(null));
    base44.entities.AppTeam.filter({ project_id: project?.id }, "created_date", 50).then(setTeams).catch(() => setTeams(null));
  }, [project?.id]);

  const row = (label, value, mono) => (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-28 shrink-0 text-[11.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-[12.5px] ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );

  return (
    <div className="h-full overflow-auto p-5 scrollbar-thin max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <SettingsIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold tracking-tight">Settings</h2>
      </div>
      <p className="text-muted-foreground mb-4">Project identity, environments, domains and security. Workspace-level members and roles live in the account's <Link to="/members" className="underline underline-offset-2 hover:text-foreground">Members</Link> page.</p>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Identity */}
        <section className="rounded-md border border-border p-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Project</h3>
          {row("Name", project?.name)}
          {row("Slug", project?.slug || "—", true)}
          {row("Versions", `v${project?.version_count || 0}`)}
          {row("Created", project?.created_date ? formatDistanceToNow(new Date(project.created_date), { addSuffix: true }) : "—")}
        </section>

        {/* Addresses */}
        <section className="rounded-md border border-border p-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" />Addresses</h3>
          {live?.production ? (
            <a href={`/app/${project.slug}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-[12px] text-blue-600 hover:underline">
              <Globe className="h-3.5 w-3.5" />/app/{project.slug}<ExternalLink className="h-3 w-3" />
            </a>
          ) : <p className="text-[12px] text-muted-foreground/60">Production is not deployed yet.</p>}
          {live?.staging ? (
            <a href={`/app/${project.slug}--staging`} target="_blank" rel="noreferrer" className="mt-1.5 flex items-center gap-1.5 font-mono text-[12px] text-blue-600 hover:underline">
              <Globe className="h-3.5 w-3.5" />/app/{project.slug}--staging<ExternalLink className="h-3 w-3" />
            </a>
          ) : <p className="mt-1.5 text-[12px] text-muted-foreground/60">Staging has no live deployment.</p>}
          <button onClick={() => onCenterView("deploy")} className="mt-3 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <Rocket className="h-3.5 w-3.5" />Environments and domains
          </button>
        </section>

        {/* Environment configuration: what each pipeline currently serves */}
        <section className="rounded-md border border-border p-4 md:col-span-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><Rocket className="h-3.5 w-3.5" />Environments</h3>
          {["production", "staging"].map((env) => {
            const dep = live?.[env];
            return (
              <div key={env} className="flex items-center gap-3 py-1.5 text-[12px]">
                <span className="w-24 shrink-0 capitalize text-muted-foreground">{env}</span>
                {dep ? (
                  <>
                    <span className="font-mono">v{dep.version_number}</span>
                    <a href={dep.deployment_url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-blue-600 hover:underline">
                      {dep.deployment_url}<ExternalLink className="ml-1 inline h-3 w-3" />
                    </a>
                  </>
                ) : (
                  <span className="text-muted-foreground/60">not deployed — deploying is always an explicit action</span>
                )}
              </div>
            );
          })}
        </section>

        {/* App logo — the documented "Dashboard → Overview → Edit logo" surface */}
        <ProjectLogoSection project={project} onReload={onReload} />

        {/* Platform badge — the documented project-level "Made with Base44" attribution toggle */}
        <ProjectBadgeSection project={project} />

        {/* Security: roles, teams, secrets */}
        <section className="rounded-md border border-border p-4 md:col-span-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />Security
          </h3>
          {roles === undefined ? (
            <div className="text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
          ) : roles === null ? (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground/70"><Lock className="h-3.5 w-3.5" />Role management is restricted for your account.</p>
          ) : roles.length === 0 ? (
            <p className="text-[12px] text-muted-foreground/60">No application roles defined yet — end users get the built-in defaults.</p>
          ) : (
            <div className="rounded-md border border-border divide-y divide-border">
              {roles.map((r) => (
                <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                  <span className="font-mono font-medium">{r.key}</span>
                  <span className="text-muted-foreground">{r.name}</span>
                  {(r.permissions || []).map((p) => (
                    <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{p}</span>
                  ))}
                  {r.system && <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">built-in</span>}
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground/60">Permissions are strings like <span className="font-mono">orders.*</span> and are evaluated server-side only.</p>
          {teams !== undefined && teams !== null && teams.length > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground"><Users className="h-3.5 w-3.5" />{teams.length} app team{teams.length === 1 ? "" : "s"}</p>
          )}
          <button onClick={() => onCenterView("secrets")} className="mt-3 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <KeyRound className="h-3.5 w-3.5" />Project secrets
          </button>
        </section>

        {/* Security scan — the certified securityScan surface (run/get/ignore/restore) */}
        <SecurityScanSection projectId={project?.id} onFixWithAI={onFixWithAI} onCenterView={onCenterView} />

        {/* Dependencies — read-only view over the certified dependencies surface */}
        <DependenciesSection projectId={project?.id} />

        {/* Authentication: the deployed app's end-user sign-in providers (NOT workspace SSO) */}
        <AuthSettingsSection project={project} />

        {/* Resources */}
        <section className="rounded-md border border-border p-4 md:col-span-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5" />Resources
          </h3>
          <div className="flex gap-5 text-[12px]">
            <span><span className="font-mono font-medium">{(files || []).length}</span> <span className="text-muted-foreground">files</span></span>
            <span><span className="font-mono font-medium">{(entities || []).length}</span> <span className="text-muted-foreground">entities</span></span>
            <span><span className="font-mono font-medium">{(versions || []).length}</span> <span className="text-muted-foreground">versions</span></span>
            <button onClick={() => onCenterView("data")} className="ml-auto text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors">Open data</button>
          </div>
        </section>
      </div>

      {/* Domains — the SAME domain surface the Deploy pane renders, DNS-verified server-side */}
      <div className="mt-4">
        <DomainsPane
          projectId={project?.id}
          onChanged={domains.reload}
          domains={domains.domains}
          loading={domains.loading}
          working={domains.working}
          onAdd={domains.add}
          onVerify={domains.verify}
          onSetPrimary={domains.setPrimary}
          onRemove={domains.remove}
        />
      </div>

      {/* Email domain — the certified emailDomain surface (serving domains above are unchanged) */}
      <div className="mt-4">
        <EmailDomainPane projectId={project?.id} />
      </div>

      {/* Danger Zone — Unpublish / Republish / Delete / Restore (App Settings danger zone) */}
      <div className="mt-4">
        <DangerZone project={project} />
      </div>
    </div>
  );
}
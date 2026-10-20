// Custom domain control plane: attach, verify, promote to primary and remove hostnames for
// a project's environments.
//
// Every action is explicitly authorized against the project by a real end user (agents
// cannot reach it). A hostname only becomes servable after a REAL DNS TXT lookup proves
// control of it, and a hostname already active on another project is refused — so a domain
// can never be stolen or silently re-pointed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { normalizeEnvironment } from "../../shared/environments.ts";
import { normalizeHostname, verificationHost, newVerificationToken, verifyDomain, dnsInstructions, MAX_DOMAINS_PER_PROJECT } from "../../shared/domains.ts";
import { createDomainWithinLimit } from "../../shared/planLimits.ts";
import { validateSlug } from "../../shared/marketplace.ts";

const view = (d) => ({
  id: d.id, hostname: d.hostname, environment: d.environment, status: d.status, is_primary: !!d.is_primary,
  verified_at: d.verified_at || null, last_checked_at: d.last_checked_at || null, last_error: d.last_error || null,
  dns: dnsInstructions(d),
});

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const action = String(body.action || "list");
    // Built-in URL change reuses project.write (the same access level as rename), not domain.manage.
    const capability = action === "list" ? "project.read" : action === "change_slug" ? "project.write" : "domain.manage";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, capability);
    const svc = base44.asServiceRole;

    const mine = async () => (await svc.entities.CustomDomain.filter({ project_id: project.id }, "-created_date", 50)).filter((d) => d.status !== "removed");
    // A domain id from another project must be indistinguishable from one that never existed.
    const load = async () => {
      const d = await svc.entities.CustomDomain.get(body.domain_id).catch(() => null);
      if (!d || d.project_id !== project.id || d.status === "removed") throw Object.assign(new Error("Domain not found"), { status: 404 });
      return d;
    };

    // Built-in URL change (Base44 Domains → Built-in URL → Edit URL). Reuses the existing
    // Project.slug, the existing project.write authorization (same access level as rename), the
    // existing validateSlug contract and the runtime's existing slug→project resolution. Only
    // the slug moves: production/staging deployment pointers, custom domains, versions,
    // visibility and lifecycle state are untouched. The old slug stops resolving immediately
    // because the runtime resolves by Project.slug (filter { slug }); the new slug resolves to
    // the SAME live deployment without redeploying.
    if (action === "change_slug") {
      const slug = String(body.slug || "").trim();
      if (!validateSlug(slug)) return Response.json({ error: "Enter a valid URL (lowercase letters, numbers and hyphens, 2–60 chars)", code: "INVALID_SLUG" }, { status: 400 });
      if (slug === project.slug) return Response.json({ changed: true, project_id: project.id, slug: project.slug, unchanged: true });
      // Platform-wide uniqueness: no other project may hold this slug.
      const conflicts = await svc.entities.Project.filter({ slug }, "-created_date", 10);
      if (conflicts.some((p) => p.id !== project.id)) return Response.json({ error: "That URL is already in use", code: "SLUG_TAKEN" }, { status: 409 });
      const saved = await svc.entities.Project.update(project.id, { slug });
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "project.slug_changed", resource: "Project", resource_id: project.id, metadata: { from: project.slug, to: slug } });
      return Response.json({ changed: true, project_id: project.id, slug: saved.slug || slug });
    }

    if (action === "list") return Response.json({ domains: (await mine()).map(view) });

    if (action === "add") {
      const hostname = normalizeHostname(body.hostname);
      const environment = normalizeEnvironment(body.environment || "production");
      const existing = await svc.entities.CustomDomain.filter({ hostname }, "-created_date", 5);
      const claimed = existing.find((d) => d.status !== "removed");
      if (claimed) {
        return claimed.project_id === project.id
          ? Response.json({ error: "That domain is already attached to this project", code: "ALREADY_ATTACHED", domain: view(claimed) }, { status: 409 })
          : Response.json({ error: "That domain is already in use", code: "HOSTNAME_TAKEN" }, { status: 409 });
      }
      if ((await mine()).length >= MAX_DOMAINS_PER_PROJECT) {
        return Response.json({ error: `A project can have at most ${MAX_DOMAINS_PER_PROJECT} domains`, code: "DOMAIN_LIMIT" }, { status: 400 });
      }
      // The plan's custom-domain limit is claimed against the authorized project's workspace,
      // concurrency-safe, on top of the per-project cap above.
      const domain = await createDomainWithinLimit(svc, workspace, {
        project_id: project.id, hostname, environment,
        status: "pending_verification", verification_method: "dns_txt",
        verification_host: verificationHost(hostname), verification_token: newVerificationToken(),
        is_primary: false, added_by: user.id,
      });
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "domain.added", resource: "CustomDomain", resource_id: domain.id, metadata: { hostname, environment } });
      return Response.json({ domain: view(domain) }, { status: 201 });
    }

    if (action === "verify") {
      const domain = await load();
      const result = await verifyDomain(svc, domain);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: `domain.verify.${result.ok ? "passed" : "failed"}`, resource: "CustomDomain", resource_id: domain.id, metadata: { hostname: domain.hostname, code: result.code } });
      return Response.json({ ok: result.ok, code: result.code, domain: view(result.domain) }, { status: result.ok ? 200 : 400 });
    }

    if (action === "set_primary") {
      const domain = await load();
      if (domain.status !== "active") return Response.json({ error: "Only a verified domain can be made primary", code: "NOT_VERIFIED" }, { status: 400 });
      // At most one primary per project + environment.
      for (const other of await mine()) {
        if (other.id !== domain.id && other.environment === domain.environment && other.is_primary) {
          await svc.entities.CustomDomain.update(other.id, { is_primary: false });
        }
      }
      const saved = await svc.entities.CustomDomain.update(domain.id, { is_primary: true });
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "domain.primary_set", resource: "CustomDomain", resource_id: domain.id, metadata: { hostname: domain.hostname, environment: domain.environment } });
      return Response.json({ domain: view(saved) });
    }

    if (action === "remove") {
      const domain = await load();
      // Tombstoned rather than deleted: the hostname stops resolving immediately and the
      // same name can be attached again (by anyone who can prove control of it).
      await svc.entities.CustomDomain.update(domain.id, { status: "removed", is_primary: false, verified_at: null });
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "domain.removed", resource: "CustomDomain", resource_id: domain.id, metadata: { hostname: domain.hostname } });
      return Response.json({ removed: true, domain_id: domain.id });
    }

    return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}
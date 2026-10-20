// GitHub connection + repository link control plane.
//
// Authorization is resolved SERVER-SIDE from the authenticated user for every action, so a
// caller can never reach another project's link: a project they do not own returns the same
// safe not-found/forbidden response as one that does not exist. No response from this
// function contains an OAuth token — the link record stores a connector REFERENCE only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { resolveGitHubToken, requireLinkOwner, GITHUB_CONNECTOR_ID } from "../../shared/githubAuth.ts";
import { requireGitHubEntitlement } from "../../shared/githubEntitlement.ts";
import { storeAutoPushToken, deleteAutoPushToken } from "../../shared/githubAutoPush.ts";
import { getViewer, listRepos, getRepo, listBranches, createWebhook, deleteWebhook, GitHubError } from "../../shared/github.ts";
import {
  generateWebhookSecret, storeWebhookSecret, storeWebhookToken, deleteWebhookToken,
  publicWebhook, WEBHOOK_SECRET_NAME,
} from "../../shared/githubWebhook.ts";

const publicLink = (l) =>
  l && {
    id: l.id, project_id: l.project_id, repo_full_name: l.repo_full_name, branch: l.branch,
    subdirectory: l.subdirectory || "", status: l.status, connected_login: l.connected_login || null,
    connected_at: l.connected_at || null, last_sync_at: l.last_sync_at || null,
    last_error: l.last_error || null, last_error_code: l.last_error_code || null,
    last_export_commit_sha: l.last_export_commit_sha || null, last_export_version_number: l.last_export_version_number || null,
    last_import_commit_sha: l.last_import_commit_sha || null, last_import_version_number: l.last_import_version_number || null,
  };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const action = String(body.action || "status");
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "github.manage");
    const svc = base44.asServiceRole;
    const existing = (await svc.entities.GitHubLink.filter({ project_id: project.id }, "-created_date", 1))[0] || null;
    // R-8: gated actions need the plan entitlement; status/unlink/disconnect/webhook status+delete stay open.
    if (["repos", "branches", "link"].includes(action) || (action === "webhook" && String(body.subaction || "status") === "register")) {
      await requireGitHubEntitlement(svc, workspace?.id || project.workspace_id);
    }

    if (action === "status") {
      // A stored authorization that GitHub no longer honours (revoked/expired) is reported as
      // its own state, so the UI asks for a reconnect instead of silently looking disconnected.
      let account = null;
      let token_invalid = false;
      try {
        const { accessToken } = await resolveGitHubToken(base44);
        account = await getViewer(accessToken);
      } catch (e) {
        account = null;
        token_invalid = e?.code === "GITHUB_AUTH_INVALID";
      }
      // The link is reported with WHOSE authorization it holds, so a user never sees another
      // user's GitHub connection as if it were their own.
      return Response.json({
        connected: !!account, account, token_invalid, link: publicLink(existing),
        link_is_yours: existing ? (!existing.connected_by || existing.connected_by === user.id) : null,
      });
    }

    // Repository/branch pickers need the live GitHub account, so they resolve the token per
    // request and never persist it.
    if (action === "repos") {
      const { accessToken } = await resolveGitHubToken(base44);
      return Response.json({ repos: await listRepos(accessToken) });
    }

    if (action === "branches") {
      const { accessToken } = await resolveGitHubToken(base44);
      const repo = await getRepo(accessToken, String(body.repo_full_name || ""));
      return Response.json({ repo, branches: await listBranches(accessToken, repo.full_name) });
    }

    if (action === "link") {
      const { accessToken, mode } = await resolveGitHubToken(base44);
      const account = await getViewer(accessToken);
      const repo = await getRepo(accessToken, String(body.repo_full_name || ""));
      if (!repo.can_push) {
        return Response.json({ error: `The connected GitHub account cannot push to ${repo.full_name}.`, code: "GITHUB_PERMISSION_DENIED" }, { status: 403 });
      }
      const branches = await listBranches(accessToken, repo.full_name);
      const branch = String(body.branch || repo.default_branch);
      if (!branches.some((b) => b.name === branch)) {
        return Response.json({ error: `Branch "${branch}" does not exist in ${repo.full_name}.`, code: "BRANCH_NOT_FOUND" }, { status: 404 });
      }
      const subdirectory = String(body.subdirectory || "").replace(/^\/+|\/+$/g, "");
      const data = {
        project_id: project.id, workspace_id: workspace.id, connector_id: GITHUB_CONNECTOR_ID,
        connected_login: account.login, connected_by: user.id, repo_full_name: repo.full_name,
        repo_default_branch: repo.default_branch, branch, subdirectory,
        status: "connected", connected_at: new Date().toISOString(), last_error: null, last_error_code: null,
      };
      const link = existing ? await svc.entities.GitHubLink.update(existing.id, data) : await svc.entities.GitHubLink.create(data);
      // PA-12: project-scoped encrypted credential for automatic pushes (never returned).
      await storeAutoPushToken(svc, workspace.id, project.id, accessToken);
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: existing ? "github.repository.relinked" : "github.connected",
        resource: "GitHubLink", resource_id: link.id,
        metadata: { repo: repo.full_name, branch, subdirectory, github_login: account.login, credential_mode: mode },
      });
      return Response.json({ link: publicLink(link) });
    }

    if (action === "unlink") {
      if (!existing) return Response.json({ error: "This project has no GitHub link" }, { status: 404 });
      requireLinkOwner(existing, user);
      await svc.entities.GitHubLink.update(existing.id, { status: "disconnected" });
      await deleteAutoPushToken(svc, workspace.id, project.id);
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "github.repository.unlinked", resource: "GitHubLink", resource_id: existing.id,
        metadata: { repo: existing.repo_full_name, branch: existing.branch },
      });
      return Response.json({ ok: true });
    }

    // Disconnecting the GitHub ACCOUNT: the OAuth grant itself is revoked by the caller's own
    // client (the token never reaches the frontend), and this action retires the project's link
    // so a disconnected account can no longer be presented as an operable repository link.
    if (action === "disconnect") {
      if (existing && existing.status !== "disconnected" && (!existing.connected_by || existing.connected_by === user.id)) {
        await svc.entities.GitHubLink.update(existing.id, { status: "disconnected", last_error: null, last_error_code: null });
        await deleteAutoPushToken(svc, workspace.id, project.id);
      }
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "github.disconnected", resource: "GitHubLink", resource_id: existing?.id || null,
        metadata: { repo: existing?.repo_full_name || null },
      });
      return Response.json({ ok: true });
    }

    // ---- webhook management ----
    // Register, inspect or remove a GitHub push webhook for this project's repository link.
    // The webhook secret is stored as an encrypted ProjectSecret; the webhook token (for
    // webhook-triggered imports) is stored as an encrypted WorkspaceSecret. Neither value is
    // ever returned to a client.
    if (action === "webhook") {
      if (!existing) return Response.json({ error: "This project has no GitHub link", code: "NOT_LINKED" }, { status: 428 });
      requireLinkOwner(existing, user);
      const sub = String(body.subaction || "status");
      const wh = (await svc.entities.GitHubWebhook.filter({ project_id: project.id, github_link_id: existing.id }, "-created_date", 5))[0] || null;

      if (sub === "status") {
        return Response.json({ webhook: publicWebhook(wh) });
      }

      if (sub === "register") {
        const { accessToken } = await resolveGitHubToken(base44);
        const account = await getViewer(accessToken);
        // Verify the repo + branch are still valid before registering.
        const repo = await getRepo(accessToken, existing.repo_full_name);
        if (!repo.can_push) return Response.json({ error: `The connected GitHub account cannot push to ${repo.full_name}.`, code: "GITHUB_PERMISSION_DENIED" }, { status: 403 });

        // Construct the public webhook URL from the request origin.
        const origin = new URL(req.url).origin;
        const webhookUrl = `${origin}/functions/githubWebhook?project_id=${project.id}`;

        // Generate and store the webhook secret.
        const secret = generateWebhookSecret();
        await storeWebhookSecret(svc, project.id, secret);

        // Store the webhook token for webhook-triggered imports.
        const tokenName = await storeWebhookToken(svc, workspace.id, project.id, accessToken);

        // Create the GitHub webhook.
        let hook;
        try {
          hook = await createWebhook(accessToken, repo.full_name, { url: webhookUrl, secret, events: ["push"] });
        } catch (e) {
          await audit(svc, {
            workspace_id: workspace.id, project_id: project.id, user_id: user.id,
            action: "github.webhook.rejected", resource: "GitHubWebhook", resource_id: null,
            metadata: { repo: repo.full_name, code: e.code, reason: e.message.slice(0, 200) },
          });
          return Response.json({ error: e.message, code: e.code || "GITHUB_API_ERROR" }, { status: e.status && e.status < 500 ? e.status : 502 });
        }

        // Deactivate any previous webhook on this link.
        if (wh) {
          if (wh.github_hook_id) await deleteWebhook(accessToken, repo.full_name, wh.github_hook_id).catch(() => {});
          await svc.entities.GitHubWebhook.update(wh.id, { active: false, updated_at: new Date().toISOString() }).catch(() => {});
        }

        const record = await svc.entities.GitHubWebhook.create({
          project_id: project.id, workspace_id: workspace.id, github_link_id: existing.id,
          repo_full_name: repo.full_name, branch: existing.branch,
          webhook_secret_name: WEBHOOK_SECRET_NAME, webhook_token_name: tokenName,
          github_hook_id: hook.id, webhook_url: webhookUrl, active: true,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });

        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "github.webhook.registered", resource: "GitHubWebhook", resource_id: record.id,
          metadata: { repo: repo.full_name, branch: existing.branch, hook_id: hook.id, github_login: account.login, url: webhookUrl },
        });
        return Response.json({ webhook: publicWebhook(record) });
      }

      if (sub === "delete") {
        if (!wh) return Response.json({ error: "No webhook registered for this project" }, { status: 404 });
        // Try to delete the GitHub webhook (best-effort — the token may be invalid).
        try {
          const { accessToken } = await resolveGitHubToken(base44);
          if (wh.github_hook_id) await deleteWebhook(accessToken, wh.repo_full_name, wh.github_hook_id);
        } catch { /* token may be invalid; the local record is still removed */ }

        await svc.entities.GitHubWebhook.update(wh.id, { active: false, last_error: null, updated_at: new Date().toISOString() });
        await deleteWebhookToken(svc, workspace.id, project.id).catch(() => {});
        await audit(svc, {
          workspace_id: workspace.id, project_id: project.id, user_id: user.id,
          action: "github.webhook.removed", resource: "GitHubWebhook", resource_id: wh.id,
          metadata: { repo: wh.repo_full_name, branch: wh.branch, hook_id: wh.github_hook_id },
        });
        return Response.json({ ok: true });
      }

      return Response.json({ error: `Unsupported webhook subaction ${sub}` }, { status: 400 });
    }

    return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
  } catch (error) {
    const status = error instanceof GitHubError ? (error.status && error.status < 500 ? error.status : 502) : error.status || 500;
    return Response.json({ error: error.message, code: error.code || null }, { status });
  }
}
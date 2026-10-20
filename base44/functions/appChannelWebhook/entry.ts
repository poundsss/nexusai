// P-9.10A — the PUBLIC Telegram webhook endpoint for a deployed application's agent channel.
//
// Session-less by design (Telegram is the caller). The ONLY thing that authenticates a
// delivery is the x-telegram-bot-api-secret-token header, verified inside
// shared/appAgentChannels against the project's own TELEGRAM_WEBHOOK_SECRET ProjectSecret —
// a request without it never reaches the agent executor and never charges the workspace.
//
// Addressing is the platform's PUBLIC form only: ?slug=<project slug>&agent=<agent name>.
// The agent must be part of the slug's LIVE production artifact (the same derivation the
// public runtime uses); the acting user is resolved from the AppIdentity channel binding,
// never from the Telegram payload.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadArtifactPayload, currentLiveDeployment } from "../../shared/deploy.ts";
import { handleTelegramUpdate, telegramHttp, handleLINEUpdate, lineHttp, handleSlackEvent, slackHttp } from "../../shared/appAgentChannels.ts";
import { decryptSecretValue } from "../../shared/secretCrypto.ts";
import { withSecurityHeaders } from "../../shared/securityHeaders.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

export default async function (req) {
  return withSecurityHeaders(await handleWebhook(req));
}

async function handleWebhook(req) {
  try {
    const client = createClientFromRequest(req);
    const svc = client.asServiceRole;
    const q = new URL(req.url).searchParams;
    const slug = String(q.get("slug") || "");
    const agentName = String(q.get("agent") || "");
    // P-9.11L: the entry now serves TWO channel transports of the SAME foundation. Absent →
    // "telegram", so every already-registered Telegram webhook URL is byte-identical.
    const channel = String(q.get("channel") || "telegram");
    if (!SLUG_RE.test(slug) || !AGENT_RE.test(agentName)) {
      return Response.json({ error: "This webhook address is not valid" }, { status: 404 });
    }
    const [project] = await svc.entities.Project.filter({ slug }, "slug", 1).catch(() => []);
    if (!project) return Response.json({ error: "Application not found" }, { status: 404 });

    // The LIVE production deployment only — a staging deployment can never serve the channel.
    let deployment = project.production_deployment_id
      ? await svc.entities.Deployment.get(project.production_deployment_id).catch(() => null)
      : null;
    if (!deployment || deployment.status !== "LIVE" || deployment.superseded_at || deployment.project_id !== project.id) {
      deployment = await currentLiveDeployment(svc, project, "production");
    }
    if (!deployment || deployment.project_id !== project.id) {
      return Response.json({ error: "Application not found" }, { status: 404 });
    }
    const artifact = await svc.entities.DeploymentArtifact.get(deployment.artifact_id).catch(() => null);
    if (!artifact || artifact.project_id !== project.id) {
      return Response.json({ error: "Application unavailable" }, { status: 503 });
    }

    const raw = await req.text();
    let update = null;
    try { update = JSON.parse(raw); } catch {
      return Response.json({ error: channel === "line" ? "Malformed LINE delivery" : "Malformed Telegram update" }, { status: 400 });
    }

    // P-9.11L: LINE delivery — X-Line-Signature (base64 HMAC-SHA256 of the channel secret over
    // the EXACT raw body) is verified inside shared/appAgentChannels; the raw bytes are handed
    // through untouched so the signature is computed over what LINE actually sent.
    if (channel === "line") {
      const result = await handleLINEUpdate(client, {
        project, payload: await loadArtifactPayload(artifact), update, agentName,
        signatureHeader: req.headers.get("x-line-signature"), rawBody: raw,
        resolveSecret: async (name) => {
          if (!name) return undefined;
          const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
          const row = rows[0];
          if (!row || !row.value) return undefined;
          try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
        },
        http: lineHttp,
      });
      return Response.json(result);
    }

    // P-9.12S: Slack Events API delivery — X-Slack-Signature (v0= + hex HMAC-SHA256 of the
    // signing secret over "v0:<timestamp>:<exact raw body>") and the documented
    // url_verification handshake are verified/answered inside shared/appAgentChannels; the raw
    // bytes are handed through untouched so the signature is computed over what Slack sent.
    if (channel === "slack") {
      const result = await handleSlackEvent(client, {
        project, payload: await loadArtifactPayload(artifact), update, agentName,
        signatureHeader: req.headers.get("x-slack-signature"), timestampHeader: req.headers.get("x-slack-request-timestamp"), rawBody: raw,
        resolveSecret: async (name) => {
          if (!name) return undefined;
          const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
          const row = rows[0];
          if (!row || !row.value) return undefined;
          try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
        },
        http: slackHttp,
      });
      return Response.json(result);
    }

    const result = await handleTelegramUpdate(client, {
      project, payload: await loadArtifactPayload(artifact), update, agentName,
      secretTokenHeader: req.headers.get("x-telegram-bot-api-secret-token"),
      resolveSecret: async (name) => {
        if (!name) return undefined;
        const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
        const row = rows[0];
        if (!row || !row.value) return undefined;
        try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
      },
      http: telegramHttp,
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}
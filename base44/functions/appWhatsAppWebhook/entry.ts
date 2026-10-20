// P-9.10C — the PUBLIC WhatsApp webhook endpoint for a deployed application's agent channel.
//
// Session-less by design (Meta's WhatsApp platform is the caller):
//   • GET  — the subscription verification handshake (hub.mode / hub.verify_token /
//            hub.challenge), verified inside shared/appAgentChannels against the project's
//            own WHATSAPP_VERIFY_TOKEN ProjectSecret. The challenge is echoed only on a match.
//   • POST — authenticated ONLY by X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 of the
//            project's WHATSAPP_APP_SECRET over the EXACT raw body, compared in constant time
//            inside shared/appAgentChannels. A request without a valid signature never reaches
//            the agent executor and never charges the workspace.
//
// Addressing is the platform's PUBLIC form only: ?slug=<project slug>&agent=<agent name> —
// the same derivation the Telegram endpoint (appChannelWebhook) uses: the agent must be part
// of the slug's LIVE production artifact, and the acting user is resolved from the AppIdentity
// channel binding, never from the WhatsApp payload.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadArtifactPayload, currentLiveDeployment } from "../../shared/deploy.ts";
import { handleWhatsAppUpdate, handleWhatsAppVerification, whatsappHttp } from "../../shared/appAgentChannels.ts";
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
    const url = new URL(req.url);
    const slug = String(url.searchParams.get("slug") || "");
    const agentName = String(url.searchParams.get("agent") || "");
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

    const base = {
      project, payload: await loadArtifactPayload(artifact), agentName,
      resolveSecret: async (name) => {
        if (!name) return undefined;
        const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
        const row = rows[0];
        if (!row || !row.value) return undefined;
        try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
      },
    };

    // The subscription verification handshake: the answer is the provider's own challenge
    // string — plain text, nothing else, and only when the verify token matched.
    if (req.method === "GET") {
      const verified = await handleWhatsAppVerification(client, { ...base, query: url.searchParams });
      return new Response(verified.challenge, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });

    // The signature is verified over the EXACT bytes received, so the raw body is read once
    // and handed to the handler alongside the parsed update.
    const rawBody = await req.text();
    let update = null;
    try { update = JSON.parse(rawBody); } catch {
      return Response.json({ error: "Malformed WhatsApp update" }, { status: 400 });
    }

    const result = await handleWhatsAppUpdate(client, {
      ...base, update, rawBody,
      signatureHeader: req.headers.get("x-hub-signature-256"),
      http: whatsappHttp,
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}
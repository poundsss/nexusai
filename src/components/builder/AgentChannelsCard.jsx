import React, { useEffect, useState } from "react";
import { Loader2, Copy, KeyRound, ExternalLink } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Channel connection UI for the EXISTING certified channel foundations (appAgentChannels.ts).
// This card reuses — and does NOT invent — the backend's own contract:
//   • webhook URL  — the platform's public appChannelWebhook function endpoint, addressed by the
//                    project's slug + agent name + channel (the EXACT query the receiver reads).
//   • secrets      — the ProjectSecret NAMES the backend already requires (fail-closed without
//                    them); configured status is DERIVED from the existing projectSecrets list.
//   • lifecycle    — "Configure secrets" opens the existing Secrets pane (Connect = set the
//                    required secrets; Disconnect = remove them). No new connect/disconnect
//                    primitive is invented: the certified backend gates the channel on the
//                    presence of these secrets, so secret state IS the channel lifecycle.
const CHANNELS = [
  {
    key: "telegram",
    label: "Telegram",
    secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
    verifyHint:
      "Set TELEGRAM_WEBHOOK_SECRET, then pass it as the X-Telegram-Bot-Api-Secret-Token header when registering this webhook via Telegram's setWebhook.",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    secrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"],
    verifyHint:
      "Set WHATSAPP_VERIFY_TOKEN to a value you choose, then enter that same value as the Verify token in your WhatsApp Business app's webhook subscription.",
  },
  {
    key: "line",
    label: "LINE",
    secrets: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
    verifyHint:
      "Set LINE_CHANNEL_SECRET; LINE signs each delivery with X-Line-Signature = base64(HMAC-SHA256 of this secret over the exact raw body).",
  },
  {
    key: "slack",
    label: "Slack",
    secrets: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    verifyHint:
      "In your Slack app's Event Subscriptions, subscribe to app_mention and message.im and set the Request URL to the webhook below. Slack signs each delivery with X-Slack-Signature = v0= + hex(HMAC-SHA256(signing secret, \"v0:<timestamp>:<raw body>\")).",
  },
];

export default function AgentChannelsCard({ projectId, projectSlug, agentName, onOpenSecrets }) {
  const [setNames, setSetNames] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    base44.functions
      .invoke("projectSecrets", { project_id: projectId, action: "list" })
      .then((res) => { if (!cancelled) setSetNames(new Set((res.data?.secrets || []).filter((s) => s.is_set).map((s) => s.name))); })
      .catch(() => { if (!cancelled) setSetNames(new Set()); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const webhookUrl = (channel) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const base = `${origin}/api/functions/appChannelWebhook`;
    const q = `slug=${encodeURIComponent(projectSlug || "")}&agent=${encodeURIComponent(agentName || "")}&channel=${channel}`;
    return `${base}?${q}`;
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast({ title: "Copied", description: "Webhook URL copied to clipboard." }); }
    catch { toast({ variant: "destructive", title: "Could not copy", description: "Copy the URL manually." }); }
  };

  return (
    <div className="mt-3 rounded-md border border-border p-2.5">
      <div className="flex items-center gap-1.5">
        <KeyRound className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Channel connection</span>
      </div>
      <p className="mt-1 text-[10.5px] text-muted-foreground/70">
        Register the webhook URL with the provider and set the required secrets. A channel is live only when all its secrets are set.
      </p>

      {loading ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/60"><Loader2 className="h-3 w-3 animate-spin" />Loading channel secrets…</div>
      ) : (
        <div className="mt-2 space-y-2">
          {CHANNELS.map((ch) => {
            const configured = ch.secrets.every((n) => setNames?.has(n));
            const partial = !configured && ch.secrets.some((n) => setNames?.has(n));
            const ready = configured && !!projectSlug && !!agentName;
            return (
              <div key={ch.key} className="rounded-md border border-border/70 p-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium">{ch.label}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${configured ? "bg-emerald-500/10 text-emerald-600" : partial ? "bg-amber-500/10 text-amber-600" : "bg-muted text-muted-foreground"}`}>
                    {configured ? "configured" : partial ? "partial" : "not configured"}
                  </span>
                  <button
                    onClick={onOpenSecrets}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10.5px] font-medium hover:bg-muted transition-colors"
                  >
                    <KeyRound className="h-3 w-3" />{configured ? "Manage secrets" : "Configure secrets"}
                  </button>
                </div>

                <div className="mt-1.5 flex flex-wrap gap-1">
                  {ch.secrets.map((n) => (
                    <span key={n} className={`rounded font-mono text-[10px] px-1.5 py-0.5 ${setNames?.has(n) ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                      {n}
                    </span>
                  ))}
                </div>

                <div className="mt-1.5 flex items-center gap-1">
                  <code className="flex-1 min-w-0 truncate rounded bg-muted/60 px-1.5 py-1 text-[10px] text-muted-foreground">
                    {ready ? webhookUrl(ch.key) : (projectSlug && agentName ? webhookUrl(ch.key) : "Set the agent name and publish to get a slug, then the webhook URL appears here.")}
                  </code>
                  <button
                    onClick={() => copy(webhookUrl(ch.key))}
                    disabled={!projectSlug || !agentName}
                    className="shrink-0 rounded-md border border-border bg-background p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                    aria-label={`Copy ${ch.label} webhook URL`}
                    title="Copy webhook URL"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground/60">{ch.verifyHint}</p>
              </div>
            );
          })}
          <div className="rounded-md border border-border/70 p-2">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium">Browser extension</span>
              <a
                href="https://chromewebstore.google.com/detail/superagent-by-base44/cpebcpciinmbjhkdegmepiecekkkpggl"
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10.5px] font-medium hover:bg-muted transition-colors"
              >
                Install <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              Opens the Superagent by Base44 extension in the Chrome Web Store. The extension pairs with your Base44 account when you log in from it.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
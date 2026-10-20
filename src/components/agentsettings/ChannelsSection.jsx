import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { WhatsApp, Telegram, Slack, Chrome } from "./ChannelIcons";
import { Phone, MessageCircle, ExternalLink, Loader2, Check } from "lucide-react";
import ExtensionInstallDialog from "./ExtensionInstallDialog";

// 1:1 Base44 Channels: the connect list for the certified channel foundations. WhatsApp /
// Telegram / Slack use the real webhook + project-secrets lifecycle (Connect = set the required
// secrets; a channel whose secrets are all set shows Connected). The browser extension uses the
// NexusAI-native bridge (agentBrowserBridge); iMessage and Phone fail closed at the transport —
// their lifecycle functions answer with the EXACT documented blocker, shown in the toast.
const CHANNELS = [
  { key: "whatsapp", name: "WhatsApp", desc: "Chat with your agent on WhatsApp. Scan the QR code or send a quick activation code.", secrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"] },
  { key: "telegram", name: "Telegram", desc: "Chat with your agent on Telegram. We'll create a private bot for you in one click.", secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] },
  { key: "imessage", name: "iMessage", desc: "Chat with your agent from any Apple device. Verify by texting a short code from your iPhone or Mac.", unavailable: true, blockerFn: "agentImessageChannel" },
  { key: "slack", name: "Slack", desc: "Add your agent to a Slack workspace. Tag @agent in a channel and it replies in the thread.", secrets: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] },
  { key: "phone", name: "Phone", badge: "New", desc: "Give your agent its own phone number. Verify your number, then we provision a number you can call.", unavailable: true, blockerFn: "agentPhoneChannel" },
  { key: "extension", name: "Browser extension", desc: "Let your agent use your browser. Install the extension and it can browse sites and fill in forms for you.", bridge: true },
];

export default function ChannelsSection({ agent, project }) {
  const navigate = useNavigate();
  const [setNames, setSetNames] = useState(null);
  const [extensionOpen, setExtensionOpen] = useState(false);

  useEffect(() => {
    if (!project) return;
    let alive = true;
    base44.functions.invoke("projectSecrets", { project_id: project.id, action: "list" })
      .then((res) => { if (alive) setSetNames(new Set((res.data?.secrets || []).filter((s) => s.is_set).map((s) => s.name))); })
      .catch(() => { if (alive) setSetNames(new Set()); });
    return () => { alive = false; };
  }, [project]);

  const webhookUrl = (channel) => {
    const base = `${window.location.origin}/api/functions/appChannelWebhook`;
    return `${base}?slug=${encodeURIComponent(project?.slug || "")}&agent=${encodeURIComponent(agent.name || "")}&channel=${channel}`;
  };

  const openConnect = async (ch) => {
    if (ch.blockerFn) {
      // The exact, machine-checked blocker — from the channel's own lifecycle function.
      try {
        const res = await base44.functions.invoke(ch.blockerFn, { action: "status" });
        toast({ title: "Not available in this workspace", description: res.data?.blocker || "This channel has no transport in this workspace yet." });
      } catch {
        toast({ title: "Not available yet", description: "This channel has no connection backend in this workspace yet." });
      }
      return;
    }
    if (ch.bridge) {
      setExtensionOpen(true);
      return;
    }
    navigator.clipboard.writeText(webhookUrl(ch.key)).catch(() => {});
    toast({
      title: `${ch.name} webhook URL copied`,
      description: `Register it with ${ch.name}, then set the secrets: ${ch.secrets.join(", ")}.`,
    });
    navigate(`/builder/${project.id}`);
  };

  const icon = (key) => {
    if (key === "whatsapp") return <WhatsApp />;
    if (key === "telegram") return <Telegram />;
    if (key === "slack") return <Slack />;
    if (key === "extension") return <Chrome />;
    if (key === "phone") return <span className="grid h-6 w-6 place-items-center"><Phone className="h-5 w-5 text-foreground" /></span>;
    return <span className="grid h-6 w-6 place-items-center"><MessageCircle className="h-5 w-5 text-foreground" /></span>;
  };

  return (
    <div className="max-w-3xl">
      {CHANNELS.map((ch) => {
        const connected = !ch.unavailable && !ch.bridge && setNames && Array.isArray(ch.secrets) && ch.secrets.length > 0 && ch.secrets.every((s) => setNames.has(s));
        return (
          <div key={ch.key} className="flex items-center justify-between gap-6 py-4">
            <div className="flex min-w-0 gap-3.5">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center">{icon(ch.key)}</span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[12.5px] font-semibold">
                  {ch.name}
                  {ch.badge && <span className="rounded bg-brand px-1.5 py-0.5 text-[12.5px] font-semibold text-brand-foreground">{ch.badge}</span>}
                </p>
                <p className="mt-0.5 max-w-lg text-[12.5px] text-muted-foreground">{ch.desc}</p>
                {!ch.unavailable && !ch.bridge && setNames && Array.isArray(ch.secrets) && (
                  <p className="mt-1 font-mono text-[12.5px] text-muted-foreground/70">{ch.secrets.join(" · ")}</p>
                )}
              </div>
            </div>
            {connected ? (
              <Button variant="outline" className="h-9 shrink-0 gap-1.5 border-emerald-500/50 text-emerald-600 hover:text-emerald-600" onClick={() => openConnect(ch)}>
                <Check className="h-4 w-4" /> Connected
              </Button>
            ) : (
              <Button variant="outline" className="h-9 shrink-0 gap-1.5" onClick={() => openConnect(ch)}>
                {setNames == null && !ch.unavailable ? <Loader2 className="h-4 w-4 animate-spin" /> : ch.key === "extension" ? <ExternalLink className="h-4 w-4" /> : null}
                {ch.key === "extension" ? "Install" : "Connect"}
              </Button>
            )}
          </div>
        );
      })}
      {!project && <p className="text-[12.5px] text-muted-foreground">Loading project…</p>}
      <ExtensionInstallDialog project={project} agent={agent} open={extensionOpen} onOpenChange={setExtensionOpen} />
    </div>
  );
}
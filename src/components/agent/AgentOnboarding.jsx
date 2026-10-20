import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, ChevronRight, MessageCircle, MessageSquare, Send, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import GoogleIcon from "@/components/GoogleIcon";

// The Superagent-style agent onboarding: step 1 picks where to start talking (in-app / channels),
// step 2 offers the account connections (Google / Microsoft) that the agent works with. Channels
// use the certified connect-link contract (getWhatsAppConnectURL / getTelegramConnectURL);
// Google/Microsoft route to the Connections surface, which runs the delegated OAuth begin call.

// Microsoft four-square mark, inline (no external asset needed).
function MicrosoftIcon({ className = "h-5 w-5" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

const Card = ({ icon, label, note, onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="w-full flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5 text-left text-[14px] text-foreground shadow-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
  >
    <span className="grid h-7 w-7 shrink-0 place-items-center">{icon}</span>
    <span className="flex-1 font-medium">{label}</span>
    {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
  </button>
);

export default function AgentOnboarding({ agentName, onDone }) {
  const [step, setStep] = useState(1);
  const [channelError, setChannelError] = useState(null);
  const [opening, setOpening] = useState(null);
  const navigate = useNavigate();

  const openChannel = async (kind) => {
    setChannelError(null);
    setOpening(kind);
    try {
      const url = kind === "whatsapp"
        ? base44.agents.getWhatsAppConnectURL(agentName)
        : base44.agents.getTelegramConnectURL(agentName);
      if (url) window.open(url, "_blank", "noopener");
      else setChannelError("The connect link is not available yet.");
    } catch {
      setChannelError(kind === "telegram"
        ? "Telegram needs a bot connected first — set one up in the agent editor."
        : "The WhatsApp channel is not available right now.");
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex items-start sm:items-center justify-center overflow-y-auto no-scrollbar px-4 py-10">
      {step === 1 ? (
        <div className="w-full max-w-xl">
          {/* Headline with the selection-highlight treatment: the agent's name sits in a blue
              "selected" box with corner handles, exactly like the reference art. */}
          <div className="text-center">
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-foreground leading-tight">Meet your</h1>
            <div className="relative mt-2 inline-block">
              <span className="inline-flex items-center gap-2 rounded-lg bg-[#4353ff] px-4 py-1.5 text-4xl sm:text-5xl font-semibold tracking-tight text-white leading-tight">
                <Bot className="h-8 w-8 text-white/70" aria-hidden />
                {agentName}
              </span>
              {["-top-1.5 -left-1.5", "-top-1.5 -right-1.5", "-bottom-1.5 -left-1.5", "-bottom-1.5 -right-1.5"].map((pos) => (
                <span key={pos} className={`absolute ${pos} h-2 w-2 bg-foreground`} aria-hidden />
              ))}
            </div>
            <p className="mt-5 text-[15px] text-muted-foreground">Choose where to start talking with {agentName}</p>
          </div>

          <div className="mt-6 space-y-2.5">
            <Card icon={<Bot className="h-5 w-5 text-[#4353ff]" />} label="Continue here" onClick={() => setStep(2)} />
            <Card
              icon={opening === "whatsapp" ? <Loader2 className="h-5 w-5 animate-spin text-[#25D366]" /> : <MessageCircle className="h-5 w-5 text-[#25D366]" />}
              label="WhatsApp"
              onClick={() => openChannel("whatsapp")}
            />
            <Card
              icon={opening === "telegram" ? <Loader2 className="h-5 w-5 animate-spin text-[#229ED9]" /> : <Send className="h-5 w-5 text-[#229ED9]" />}
              label="Telegram"
              onClick={() => openChannel("telegram")}
            />
            <Card icon={<MessageSquare className="h-5 w-5 text-[#34c759]" />} label="iMessage" note="Coming soon" disabled />
          </div>
          {channelError && <p className="mt-3 text-center text-[12px] text-amber-300/90">{channelError}</p>}
        </div>
      ) : (
        <div className="w-full max-w-xl">
          {/* Step progress — two dots, the active step wider. */}
          <div className="flex items-center justify-center gap-1.5">
            <span className="h-1.5 w-7 rounded-full bg-foreground/30" />
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/15" />
          </div>
          <div className="mt-8 text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[#4353ff]">
              <Bot className="h-8 w-8 text-white" aria-hidden />
            </div>
            <h1 className="mt-5 text-3xl sm:text-4xl font-semibold tracking-tight text-foreground">Start with an agent that already knows you</h1>
          </div>

          <div className="mt-7 space-y-2.5">
            <Card icon={<GoogleIcon className="h-5 w-5" />} label="Connect to Google" onClick={() => navigate("/connections?provider=googlecalendar")} />
            <Card icon={<MicrosoftIcon className="h-5 w-5" />} label="Connect to Microsoft" onClick={() => navigate("/connections?provider=microsoft")} />
          </div>

          <div className="mt-6 text-center">
            <button type="button" onClick={onDone} className="text-[14px] text-muted-foreground hover:text-foreground transition-colors">
              Connect later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
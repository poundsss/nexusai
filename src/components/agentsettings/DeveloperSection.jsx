import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Copy, CopyCheck, SquareTerminal, ExternalLink, Plus } from "lucide-react";
import { toast } from "@/components/ui/use-toast";

// 1:1 Base44 Developer: the agent API entry point — base URL with copy, a curl quick example,
// and the access-token entry points (the existing PAT surface).
export default function DeveloperSection({ agent }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const agentId = agent.name || "agent";
  const baseUrl = `${window.location.origin}/api/agents/${agentId}`;
  const example = `curl ${baseUrl}/conversations/latest/messages \\
  -H "Authorization: Bearer YOUR_PERSONAL_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopied(true);
      toast({ title: "Copied", description: "Base URL copied to clipboard." });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ variant: "destructive", title: "Could not copy", description: "Copy the URL manually." });
    }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="text-[12.5px] font-semibold">API reference</h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">Connect this agent to your own code or product.</p>

      <p className="mt-3 text-[12.5px] font-medium">Base URL</p>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-border bg-muted/40 px-3">
          <span className="truncate font-mono text-[12.5px]">{baseUrl}</span>
        </div>
        <Button variant="outline" className="h-9 shrink-0 gap-2" onClick={copy}>
          {copied ? <CopyCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy
        </Button>
      </div>

      <p className="mt-4 text-[12.5px] font-medium">Quick example</p>
      <div className="mt-1 flex items-start justify-between gap-6">
        <p className="max-w-md text-[12.5px] text-muted-foreground">
          Replace &lt;YOUR_PERSONAL_ACCESS_TOKEN&gt; with a token that can reach this app — requests fail until you do.
        </p>
        <Button variant="outline" className="h-9 shrink-0 gap-1.5" onClick={() => navigate("/api-access")}>
          <Plus className="h-4 w-4" /> Create access token
        </Button>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed">{example}</pre>

      <button onClick={() => navigate("/api-access")} className="mt-4 text-[12.5px] text-blue-600 underline hover:text-blue-700">
        View all access tokens
      </button>

      <div className="mt-4">
        <button onClick={() => navigate("/api-access")} className="inline-flex items-center gap-2 text-[12.5px] font-medium hover:underline">
          View full API documentation <ExternalLink className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
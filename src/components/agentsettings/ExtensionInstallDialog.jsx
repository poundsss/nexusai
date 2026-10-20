import React from "react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Copy, Download, Loader2, KeyRound, Check } from "lucide-react";

// The NexusAI-native browser-extension install dialog: download the five extension files,
// copy the bridge URL, and issue a pairing token (the SAME single-use channel-activation
// contract the certified channels use). Pairing requires the signed-in app user; the session
// the extension gets is hashed, expiring and bound to (project, agent, app user).
const FILES = [
  { file: "manifest.json", hint: "Extension manifest (MV3)" },
  { file: "background.js", hint: "Service worker — bridge calls" },
  { file: "content.js", hint: "Content script — collects and fills forms" },
  { file: "popup.html", hint: "Toolbar popup" },
  { file: "popup.js", hint: "Popup logic" },
];

export default function ExtensionInstallDialog({ project, agent, open, onOpenChange }) {
  const [pairing, setPairing] = React.useState(null);
  const [pairError, setPairError] = React.useState(null);
  const [pairingBusy, setPairingBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(null);

  const bridgeUrl = `${window.location.origin}/api/functions/agentBrowserBridge`;
  const fileUrl = (file) => `/api/functions/agentBrowserExtensionFiles?file=${encodeURIComponent(file)}`;

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch { /* clipboard unavailable — the text stays selectable in the UI */ }
  };

  const issuePairing = async () => {
    setPairingBusy(true);
    setPairError(null);
    setPairing(null);
    try {
      const res = await base44.functions.invoke("agentBrowserBridge", {
        action: "pair", project_id: project?.id, agent_name: agent?.name || "",
      });
      setPairing(res.data || null);
    } catch (e) {
      setPairError(e?.response?.data?.error || e?.message || "Pairing failed");
    } finally {
      setPairingBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Install the browser extension</DialogTitle>
          <DialogDescription>
            The NexusAI-native agent browser bridge: download the files, load the unpacked
            extension in Chrome, then pair it with your activation token.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-[12.5px] font-semibold">1. Load the extension in Chrome</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Save the five files into one folder, open <span className="font-mono">chrome://extensions</span>, enable
              Developer mode and choose "Load unpacked".
            </p>
            <div className="mt-2 space-y-1.5">
              {FILES.map((f) => (
                <div key={f.file} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[12.5px]">{f.file}</p>
                    <p className="text-[12px] text-muted-foreground">{f.hint}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => copy(fileUrl(f.file), `u:${f.file}`)}>
                      {copied === `u:${f.file}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} URL
                    </Button>
                    <a href={fileUrl(f.file)} download={f.file}>
                      <Button variant="outline" size="sm" className="h-8 gap-1.5"><Download className="h-3.5 w-3.5" /> Save</Button>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[12.5px] font-semibold">2. Paste the bridge URL in the popup</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-[12px]">{bridgeUrl}</code>
              <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => copy(bridgeUrl, "bridge")}>
                {copied === "bridge" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
              </Button>
            </div>
          </div>

          <div>
            <p className="text-[12.5px] font-semibold">3. Pair with a single-use activation token</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              The token expires in 10 minutes, works once, and binds the bridge to {agent?.display_name || agent?.name || "this agent"} and your account.
            </p>
            <Button variant="outline" size="sm" className="mt-2 h-9 gap-1.5" disabled={pairingBusy} onClick={issuePairing}>
              {pairingBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Issue pairing token
            </Button>
            {pairing && (
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-[12px]">{pairing.token}</code>
                <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => copy(pairing.token, "token")}>
                  {copied === "token" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
                </Button>
              </div>
            )}
            {pairError && <p className="mt-2 text-[12.5px] text-destructive">{pairError}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="h-9" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
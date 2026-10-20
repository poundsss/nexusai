import React from "react";
import ReactMarkdown from "react-markdown";
import { ChevronDown, ChevronUp, MoreVertical } from "lucide-react";
import { Image } from "@/components/ui/image";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import FileViewerDialog from "@/components/agentfiles/FileViewerDialog";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { stripQuestions } from "@/lib/growQuestions";

const FAILED_RE = /error|failed/i;

// Artifact rendering over EXISTING tool-call results only: when a result already carries a
// public image URL (the media hosts the platform's integrations return), it is rendered as a
// usable card. No artifact types are invented, and there is no Download/Save — no contract
// provides one for these results.
const IMAGE_URL_RE = /^https:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;

function artifactImageUrls(results) {
  const found = [];
  const push = (v) => { if (typeof v === "string" && IMAGE_URL_RE.test(v) && !found.includes(v)) found.push(v); };
  const obj = typeof results === "string"
    ? (() => { try { return JSON.parse(results); } catch { return null; } })()
    : results;
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) Array.isArray(v) ? v.forEach(push) : push(v);
  }
  return found.slice(0, 3);
}

function ToolCall({ toolCall, dark, agentName, workspaceId }) {
  const [open, setOpen] = React.useState(false);
  const failed = toolCall.status === "failed" || toolCall.status === "error" ||
    FAILED_RE.test(String(toolCall.results ?? "")) ||
    (typeof toolCall.results === "object" && toolCall.results?.success === false);
  let parsed = null;
  try { parsed = JSON.parse(toolCall.arguments_string || "{}"); } catch { parsed = null; }
  const results = typeof toolCall.results === "string"
    ? (() => { try { return JSON.stringify(JSON.parse(toolCall.results), null, 2); } catch { return toolCall.results; } })()
    : JSON.stringify(toolCall.results, null, 2);
  return (
    <div className="mt-2 text-xs">
      <button type="button" onClick={() => setOpen(!open)} className={`flex items-center gap-1 ${dark ? "text-white/50 hover:text-white/80" : "text-muted-foreground hover:text-foreground"}`}>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <span>{toolCall.name}</span>
        <span className={failed ? "text-destructive" : "text-emerald-600"}>{failed ? "failed" : "done"}</span>
      </button>
      {open && (
        <div className={`mt-1 space-y-1 rounded-md p-2 ${dark ? "border border-white/10" : "border border-border"}`}>
          {artifactImageUrls(toolCall.results).map((u) => (
            <div key={u} className="max-w-sm">
              <Image src={u} fittingType="fill" className="aspect-video w-full rounded-md border border-border bg-muted" />
              {agentName && workspaceId && <ArtifactMenu url={u} agentName={agentName} workspaceId={workspaceId} />}
            </div>
          ))}
          {parsed != null && <pre className="whitespace-pre-wrap break-all">{JSON.stringify(parsed, null, 2)}</pre>}
          {results != null && <pre className="whitespace-pre-wrap break-all">{results}</pre>}
        </div>
      )}
    </div>
  );
}

// Artifact actions over an EXISTING tool-call image result (1:1 with the reference surface):
// Download opens the artifact; Save in files stores it through agentStoreFiles under the
// artifacts folder of the current agent's Files store; View file re-opens the SAVED copy.
function ArtifactMenu({ url, agentName, workspaceId }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(null);
  const [view, setView] = React.useState(null);
  const name = decodeURIComponent((url.split("/").pop() || "artifact").split("?")[0]) || "artifact";
  const save = async () => {
    setSaving(true);
    try {
      const res = await base44.functions.invoke("agentStoreFiles", {
        action: "saveArtifact", workspace_id: workspaceId, agent_name: agentName, url, name,
      });
      setSaved(res.data?.entry || null);
      toast({ title: "Saved to Files › artifacts" });
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e.response?.data?.error || e.message });
    } finally { setSaving(false); }
  };
  return (
    <div className="mt-1 flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Artifact actions" className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => window.open(url, "_blank", "noopener")}>Download to computer</DropdownMenuItem>
          <DropdownMenuItem onSelect={save} disabled={saving}>{saving ? "Saving…" : "Save in files"}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {saved && (
        <button
          type="button"
          onClick={() => setView(saved)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          View file
        </button>
      )}
      {view && <FileViewerDialog file={view} onClose={() => setView(null)} />}
    </div>
  );
}

export default function ChatMessages({ messages, dark, agentName = null, workspaceId = null }) {
  if (!messages?.length) {
    return <p className="text-sm text-muted-foreground">Ask the agent to generate leads, run listening, check AI visibility or plan content.</p>;
  }
  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {messages.map((m, i) => (
        <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[80%] min-w-0 overflow-hidden rounded-xl px-3 py-2 text-sm ${
            m.role === "user"
              ? (dark ? "bg-[#2563eb] text-white" : "bg-primary text-primary-foreground")
              : (dark ? "bg-white/[0.06] text-white/90" : "bg-muted")
          }`}>
            {m.role === "user"
              ? <p className="whitespace-pre-wrap">{m.content}</p>
              : <ReactMarkdown className="prose prose-sm max-w-none min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:scrollbar-thin [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto">{stripQuestions(m.content)}</ReactMarkdown>}
            {(m.tool_calls || []).map((tc, j) => <ToolCall key={j} toolCall={tc} dark={dark} agentName={agentName} workspaceId={workspaceId} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
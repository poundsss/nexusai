import React from "react";
import { Link } from "react-router-dom";
import { FolderOpen, FileCode2, ExternalLink, Loader2, Bot } from "lucide-react";
import useSelectedAgent from "@/hooks/useSelectedAgent";
import { useWorkspace } from "@/hooks/useWorkspace";
import StoreBrowser from "@/components/agentfiles/StoreBrowser";

// FILES — Agent → More → Files. The agent's file store: folders and files, an artifacts
// folder for chat-generated artifacts, Add New (upload file / upload folder / new folder),
// folder ZIP download and an in-place file viewer (agentStoreFiles + the platform's EXISTING
// private file storage; authorization is fail-closed at the endpoint). The agent's declared
// context files stay listed read-only below, edited in the owning app's code view as before.
export default function AgentFiles() {
  const { agentName, agent, error } = useSelectedAgent();
  const { workspace } = useWorkspace();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <FolderOpen className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-[22px] font-semibold tracking-tight">Files</h1>
      </div>
      <p className="text-[13px] text-muted-foreground mb-6">
        Folders and files of the <span className="font-medium text-foreground">{agentName}</span> agent, plus its context files.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive mb-4">{error}</div>
      )}
      {(!agent || !workspace) && !error && (
        <div className="rounded-md border border-border p-3 text-muted-foreground/60 mb-6"><Loader2 className="h-4 w-4 animate-spin" /></div>
      )}

      {agent && workspace && (
        <div className="mb-8">
          <StoreBrowser agentName={agentName} workspaceId={workspace.id} />
        </div>
      )}

      <h2 className="text-[14px] font-semibold tracking-tight mb-2">Context files</h2>
      {!agent && !error ? null : agent && (agent.context_files || []).length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-[12.5px] text-muted-foreground flex items-start gap-2.5">
          <Bot className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/60" />
          <span>
            No context files yet. Add <span className="font-mono">base44/context/&lt;file&gt;.md</span> and declare it in the agent's
            <span className="font-mono"> context_files</span> (Builder → Agents → Configuration).
          </span>
        </div>
      ) : agent && (agent.context_files || []).length > 0 ? (
        <div className="rounded-md border border-border divide-y divide-border">
          {agent.context_files.map((path) => (
            <div key={path} className="flex items-center gap-2.5 px-3 py-2.5">
              <FileCode2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{path}</span>
              {agent.project_id && (
                <Link
                  to={`/builder/${agent.project_id}`}
                  className="shrink-0 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {agent.project_name || "Open app"} <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
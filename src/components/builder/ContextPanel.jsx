import React, { useState } from "react";
import { Files, History, Database, Plug, KeyRound, Rocket, Github, ChevronRight, Workflow, Bot, Settings as SettingsIcon, Monitor, Code2, Megaphone } from "lucide-react";
import FileTree from "./FileTree";
import VersionsPane from "./VersionsPane";

const TABS = [
  { id: "files", label: "Files", icon: Files },
  { id: "versions", label: "Versions", icon: History },
  { id: "manage", label: "Manage", icon: Rocket },
];

const MANAGE = [
  { id: "code", label: "Build", icon: Code2, hint: "Source files and editor" },
  { id: "preview", label: "Preview", icon: Monitor, hint: "The running application" },
  { id: "data", label: "Data", icon: Database, hint: "Entities and records" },
  { id: "logic", label: "Logic", icon: Workflow, hint: "Workflows and triggers" },
  { id: "integrations", label: "Integrations", icon: Plug, hint: "Functions and integrations" },
  { id: "agents", label: "Agents", icon: Bot, hint: "Autonomous agent runs" },
  { id: "versions", label: "Versions", icon: History, hint: "History and restore" },
  { id: "deploy", label: "Deploy", icon: Rocket, hint: "Environments and domains" },
  { id: "settings", label: "Settings", icon: SettingsIcon, hint: "Project and security" },
  { id: "secrets", label: "Secrets", icon: KeyRound, hint: "Encrypted project keys" },
  { id: "github", label: "Source", icon: Github, hint: "GitHub export and import" },
  { id: "launchpad", label: "Launchpad", icon: Megaphone, hint: "Submit and manage launch" },
];

// Contextual right rail of the Builder workspace. Compact navigation; detailed
// surfaces open in the center canvas rather than being crammed into the rail.
export default function ContextPanel({ project, files, entities, selectedFile, onOpenFile, onSelectEntity, versions, restoring, onRestore, centerView, onCenterView }) {
  const [tab, setTab] = useState("files");

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="h-10 shrink-0 flex items-center gap-0.5 px-2 border-b border-border">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors ${tab === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {tab === "files" && (
          <FileTree files={files} entities={entities} selected={selectedFile} onSelect={onOpenFile} onSelectEntity={onSelectEntity} />
        )}
        {tab === "versions" && (
          <VersionsPane versions={versions} onRestore={onRestore} restoring={restoring} compact projectId={project?.id} />
        )}
        {tab === "manage" && (
          <div className="p-2 space-y-0.5">
            {MANAGE.map(({ id, label, icon: Icon, hint }) => {
              const active = centerView === id;
              return (
                <button
                  key={id}
                  onClick={() => onCenterView(active ? "preview" : id)}
                  className={`w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${active ? "bg-accent" : "hover:bg-muted/60"}`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? "text-foreground" : "text-muted-foreground"}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] font-medium truncate">{label}</span>
                    <span className="block text-[11px] text-muted-foreground truncate">{hint}</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
        <span className="font-mono">{files.length} files</span>
        <span className="text-border">·</span>
        <span className="font-mono">{entities.length} entities</span>
        <span className="ml-auto font-mono">v{project?.version_count || 0}</span>
      </div>
    </div>
  );
}
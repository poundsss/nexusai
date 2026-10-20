import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Database, Loader2, ExternalLink, Table2, ChevronRight } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import useSelectedAgent from "@/hooks/useSelectedAgent";
import RecordManager from "@/components/agentdata/RecordManager";

// DATA — the confirmed Superagent surface (Agent → More → Data): the agent's AUTHORIZED
// tables (from its certified tool_configs — never invented here), each opening a record
// manager (search, filters, columns, Add Item, inline edit, Export CSV, Schema, Recently
// Deleted with restore, Delete All → trash). Reads and mutations run ONLY through the
// certified server-authorized contracts (mcpQueryEntityRecords / mcpMutateEntityRecord /
// Entity Trash); cross-app access stays in Agent Settings → General, untouched.
const OPS = ["read", "create", "update", "delete"];

export default function AgentData() {
  const { workspace } = useWorkspace();
  const { agentName, agent, error } = useSelectedAgent();
  const [openEntity, setOpenEntity] = useState(null); // { name } from ?table=
  const [projectName, setProjectName] = useState(null);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const table = urlParams.get("table");
    if (table) setOpenEntity({ name: table });
  }, []);

  const openTable = (name) => {
    const url = new URL(window.location.href);
    url.searchParams.set("table", name);
    window.history.replaceState({}, "", url);
    setOpenEntity({ name });
  };

  const closeTable = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("table");
    window.history.replaceState({}, "", url);
    setOpenEntity(null);
  };

  // The owning app's name for the opened table's project (context line only).
  useEffect(() => {
    if (!openEntity || !agent?.project_id || projectName) return;
    workspaceRead("project", { project_id: agent.project_id })
      .then((d) => setProjectName(d.project?.name || null))
      .catch(() => setProjectName(null));
  }, [openEntity, agent, projectName]);

  const access = new Map((agent?.tool_configs || []).map((t) => [t.entity_name, t]));
  const openConfig = openEntity ? access.get(openEntity.name) : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-1 flex items-center gap-2.5">
        <Database className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-[22px] font-semibold tracking-tight">Data</h1>
      </div>
      <p className="mb-6 text-[13px] text-muted-foreground">
        {openEntity
          ? <>Records of <span className="font-mono font-medium text-foreground">{openEntity.name}</span> — one of the tables <span className="font-medium text-foreground">{agentName}</span> is authorized to access.</>
          : <>What <span className="font-medium text-foreground">{agentName}</span> can read and change. Access is set in the agent's configuration; cross-app access lives in Agent Settings → General.</>}
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>
      )}

      {/* Opened table — the record manager */}
      {openEntity && (openConfig || agent) && (
        <div className="mb-8">
          <RecordManager
            agentName={agentName}
            entityName={openEntity.name}
            projectId={agent?.project_id || null}
            allowedOps={openConfig?.allowed_operations || []}
            onBack={closeTable}
          />
        </div>
      )}

      {/* Agent access — the authorized table list (click a table to manage its records) */}
      {!openEntity && (
        <>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Agent access</h2>
          {!agent && !error && (
            <div className="mb-5 rounded-md border border-border p-3 text-muted-foreground/60"><Loader2 className="h-4 w-4 animate-spin" /></div>
          )}
          {agent && (agent.tool_configs || []).length === 0 && (
            <p className="mb-5 text-[12.5px] text-muted-foreground/60">No entities are accessible to this agent. Add <span className="font-mono">tool_configs</span> in the agent's configuration.</p>
          )}
          {agent && (agent.tool_configs || []).length > 0 && (
            <div className="mb-6 divide-y divide-border rounded-md border border-border">
              {agent.tool_configs.map((t) => (
                <button
                  key={t.entity_name}
                  type="button"
                  onClick={() => openTable(t.entity_name)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                >
                  <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{t.entity_name}</span>
                  <span className="flex shrink-0 gap-1">
                    {OPS.map((op) => (
                      <span key={op} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${(t.allowed_operations || []).includes(op) ? "bg-brand-muted text-brand" : "bg-muted text-muted-foreground/40"}`}>
                        {op}
                      </span>
                    ))}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                </button>
              ))}
            </div>
          )}

          {/* Workspace data overview (unchanged) */}
          <WorkspaceOverview workspace={workspace} access={access} />
        </>
      )}
    </div>
  );
}

function WorkspaceOverview({ workspace, access }) {
  const [rows, setRows] = useState(null); // [{ project, entities: [AppEntity] }]
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    (async () => {
      try {
        const projects = (await workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 })).projects || [];
        const groups = await Promise.all(projects.map(async (p) => ({
          project: p,
          entities: (await base44.entities.AppEntity.filter({ project_id: p.id }, { sort: "name", limit: 200 }).catch(() => ({ items: [] }))).items,
        })));
        if (alive) setRows(groups.filter((g) => g.entities.length > 0));
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => { alive = false; };
  }, [workspace]);

  return (
    <>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Workspace data</h2>
      {!rows && (
        <div className="rounded-md border border-border p-3 text-muted-foreground/60"><Loader2 className="h-4 w-4 animate-spin" /></div>
      )}
      {rows && rows.length === 0 && (
        <p className="py-2 text-[12.5px] text-muted-foreground/60">No entities declared yet.</p>
      )}
      {rows && rows.map(({ project, entities }) => (
        <div key={project.id} className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="truncate text-[13px] font-medium">{project.name}</span>
            <Link
              to={`/builder/${project.id}`}
              className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Data pane <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((e) => (
              <span key={e.id} className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {e.name}
                {access.has(e.name) && <span className="rounded bg-brand-muted px-1 py-0.5 font-sans text-[9.5px] text-brand">agent</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
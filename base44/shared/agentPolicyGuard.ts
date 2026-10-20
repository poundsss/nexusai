// Agent self-policy mutation protection — the Builder write boundary for DELEGATED runs.
//
// A delegated Builder run (one with parent_agent_run_id) executes for a running AgentRun, and that
// agent re-resolves its tool grants, instructions and model tier from base44/agents/<name>.jsonc at
// EVERY iteration. A write landing on the executing agent's own definition would therefore widen
// (or rewrite) its permissions mid-run. This module is the single guard the Builder's mutating
// file tools (write_file / patch_file / replace_range / delete_file) consult: when the run's tool
// ctx names the active agent, writes to that agent's OWN definition fail closed. Other agents'
// definitions, all other project files, and human-initiated Builder runs (no live parent AgentRun)
// are untouched, and the Agent execution flow itself is unchanged.
import { AGENTS_DIR } from "./base44Layout.ts";
import { normalizePath } from "./projectFs.ts";

export const AGENT_POLICY_IMMUTABLE = "AGENT_POLICY_IMMUTABLE";

// The executing agent's own definition: its .jsonc document, a legacy .json spelling, or any file
// nested under its directory. Prefix-adjacent agent names ('helper' vs 'helper-two') never match.
export function isAgentPolicyPath(agentName, path) {
  // The SAME normalization projectFs applies before any file write, so a path variant the fs
  // layer would resolve onto the agent's document (/base44/..., base44\agents\... , ./base44/...)
  // can never slip past this matcher.
  const p = normalizePath(path);
  const name = String(agentName || "");
  if (!name || !p.startsWith(`${AGENTS_DIR}${name}`)) return false;
  const rest = p.slice(AGENTS_DIR.length + name.length);
  return rest === "" || rest === ".jsonc" || rest === ".json" || rest.startsWith("/");
}

// Called by the mutating file tools BEFORE the write lands. Throws the same kind of structured
// refusal the delete-cap already uses; executeTool's callers surface it as a tool failure, so
// no partial write is ever committed and the run observes the refusal like any other error.
export function assertMutableProjectFile(ctx, path) {
  const agentName = ctx?.agent_policy_agent_name;
  // Delegated runs may write NEITHER the executing agent's own definition NOR any other agent's:
  // a write to another agent's document would stage policy a FUTURE agent run executes under.
  // Any path under base44/agents/ is refused, matched with the same normalization projectFs
  // applies before the write itself. Human-initiated runs carry no agent context and are unchanged.
  if (agentName && normalizePath(path).startsWith(AGENTS_DIR)) {
    throw Object.assign(
      new Error(`Refused: a delegated Builder run executing for agent '${agentName}' cannot modify agent definitions (${path}); edit base44/agents/<name>.jsonc outside an agent run.`),
      { code: AGENT_POLICY_IMMUTABLE },
    );
  }
  // Human-initiated Builder runs (Builder UI, edit_project over MCP) hold no single agent
  // context, so the narrower rule applies: the policy of an agent with a LIVE run is immutable.
  // Runs with no active AgentRun keep full edit freedom over agent files, exactly as before.
  const active = Array.isArray(ctx?.agent_policy_active_names) ? ctx.agent_policy_active_names : [];
  if (active.length && normalizePath(path).startsWith(AGENTS_DIR)) {
    const busy = active.find((n) => isAgentPolicyPath(n, path));
    if (busy) {
      throw Object.assign(
        new Error(`Refused: agent '${busy}' has an active run, so its policy (${path}) is immutable until that run finishes (AGENT_POLICY_IMMUTABLE).`),
        { code: AGENT_POLICY_IMMUTABLE },
      );
    }
  }
}

// AgentRun statuses that mean the run is still executing (schema statuses; STALE/terminal are
// excluded, so a run the reaper stopped never keeps its agent frozen).
export const AGENT_RUN_ACTIVE_STATUSES = ["QUEUED", "RUNNING", "PLANNING", "EXECUTING", "OBSERVING", "VERIFYING"];

// Every agent of this project with a live run. One query, deduplicated; a failed read
// yields no names (a query outage never blocks ordinary project edits).
export async function activeAgentNames(client, projectId) {
  if (!projectId) return [];
  const svc = client?.asServiceRole || client;
  const runs = await svc.entities.AgentRun.filter({ project_id: projectId, status: { $in: AGENT_RUN_ACTIVE_STATUSES } }, "-created_date", 100).catch(() => []);
  return [...new Set((runs || []).filter((r) => r.agent_name).map((r) => String(r.agent_name)))];
}

// The SAME immutability boundary for HUMAN channels (collaborator commits, MCP
// write_project_file, version restore): a policy file of an agent with a live run cannot be
// modified, deleted or restored over. Only agent-directory paths are checked, so ordinary
// project file editing is untouched, and only the MATCHING agent's files are frozen.
export async function assertNoActiveAgentPolicyWrite(client, projectId, paths) {
  const hits = [...new Set((paths || []).map((p) => normalizePath(p)))].filter((p) => p.startsWith(AGENTS_DIR));
  if (!hits.length) return;
  const names = await activeAgentNames(client, projectId);
  for (const p of hits) {
    const busy = names.find((n) => isAgentPolicyPath(n, p));
    if (busy) {
      throw Object.assign(
        new Error(`Refused: agent '${busy}' has an active run, so its policy (${p}) is immutable until that run finishes (AGENT_POLICY_IMMUTABLE).`),
        { code: AGENT_POLICY_IMMUTABLE, status: 409 },
      );
    }
  }
}

// A capability a delegated Builder run borrows from the Builder surface is allowed only when
// the delegating agent holds the same grant itself. Runs without a grants context (every
// human-initiated Builder run) are untouched, so normal Builder behaviour is unchanged.
export const AGENT_TOOL_NOT_GRANTED = "AGENT_TOOL_NOT_GRANTED";
export function assertDelegatedToolGrant(ctx, toolName) {
  const granted = ctx?.agent_policy_grants;
  if (Array.isArray(granted) && !granted.includes(toolName)) {
    throw Object.assign(
      new Error(`Refused: the delegating agent holds no '${toolName}' grant, so its delegated Builder run cannot use it either (granted: ${granted.join(", ") || "none"})`),
      { code: AGENT_TOOL_NOT_GRANTED },
    );
  }
}

// The agent whose policy a delegated Builder run must leave immutable: the parent AgentRun's
// declared agent. The guard holds for the delegated run's WHOLE lifetime — including after the
// parent completes, fails or is cancelled — because the run started under that policy, and a
// child still executing (or recovering) must not regain the ability to rewrite the originating
// agent's definition just because its parent reached a terminal state. No parent (or a parent
// with no declared agent) guards nothing, exactly as before for human-initiated runs.
export async function activePolicyAgentName(svc, run) {
  if (!run?.parent_agent_run_id) return null;
  const parent = await svc.entities.AgentRun.get(run.parent_agent_run_id).catch(() => null);
  if (!parent || !parent.agent_name) return null;
  return String(parent.agent_name);
}
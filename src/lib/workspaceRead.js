import { base44 } from "@/api/base44Client";

// The authorized read/write surface for Workspace / WorkspaceMember / Project / Deployment /
// AppRecord rows the browser may see. Every call is authorized server-side (role resolved
// from workspace ownership or an active membership); direct entity SDK access to these
// entities is locked. Returns the action's data object, e.g. { projects }, { records }.
export async function workspaceRead(action, params = {}) {
  const res = await base44.functions.invoke("workspaceRead", { action, ...params });
  return res.data || {};
}
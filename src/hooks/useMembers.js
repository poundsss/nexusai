import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Thin client over the workspaceMembers control plane. It never decides permissions:
// the server returns the caller's role and capabilities, and the UI only reflects them.
const call = async (payload) => {
  const res = await base44.functions.invoke("workspaceMembers", payload);
  return res.data;
};

export function useMembers(workspaceId) {
  const [state, setState] = useState({ members: [], role: null, capabilities: [], owner: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setState(await call({ action: "list", workspace_id: workspaceId }));
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const act = async (payload) => {
    const data = await call({ ...payload, workspace_id: workspaceId });
    await load();
    return data;
  };

  return {
    ...state, loading, error, reload: load,
    canManage: (state.capabilities || []).includes("member.manage"),
    invite: (email, role) => act({ action: "invite", email, role }),
    updateRole: (member_id, role) => act({ action: "update_role", member_id, role }),
    remove: (member_id) => act({ action: "remove", member_id }),
  };
}

export const acceptInvite = (invite_token) => call({ action: "accept", invite_token });
import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// All MCP control-plane traffic goes through the backend function, which resolves the
// account server-side from an EXPLICIT workspace context. Secret values only ever travel
// INTO it.
export function useMcpConnections(workspaceId) {
  const [connections, setConnections] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const call = useCallback(async (payload, busyKey = "") => {
    setBusy(busyKey); setError("");
    try {
      const { data } = await base44.functions.invoke("mcpConnections", { workspace_id: workspaceId, ...payload });
      if (data.connections) setConnections(data.connections);
      if (data.error) setError(`${data.error.code}: ${data.error.message}`);
      return data;
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      return { error: { message: e.message } };
    } finally { setBusy(""); }
  }, [workspaceId]);

  useEffect(() => { if (workspaceId) call({ action: "list" }, "list"); }, [call, workspaceId]);

  return { connections, busy, error, setError, call };
}
import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Thin client over the authorized Integration API (#31E). The pane never manages integrations
// directly: list/create/update/disable/test_call all go through this single authorized surface,
// so project authorization, validation, secret-reference handling and test_call execution are
// the server's contract, not the UI's.
const call = async (payload) => {
  const res = await base44.functions.invoke("integrationApi", payload);
  return res.data;
};

export function useIntegrations(projectId) {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await call({ action: "list", project_id: projectId });
      setIntegrations(data.integrations || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setIntegrations([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const mutate = async (payload) => {
    const data = await call({ ...payload, project_id: projectId });
    await load();
    return data;
  };

  return {
    integrations, loading, error, reload: load,
    create: (definition) => mutate({ action: "create", definition }),
    update: (definition) => mutate({ action: "update", definition }),
    disable: (name) => mutate({ action: "disable", name }),
    // test_call does not mutate the list, so no reload.
    testCall: (name, operation, args) => call({ action: "test_call", name, operation, args }),
  };
}
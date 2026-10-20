import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Custom domains live behind the projectDomains control plane: a hostname only becomes
// servable after a real DNS TXT lookup proves control of it, so this hook never marks a
// domain active on its own.
export default function useDomains(projectId) {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const call = useCallback(async (payload) => {
    const res = await base44.functions.invoke("projectDomains", { project_id: projectId, ...payload });
    return res.data;
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await call({ action: "list" });
      setDomains(data.domains || []);
    } finally { setLoading(false); }
  }, [projectId, call]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (payload) => {
    setWorking(true);
    try { return await call(payload); } finally { setWorking(false); await load(); }
  }, [call, load]);

  return {
    domains, loading, working, reload: load,
    add: (hostname, environment) => act({ action: "add", hostname, environment }),
    verify: (domain_id) => act({ action: "verify", domain_id }),
    setPrimary: (domain_id) => act({ action: "set_primary", domain_id }),
    remove: (domain_id) => act({ action: "remove", domain_id }),
  };
}
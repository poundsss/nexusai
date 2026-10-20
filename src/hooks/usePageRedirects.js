import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Path-level 301 redirects live behind the pageRedirects control plane. Writes require the
// custom-domains plan entitlement (enforced server-side); listing does not.
export default function usePageRedirects(projectId) {
  const [redirects, setRedirects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const call = useCallback(async (payload) => {
    const res = await base44.functions.invoke("pageRedirects", { project_id: projectId, ...payload });
    return res.data;
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await call({ action: "list" });
      setRedirects(data.redirects || []);
    } finally { setLoading(false); }
  }, [projectId, call]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (payload) => {
    setWorking(true);
    try { return await call(payload); } finally { setWorking(false); await load(); }
  }, [call, load]);

  return {
    redirects, loading, working, reload: load,
    create: (source_path, target_path, match_type) => act({ action: "create", source_path, target_path, match_type }),
    update: (redirect_id, source_path, target_path, match_type) => act({ action: "update", redirect_id, source_path, target_path, match_type }),
    remove: (redirect_id) => act({ action: "delete", redirect_id }),
  };
}
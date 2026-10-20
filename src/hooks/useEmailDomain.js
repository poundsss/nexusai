import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Email domains ride the certified emailDomain control plane: the frontend only names a
// documented action and passes its fields — the management PAT stays server-side, and the
// Base44 management API is never called directly from here. The list mirrors the API state
// verbatim: statuses and dns_records are displayed as returned, never inferred.
export default function useEmailDomain(projectId) {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const call = useCallback(async (payload) => {
    const res = await base44.functions.invoke("emailDomain", { project_id: projectId, ...payload });
    return res.data;
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await call({ action: "list" });
      setDomains(data.email_domains || []);
      setError(null);
    } catch (e) {
      setError(String(e?.message || e));
    } finally { setLoading(false); }
  }, [projectId, call]);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (payload) => {
    setWorking(true);
    try { return await call(payload); } finally { setWorking(false); await load(); }
  }, [call, load]);

  return {
    domains, loading, working, error, reload: load,
    // The address prefix the user types becomes the documented from-address form:
    // prefix@domain — the endpoint then re-validates domain equality server-side.
    connect: (domain, sender_name, prefix) => act({ action: "create", domain, sender_name, from_email: `${prefix}@${domain}` }),
    replace: (domain, sender_name, prefix) => act({ action: "replace", domain, sender_name, from_email: `${prefix}@${domain}` }),
    recheck: (domain) => act({ action: "configure", domain }),
    disable: (domain) => act({ action: "disable", domain }),
  };
}
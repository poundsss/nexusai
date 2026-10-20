import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// One bounded, read-only platform overview. Authorization happens server-side: a caller who is not
// a platform admin gets a 403 and this hook surfaces it as an error rather than an empty console.
export function useAdminConsole(limit = 20) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await base44.functions.invoke("adminConsole", { action: "overview", limit });
      setData(res?.data ?? res);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Failed to load the platform console");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load };
}
import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";

// Marketplace browse + install state. All reads go through the marketplace backend function,
// which enforces workspace membership server-side on every write.
export function useMarketplace() {
  const { workspace } = useWorkspace();
  const [listings, setListings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState(null);
  const [sort, setSort] = useState("-install_count");

  const fetchListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("marketplace", {
        action: "browse",
        q: query || null,
        kind: kind || null,
        sort,
        limit: 50,
      });
      setListings(res.data.listings || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [query, kind, sort]);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  const install = useCallback(async (listingId) => {
    if (!workspace) return;
    const res = await base44.functions.invoke("marketplace", {
      action: "install",
      workspace_id: workspace.id,
      listing_id: listingId,
    });
    return res.data;
  }, [workspace]);

  return { listings, loading, error, query, setQuery, kind, setKind, sort, setSort, install, refresh: fetchListings };
}
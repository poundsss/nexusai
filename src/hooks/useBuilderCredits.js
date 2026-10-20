import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";

// Fetches the workspace credit balance and the available model catalog for the Builder.
// Both come from the real commerce backend — no mock data. The balance is the authoritative
// ledger-derived number; spendable is balance minus reserved (in-flight operations).
export function useBuilderCredits() {
  const { workspace, loading: wsLoading } = useWorkspace();
  const [balance, setBalance] = useState(null);
  const [spendable, setSpendable] = useState(null);
  const [models, setModels] = useState([]);
  // P-16C1 (documented): manual model selection is a Builder-plan entitlement. The flag comes
  // from the same commerce response, so the UI gate and the server gate share one truth.
  const [modelSelection, setModelSelection] = useState({ allowed: true });
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!workspace) return;
    setLoading(true);
    try {
      const [summary, modelRes] = await Promise.all([
        base44.functions.invoke("commerce", { action: "summary", workspace_id: workspace.id }),
        base44.functions.invoke("commerce", { action: "models", workspace_id: workspace.id }),
      ]);
      setBalance(summary.data?.balance?.balance ?? null);
      setSpendable(summary.data?.spendable ?? null);
      setModels(modelRes.data?.models || []);
      setModelSelection(modelRes.data?.model_selection || { allowed: true });
    } catch {
      setBalance(null); setSpendable(null); setModels([]); setModelSelection({ allowed: true });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (wsLoading || !workspace) return;
    refresh();
  }, [wsLoading, workspace?.id]);

  return { balance, spendable, models, modelSelection, loading: loading || wsLoading, refresh };
}
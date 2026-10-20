import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Reads the selected project's existing marketing plan (read-only) for brief prefill.
// Returns undefined while loading, null when there is no plan (or it can't be read).
export default function usePlanPrefill(projectId, enabled) {
  const [plan, setPlan] = useState(undefined);
  useEffect(() => {
    if (!enabled || !projectId) return;
    let alive = true;
    setPlan(undefined);
    base44.functions.invoke("marketingPlan", { action: "get", project_id: projectId })
      .then((r) => { if (alive) setPlan(r.data?.plan || null); })
      .catch(() => { if (alive) setPlan(null); });
    return () => { alive = false; };
  }, [projectId, enabled]);
  if (plan === undefined || plan === null) return plan;
  const monthly = plan.budget_mode === "paid" ? Number(plan.budget_monthly_amount) || 0 : 0;
  return {
    goal: plan.goal || "",
    audience: plan.audience || "",
    monthly,
    suggestedDaily: monthly > 0 ? Math.round((monthly / 30) * 100) / 100 : null,
  };
}
import { useEffect, useState } from "react";
import { briefCall } from "../briefApi";

// Creatives over the EXISTING googleAds asset actions. Sessions are project-scoped server-side;
// after a refresh the newest session is found through the existing change log (asset.generated).
export default function useCreatives(projectId) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const log = await briefCall("change_log_list", projectId, { limit: 100 });
      const last = (log.changes || []).find((c) => c.action === "asset.generated");
      const s = last ? (await briefCall("asset_list", projectId, { session_id: last.resource_id })).session : null;
      if (alive) setSession(s);
    })().catch((e) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [projectId]);

  const generate = async (brief) => {
    setGenerating(true); setError("");
    try {
      const extra = { campaign_type: brief.campaign_type };
      if (brief.landing_page) extra.final_url = brief.landing_page;
      else extra.freeform_prompt = `${brief.headlines[0] || ""} ${brief.descriptions[0] || ""}`.trim() || "Ad creative for this app";
      const r = await briefCall("asset_generate_all", projectId, extra);
      setSession(r.session);
      if (r.in_flight) setError("A generation is already running for this project — showing it.");
    } catch (e) { setError(e.message); } finally { setGenerating(false); }
  };

  return { session, loading, generating, error, generate };
}
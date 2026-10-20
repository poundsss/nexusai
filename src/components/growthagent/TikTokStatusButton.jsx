import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";

export default function TikTokStatusButton({ post, onChecked }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = async () => {
    setBusy(true); setError("");
    try { await base44.functions.invoke("virality", { action: "tiktok_check_status", project_id: post.project_id, post_id: post.id }); onChecked(); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };
  return <div className="mt-2">
    <Button variant="outline" size="sm" disabled={busy} onClick={check}>{busy ? "Checking TikTok…" : "Check TikTok status (no resubmission)"}</Button>
    {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
  </div>;
}
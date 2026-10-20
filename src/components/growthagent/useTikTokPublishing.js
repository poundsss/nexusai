import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

export default function useTikTokPublishing(projectId, onQueued) {
  const [readiness, setReadiness] = useState(null);
  const [credentialId, setCredentialId] = useState("");
  const [creator, setCreator] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(null);
  const invoke = useCallback(async (action, args = {}) => (await base44.functions.invoke("virality", { action, project_id: projectId, ...args })).data, [projectId]);
  const load = useCallback(async () => {
    setError(""); setReadiness(null);
    try { const data = await invoke("tiktok_readiness"); setReadiness(data); setCredentialId(data.credentials?.[0]?.credential_id || ""); }
    catch (e) { setError(e.response?.data?.error || e.message); }
  }, [invoke]);
  useEffect(() => { pending.current = null; setCreator(null); setCredentialId(""); setNotice(""); load(); }, [load]);
  useEffect(() => {
    let active = true; setCreator(null);
    if (credentialId) invoke("tiktok_creator", { credential_id: credentialId }).then((data) => { if (active) setCreator(data.creator); }).catch((e) => { if (active) setError(e.response?.data?.error || e.message); });
    return () => { active = false; };
  }, [credentialId, invoke]);
  const connect = async () => {
    setBusy(true); setError("");
    try {
      const flow = await invoke("tiktok_oauth_begin");
      if (flow.redirect_uri !== `${window.location.origin}/oauth/callback`) throw new Error("Set TIKTOK_OAUTH_REDIRECT_URI to this site's static HTTPS /oauth/callback address and register the identical URI with TikTok.");
      sessionStorage.setItem(`nexus-tiktok-oauth:${flow.state}`, JSON.stringify({ projectId }));
      window.location.href = flow.authorization_url;
    } catch (e) { setError(e.response?.data?.error || e.message); setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError("");
    try { await invoke("tiktok_disconnect", { credential_id: credentialId }); await load(); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };
  const queue = async (input) => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (!pending.current) {
        const at = new Date(Date.now() + 5000).toISOString();
        const post = await invoke("calendar_create", { ...input, platform: "tiktok", tiktok_credential_id: credentialId, scheduled_at: at });
        pending.current = { id: post.id, at, signature: JSON.stringify({ input, credentialId }) };
      } else if (pending.current.signature !== JSON.stringify({ input, credentialId })) {
        await invoke("calendar_update", { ...input, post_id: pending.current.id, tiktok_credential_id: credentialId });
        pending.current.signature = JSON.stringify({ input, credentialId });
      }
      const post = pending.current;
      await invoke("calendar_schedule", { scheduled_from: post.at, scheduled_until: new Date(Date.parse(post.at) + 1).toISOString() });
      pending.current = null;
      setNotice("Video approved and queued. The calendar will report TikTok's confirmed outcome.");
      onQueued?.();
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };
  return { readiness, credentialId, setCredentialId, creator, busy, error, notice, connect, disconnect, queue, load };
}
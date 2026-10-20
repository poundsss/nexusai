import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

const ACTIVE = ["QUEUED", "RUNNING", "FETCHING", "VALIDATING", "COMMITTING"];
const CONNECTOR_ID = "6aa7379a5901c68a6bf5f204";

// GitHub operations are durable server-side jobs; this hook only mirrors their state.
// Closing the tab does not interrupt an export or import.
export default function useGitHub(projectId) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [commitMap, setCommitMap] = useState([]);
  const [webhook, setWebhook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [s, h] = await Promise.all([
      base44.functions.invoke("githubLink", { project_id: projectId, action: "status" }),
      base44.functions.invoke("githubSync", { project_id: projectId, action: "history" }),
    ]);
    setStatus(s.data);
    setRuns(h.data.runs || []);
    setCommitMap(h.data.commit_map || []);
    // Load webhook status only when a link exists.
    if (s.data?.link && s.data.link.status !== "disconnected") {
      const w = await base44.functions.invoke("githubLink", { project_id: projectId, action: "webhook", subaction: "status" });
      setWebhook(w.data?.webhook || null);
    } else {
      setWebhook(null);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (runs.some((r) => ACTIVE.includes(r.status))) timer.current = setTimeout(load, 4000);
    return () => clearTimeout(timer.current);
  }, [runs, load]);

  const call = useCallback(async (fn, payload) => {
    setWorking(true);
    try {
      const res = await base44.functions.invoke(fn, { project_id: projectId, ...payload });
      await load();
      return res.data;
    } finally { setWorking(false); }
  }, [projectId, load]);

  // OAuth opens in its own tab; when it closes we re-check the connection. A closed tab with no
  // resulting connection means the user cancelled consent, which is reported as such rather than
  // being left as an indefinite "connecting" state.
  const connect = useCallback(async () => {
    setConnectError(null);
    let url;
    try {
      url = await base44.connectors.connectAppUser(CONNECTOR_ID);
    } catch (e) {
      setConnectError(e.response?.data?.error || e.message || "Could not start GitHub authorization.");
      return;
    }
    const popup = window.open(url, "_blank");
    const poll = setInterval(async () => {
      if (popup && !popup.closed) return;
      clearInterval(poll);
      const [s] = await Promise.all([base44.functions.invoke("githubLink", { project_id: projectId, action: "status" })]);
      setStatus(s.data);
      if (!s.data?.connected) setConnectError("GitHub authorization was not completed. Nothing was connected.");
    }, 600);
  }, [projectId]);

  // The OAuth grant is revoked through the caller's own client; the link is retired server-side.
  const disconnect = useCallback(async () => {
    setWorking(true);
    try {
      await base44.connectors.disconnectAppUser(CONNECTOR_ID);
      await base44.functions.invoke("githubLink", { project_id: projectId, action: "disconnect" });
      setConnectError(null);
      await load();
    } finally { setWorking(false); }
  }, [projectId, load]);

  return {
    status, link: status?.link || null, connected: !!status?.connected, account: status?.account || null,
    // A link created with another user's GitHub authorization is read-only for this user.
    linkIsYours: status?.link_is_yours !== false,
    // GitHub still holds a credential for this user, but it is no longer valid (revoked/expired).
    tokenInvalid: !!status?.token_invalid,
    runs, commitMap, webhook, loading, working, connectError, reload: load, connect, disconnect,
    listRepos: () => call("githubLink", { action: "repos" }),
    listBranches: (repo_full_name) => call("githubLink", { action: "branches", repo_full_name }),
    linkRepo: (payload) => call("githubLink", { action: "link", ...payload }),
    unlink: () => call("githubLink", { action: "unlink" }),
    exportVersion: (version_id) => call("githubSync", { action: "export", version_id }),
    importCommit: (commit_sha) => call("githubSync", { action: "import", commit_sha }),
    cancel: (sync_run_id) => call("githubSync", { action: "cancel", sync_run_id }),
    registerWebhook: () => call("githubLink", { action: "webhook", subaction: "register" }),
    webhookStatus: () => call("githubLink", { action: "webhook", subaction: "status" }),
    removeWebhook: () => call("githubLink", { action: "webhook", subaction: "delete" }),
  };
}
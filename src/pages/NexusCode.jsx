import React, { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Loader2, AlertCircle } from "lucide-react";
import EntryScreen from "@/components/nexuscode/EntryScreen";
import SessionSetup from "@/components/nexuscode/SessionSetup";
import CodeWorkspace from "@/components/nexuscode/CodeWorkspace";
import { startGithubConnect, disconnectGithub } from "@/lib/nexusGithubConnect";

// The live GitHub app-user connector is resolved through the existing connector
// resolution contract (src/lib/nexusGithubConnect.js) — never hardcoded here.

// Nexus Code — the global per-user GitHub working surface. Connection is strictly per
// user (the platform GitHub app-user connector); sessions, browsing, branches, edits,
// commits and PRs all run through the single `nexusCode` backend surface.
export default function NexusCode() {
  const [status, setStatus] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [entered, setEntered] = useState(false); // past the entry screen, into repo selection

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke("nexusCode", { action: "status" });
      setStatus(res.data);
      // A session may only be restored once the GitHub connection is confirmed;
      // otherwise the entry screen's Connect flow is the surface, never the editor.
      setSession(res.data?.connected ? (res.data.sessions || [])[0] || null : null);
      setError(null);
    } catch (e) {
      const code = e.response?.data?.code;
      if (e.response?.status === 428 || code === "GITHUB_NOT_CONNECTED") {
        // Authorization lost → the entry screen is the reconnect surface, not a retry.
        setStatus({ connected: false, sessions: [] });
        setSession(null);
        setEntered(false);
        setError(null);
      } else {
        setError(e.response?.data?.error || e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Disconnect through the existing app-user connector contract, then return to the
  // disconnected entry-screen state.
  const disconnect = async () => {
    setDisconnecting(true);
    setConnectError(null);
    try {
      await disconnectGithub();
      setSession(null);
      setEntered(false);
      await load();
    } catch (e) {
      setConnectError(e.response?.data?.error || e.message || "Could not disconnect GitHub.");
    } finally {
      setDisconnecting(false);
    }
  };

  // A 428 GITHUB_NOT_CONNECTED anywhere in the workspace routes back to the entry
  // screen's Connect flow instead of leaving a dead workspace.
  const onAuthLost = () => {
    setSession(null);
    setEntered(false);
    load();
  };

  // Per-user connect: the OAuth popup belongs to THIS user; when it closes we re-check.
  // The popup is opened SYNCHRONOUSLY on click — an await before window.open loses the
  // user-gesture context and the browser's popup blocker silently kills the window.
  const connect = async () => {
    setConnectError(null);
    setConnecting(true);
    const popup = window.open("", "nexus-github-oauth", "popup,width=700,height=700");
    try {
      const { url } = await startGithubConnect();
      if (popup) {
        popup.location.href = url;
      } else {
        // Fail safe: the blocker won the synchronous race — navigate this tab directly.
        window.location.href = url;
        return;
      }
      const timer = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(timer);
        setConnecting(false);
        setEntered(true); // connected → continue straight into repository selection
        load();
      }, 600);
    } catch (e) {
      if (popup) popup.close();
      setConnectError(e.response?.data?.error || e.message || "Could not start GitHub authorization.");
      setConnecting(false);
    }
  };

  if (loading) {
    return <div className="h-full grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="h-6 w-6 mx-auto text-destructive" />
          <p className="mt-3 text-[13px] text-muted-foreground">{error}</p>
          <button onClick={load} className="mt-4 rounded-md bg-foreground text-background px-3 py-1.5 text-[13px] font-semibold hover:opacity-90">Retry</button>
        </div>
      </div>
    );
  }
  // Product flow: Nexus Code → entry screen → connect / select GitHub repo → workspace.
  // An active session still opens the workspace directly.
  if (!session) {
    if (status?.connected && entered) return <SessionSetup onConnected={setSession} />;
    return (
      <EntryScreen
        connected={!!status?.connected}
        account={status?.account || null}
        onConnect={status?.connected ? () => setEntered(true) : connect}
        onDisconnect={disconnect}
        disconnecting={disconnecting}
        busy={connecting}
        error={connectError}
      />
    );
  }
  return (
    <CodeWorkspace
      session={session}
      onSessionChanged={setSession}
      onDeleted={() => { setEntered(false); load(); }}
      onAuthLost={onAuthLost}
    />
  );
}
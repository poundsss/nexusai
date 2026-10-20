import { base44 } from "@/api/base44Client";

// Frontend mirror of the server-side GitHub credential resolution
// (base44/shared/githubAuth.ts): the app-user connector first, then the platform
// connector keyed by integration type. The first target the live app-user connect
// contract accepts wins; when neither resolves, the error is surfaced honestly.
const TARGETS = ["6ac5a79691563ae2600a42e5", "6ac5a0d3f7027dd95c175040"];

export async function startGithubConnect() {
  let lastErr = null;
  for (const connectorId of TARGETS) {
    try {
      const url = await base44.connectors.connectAppUser(connectorId);
      if (url) return { connectorId, url };
      lastErr = new Error("GitHub authorization did not return a connect URL.");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No GitHub app-user connector is available in this workspace.");
}

export async function disconnectGithub() {
  let lastErr = null;
  for (const connectorId of TARGETS) {
    try {
      await base44.connectors.disconnectAppUser(connectorId);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  // No per-user connection exists on either connector — the per-user state is ALREADY
  // disconnected (the workspace's shared platform authorization is a different scope
  // and never appeared as a per-user connection to begin with). Treat it as success.
  if (lastErr && /no active connection/i.test(lastErr.message || "")) {
    return;
  }
  throw lastErr || new Error("No GitHub app-user connector is available in this workspace.");
}
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Module-level cache: the workspace resolution promise is shared across every component
// that calls useWorkspace in the same session. This prevents a race where AppShell + a
// page both fire simultaneously on first login and each creates a duplicate workspace.
// A page refresh re-runs the resolution; a rename in Settings updates the row directly.
let wsPromise = null;

function resolveWorkspace() {
  if (wsPromise) return wsPromise;
  wsPromise = (async () => {
    const me = await base44.auth.me();
    // Provisioning is SERVER-side: the bootstrap endpoint resolves (or creates on first entry)
    // the account's single internal workspace, its owner membership row and its welcome credits
    // through the authoritative ledger. It takes no input, so the browser can never claim
    // another account's workspace, and it never creates a project.
    // An optional referral code captured at signup (?ref=…) is redeemed SERVER-side exactly
    // once, then discarded so every later bootstrap behaves exactly as before.
    let referral_code;
    try { referral_code = localStorage.getItem("referral_code") || undefined; } catch { /* unavailable */ }
    const res = await base44.functions.invoke("bootstrapWorkspace", referral_code ? { referral_code } : {});
    try { localStorage.removeItem("referral_code"); } catch { /* unavailable */ }
    // The role comes back from the same call the shell used to make separately — it drives UI
    // visibility only; the server remains authoritative on every request.
    return { user: me, workspace: res.data.workspace, role: res.data.role, capabilities: res.data.capabilities || [], referralCode: res.data.referral_code || null };
  })();
  return wsPromise;
}

// Resolves (or provisions) the current user's workspace, cached per session.
export function useWorkspace() {
  const [user, setUser] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);

  const [role, setRole] = useState(null);
  const [capabilities, setCapabilities] = useState([]);
  const [referralCode, setReferralCode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    resolveWorkspace().then(({ user, workspace, role, capabilities, referralCode }) => {
      if (!cancelled) { setUser(user); setWorkspace(workspace); setRole(role); setCapabilities(capabilities); setReferralCode(referralCode); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  return { user, workspace, role, capabilities, loading, referralCode };
}
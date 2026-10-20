import { useCallback, useEffect, useState } from "react";
import { briefCall } from "../briefApi";

// Server-side readiness only: the existing launch_readiness + account_get reads (Google channel).
// The client never decides readiness itself.
export default function useLaunchReadiness(projectId, landingPage) {
  const [state, setState] = useState({ loading: true, readiness: null, account: null, error: "" });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const [readiness, acc] = await Promise.all([
        briefCall("launch_readiness", projectId, { channel: "google", landing_page: landingPage || "" }),
        briefCall("account_get", projectId, { channel: "google" }),
      ]);
      setState({ loading: false, readiness, account: acc.account, error: "" });
    } catch (e) {
      setState({ loading: false, readiness: null, account: null, error: e.message });
    }
  }, [projectId, landingPage]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}
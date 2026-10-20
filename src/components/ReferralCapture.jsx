import React, { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Captures a referral code arriving on any route (?ref=CODE — the /register entry point of a
// shared referral link) into local storage, then cleans the URL. The code is redeemed exactly
// once by the next server-side workspace bootstrap and discarded afterwards. Nothing here
// names a referrer — only the code travels, and the server resolves it.
const KEY = "referral_code";

export default function ReferralCapture() {
  const { search } = useLocation();
  useEffect(() => {
    const ref = new URLSearchParams(search).get("ref");
    if (!ref) return;
    const code = String(ref).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
    if (!code) return;
    try { localStorage.setItem(KEY, code); } catch { /* storage unavailable — no attribution */ }
    const url = new URL(window.location.href);
    url.searchParams.delete("ref");
    window.history.replaceState({}, "", url.toString());
  }, [search]);
  return null;
}
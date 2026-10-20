// Meta Ads connect start (docs.zernio.com/platforms/meta-ads#connect + guides/connecting-accounts,
// fetched 2026-10-09): GET /v1/connect/facebook/ads with profileId (the team's default profile
// from GET /v1/profiles) and loginMode=business returns an `authUrl` the member opens. Zernio
// hosts the Page selection, then sends the browser to `redirect_url`. Nothing is created by this
// app — linking stays the explicit account_link step.
import { ZERNIO_API_BASE_URL } from "./zernioAdsProvider.ts";

const fail = (message, code, status = 502) => Object.assign(new Error(message), { code, status });

export async function startZernioMetaConnect({ redirectUrl, fetcher = fetch.bind(globalThis), apiKey } = {}) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw fail("Zernio is not configured (ZERNIO_API_KEY). No Zernio call was made.", "PROVIDER_NOT_CONFIGURED", 409);
  const get = async (path) => {
    const name = path.split("?")[0];
    let res;
    try {
      res = await fetcher(`${ZERNIO_API_BASE_URL}${path}`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw fail(`Zernio ${name} request failed: ${String(e?.message || e).slice(0, 200)}`, "PROVIDER_ERROR");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(`Zernio ${name} returned HTTP ${res.status}${body?.error ? `: ${String(body.error).slice(0, 200)}` : ""}`, "PROVIDER_ERROR");
    return body;
  };
  const profiles = (await get("/profiles")).profiles || [];
  const profile = profiles.find((p) => p?.isDefault) || profiles[0];
  if (!profile?._id) throw fail("The Zernio team has no profile to connect Meta Ads to — create one in Zernio first.", "ZERNIO_PROFILE_MISSING", 409);
  const q = new URLSearchParams({ profileId: String(profile._id), loginMode: "business", redirect_url: redirectUrl });
  const body = await get(`/connect/facebook/ads?${q.toString()}`);
  if (!body?.authUrl) throw fail("Zernio returned no authUrl", "PROVIDER_ERROR");
  return { auth_url: String(body.authUrl) };
}
// Shared deterministic helpers for the OpenAI Ads connection certifications (the adapter/surface
// cert and the UI cert): the scratch connection fixture the injected fetch seam always returns,
// the optional-recording fetch seam itself, and the nonexistent project reference used by
// fail-closed checks that never persist.
export const OPENAI_CONNECT_CONNECTED = { accountId: "66b2e19d8c3f5a7e9d0b1c2d", adAccountName: "Acme US" };

/** The documented 200 connect response — records requests when a calls array is passed. */
export const connectOkFetcher = (calls) => async (url, init) => {
  if (calls) calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization || null, body: init?.body ? JSON.parse(String(init.body)) : null });
  return new Response(JSON.stringify(OPENAI_CONNECT_CONNECTED), { status: 200 });
};

/** A nonexistent project reference for fail-closed surface checks — never persists. */
export const openaiConnectGhostProject = () => ({ id: `no-such-project-${Date.now()}`, workspace_id: "no-such-workspace" });
// ONE server-side contract for the reference images a request may carry.
//
// Images reach the platform as STORED file URLs produced by the existing upload — never raw image
// data and never a client-declared payload shape. Every entry point that accepts them (the AI run
// enqueue and the agent control plane) normalizes through this single function, so the cap, the
// accepted form and the de-duplication are identical everywhere and a malformed value can never be
// persisted or forwarded to a provider.
export const MAX_IMAGE_URLS = 4;

export function normalizeImageUrls(input) {
  if (!Array.isArray(input)) return [];
  const urls = [];
  for (const raw of input) {
    const url = String(raw || "").trim();
    if (!/^https?:\/\/\S+$/i.test(url) || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= MAX_IMAGE_URLS) break;
  }
  return urls;
}
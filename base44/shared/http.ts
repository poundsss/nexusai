// Minimal http() helper that mirrors the recovered CRM's ctx.http contract:
// http(url, { method, query, headers }) -> { ok, status, body }.
// Used by backend functions that call external APIs (getWeather, secretPing).

export async function http(url: string, opts: any = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  let finalUrl = url;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) finalUrl = url + (url.includes("?") ? "&" : "?") + s;
  }
  const res = await fetch(finalUrl, { method, headers });
  const ct = res.headers.get("content-type") || "";
  let body: any = null;
  if (ct.includes("application/json")) {
    try { body = await res.json(); } catch { body = null; }
  } else {
    try { body = await res.text(); } catch { body = null; }
  }
  return { ok: res.ok, status: res.status, body };
}
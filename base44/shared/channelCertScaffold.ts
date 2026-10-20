// Shared certification scaffolding for the channel parity suites (P-9.10A Telegram,
// P-9.10C WhatsApp, P-9.11L LINE, P-9.12S Slack). Only the SCRIPTED provider transports and the
// platform-burst retry wrapper live here; every suite drives the REAL shipping modules on top.
// No production path imports this module.
export const RETRY_RE = /rate limit/i;

export function withRetry(fn) {
  return async (...args) => {
    for (let i = 0; ; i++) {
      try { return await fn(...args); }
      catch (e) {
        if (i < 5 && RETRY_RE.test(String(e?.message || ""))) { await new Promise((r) => setTimeout(r, 3000 * (i + 1))); continue; }
        throw e;
      }
    }
  };
}

// The platform rate-limits SDK request bursts; handlers see a retrying entity surface so a 429
// (never a property under test) is retried instead of aborting the certification.
export function retryingEntities(entities) {
  return new Proxy(entities, {
    get(target, name) {
      const e = target[name];
      if (!e || typeof e !== "object") return e;
      return new Proxy(e, {
        get(et, m) {
          const v = et[m];
          return typeof v === "function" ? withRetry(v.bind(et)) : v;
        },
      });
    },
  });
}

// Scripted provider transports for the regression-isolation probes.
export const makeTgHttpStub = (username) => async (url) => {
  const method = String(url).split("/").pop();
  return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username } : {} }), { headers: { "content-type": "application/json" } });
};

export const makeWaHttpStub = (stamp) => async (url) => {
  const u = String(url);
  if (u.includes("?fields=display_phone_number")) {
    return new Response(JSON.stringify({ display_phone_number: `1555${String(stamp).slice(-7)}`, id: `pnid${stamp}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.out" }] }), { status: 200, headers: { "content-type": "application/json" } });
};

export const makeLineHttpStub = (userId = "U-base44-bot") => async (url) => {
  if (String(url).endsWith("/info")) {
    return new Response(JSON.stringify({ userId, displayName: "base44 bot" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
};
// Built-in Superagent chat web browsing (`browse_page`) — Batch 2. Evidence-driven:
//   • VERIFIED (docs.base44.com, Browsing with your Superagent + Getting-Started/superagent):
//     the Superagent "can browse the web to research topics, look things up, and complete tasks
//     for you. It uses a secure cloud browser that runs in the background, so you can watch it
//     work right from the chat"; it works "right away from chat" with NO setup; and it "cannot
//     reach your local network or private network addresses, such as `localhost`".
//   • Base44 publishes NO browser provider, protocol or result shape (UNKNOWN) — none is
//     invented. The adapter reuses the CERTIFIED browser-extension bridge browse path
//     (agentBrowserBridge.bridgeBrowse): the same https-only + private-host SSRF guard, the
//     same hard timeout and size cap, the same read-only text/links extraction. No page script
//     is ever executed, no fill plan is offered here (the extension's fill flow is unchanged),
//     and the tool touches no project or user data. Like google_search, the tool is a PLATFORM
//     BUILT-IN (never a tool_configs grant) with the SAME durable (turn, step) claim, and the
//     turn's existing per-message model billing is the only charge — integrationCharges keeps
//     unpriced external calls free, so no rate is invented.
//   • The adapter never throws: the agent step path turns every failure into a safe observation
//     (the chat's existing tool_calls projection is what makes the activity watchable).
import { bridgeBrowse } from "./agentBrowserBridge.ts";
import { scrubText } from "./tracing.ts";

export const WEB_BROWSE_LIMITS = {
  PAGE_TEXT_CHARS: 4000,   // bounded page text handed to the model (well under the observation cap)
  MAX_LINKS: 20,           // links returned at most (the bridge itself caps at 50)
};

/**
 * ONE bounded, read-only page browse. NEVER throws:
 *   { ok: true, page: { url, status, title, text, links } } or { ok: false, code, message }.
 * Codes are the certified bridge refusal codes (BRIDGE_URL_REFUSED for non-https and
 * private/local hosts, BRIDGE_BROWSE_FAILED, BRIDGE_BROWSE_UNSUPPORTED, BRIDGE_BROWSE_EMPTY).
 */
export async function runWebBrowse({ url, fetchImpl = null } = {}) {
  const target = String(url ?? "").trim();
  if (!target) return { ok: false, code: "WEB_BROWSE_URL_REQUIRED", message: "a page URL is required" };
  try {
    const page = await bridgeBrowse({ url: target, ...(fetchImpl ? { fetchImpl } : {}) });
    return {
      ok: true,
      page: {
        url: page.url, status: page.status, title: page.title || null,
        text: scrubText(String(page.text ?? ""), WEB_BROWSE_LIMITS.PAGE_TEXT_CHARS),
        links: (page.links || []).slice(0, WEB_BROWSE_LIMITS.MAX_LINKS),
      },
    };
  } catch (e) {
    return { ok: false, code: e?.code || "WEB_BROWSE_FAILED", message: scrubText(String(e?.message || e), 200) };
  }
}
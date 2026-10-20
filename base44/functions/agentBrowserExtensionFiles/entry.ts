// P-9.13B — the NexusAI-native browser extension package, served file by file. PUBLIC by
// design: the files are the extension's own source (manifest, service worker, content script,
// popup) and carry NO secret — the pairing token is entered by the user at runtime and the
// bridge session is stored only in the extension's own chrome.storage. No provider API is
// invented: the extension talks ONLY to this app's agentBrowserBridge endpoint.
export const config = { public: true };

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "NexusAI Agent Bridge",
  version: "1.0.0",
  description: "The NexusAI-native agent browser bridge: browse sites and fill forms with your agent.",
  permissions: ["storage", "activeTab", "scripting"],
  action: { default_popup: "popup.html" },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle" }],
  host_permissions: ["http://*/*", "https://*/*"],
}, null, 2);

const BACKGROUND = `// NexusAI Agent Bridge — service worker. Session-scoped bridge calls only: every request
// carries the stored session token, and the bridge answers with data (never code).
const BRIDGE_KEY = "nexus_bridge";
const DEFAULT_BRIDGE_URL = self.BRIDGE_URL || "";

async function getState() {
  const st = await chrome.storage.local.get(BRIDGE_KEY);
  return st[BRIDGE_KEY] || {};
}
async function setState(patch) {
  const st = await getState();
  await chrome.storage.local.set({ [BRIDGE_KEY]: { ...st, ...patch } });
}

async function bridgeCall(url, body) {
  const state = await getState();
  if (!state.bridge_url || !state.session_token) throw new Error("BRIDGE_UNAUTHORIZED: the extension is not activated yet");
  const res = await fetch(state.bridge_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, session_token: state.session_token, project_id: state.project_id }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { await setState({ session_token: null }); throw new Error(data.error || "BRIDGE_UNAUTHORIZED"); }
  if (!res.ok) throw new Error(data.error || "bridge error");
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "activate") {
        const res = await fetch(msg.bridge_url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "activate", project_id: msg.project_id, token: msg.token }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "activation failed");
        await setState({ bridge_url: msg.bridge_url, project_id: msg.project_id, session_token: data.session_token, agent: data.agent });
        sendResponse({ ok: true, agent: data.agent, expires_in_ms: data.expires_in_ms });
      } else if (msg.type === "browse") {
        sendResponse({ ok: true, page: await bridgeCall(null, { action: "browse", url: msg.url }) });
      } else if (msg.type === "fill") {
        sendResponse({ ok: true, plan: await bridgeCall(null, { action: "fill", intent: msg.intent, page_text: msg.page_text || "", fields: msg.fields }) });
      } else if (msg.type === "state") {
        const st = await getState();
        sendResponse({ ok: true, agent: st.agent || null, session: !!st.session_token });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});
`;

const CONTENT = `// NexusAI Agent Bridge — content script. Collects the LIVE DOM's fillable fields and applies
// the bridge's fill plan with element.value assignments ONLY — no script injection, and
// password / file / checkbox / radio fields are never touched (the permission model).
const FILLABLE = new Set(["text", "email", "search", "tel", "url", "number", "textarea", "select", "date", "time"]);
const FORBIDDEN = new Set(["password", "file", "checkbox", "radio", "color", "range", "hidden", "submit", "button", "image"]);

function collectFields(root) {
  const nodes = Array.from(root.querySelectorAll("input, textarea, select"));
  const fields = [];
  for (const el of nodes) {
    const type = (el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : el.tagName.toLowerCase());
    if (FORBIDDEN.has(type) || !FILLABLE.has(type)) continue;
    const name = el.getAttribute("name") || el.getAttribute("id") || "";
    if (!name) continue;
    fields.push({ name, type, label: el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].textContent || "") || "" });
  }
  return fields.slice(0, 30);
}

function applyFills(fills) {
  let applied = 0;
  for (const f of fills || []) {
    const el = document.querySelector(\`[name="\${CSS.escape(f.name)}"], [id="\${CSS.escape(f.name)}"]\`);
    if (!el || el.disabled || el.readOnly) continue;
    const type = (el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : el.tagName.toLowerCase());
    if (FORBIDDEN.has(type)) continue;
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find((o) => o.value === f.value || o.textContent.trim() === f.value);
      if (opt) { el.value = opt.value; applied++; el.dispatchEvent(new Event("change", { bubbles: true })); }
    } else {
      el.value = f.value; applied++; el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  return applied;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "collect_fields") {
    sendResponse({ ok: true, fields: collectFields(document), page_text: (document.body ? document.body.innerText : "").slice(0, 4000) });
  } else if (msg.type === "apply_fills") {
    sendResponse({ ok: true, applied: applyFills(msg.fills) });
  }
  return true;
});
`;

const POPUP = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font: 13px system-ui, sans-serif; width: 320px; margin: 0; padding: 14px; color: #111; }
    h1 { font-size: 14px; margin: 0 0 8px; }
    input, button { font: 13px system-ui, sans-serif; }
    input { width: 100%; box-sizing: border-box; padding: 7px; margin: 4px 0 10px; }
    button { padding: 7px 10px; cursor: pointer; }
    #status { margin-top: 10px; color: #555; min-height: 18px; }
    .row { display: flex; gap: 8px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>NexusAI Agent Bridge</h1>
  <label>Bridge URL</label>
  <input id="bridge" placeholder="https://your-app/api/functions/agentBrowserBridge" />
  <label>Project ID</label>
  <input id="project" placeholder="from your agent settings" />
  <label>Pairing token</label>
  <input id="token" placeholder="from your agent's Channels settings" />
  <button id="activate">Activate</button>
  <div class="row" style="margin-top:10px">
    <button id="browse">Browse this tab</button>
    <button id="fill">Fill forms</button>
  </div>
  <input id="intent" placeholder="what to fill, e.g. sign up with my work email" />
  <div id="status"></div>
  <script src="popup.js"></script>
</body>
</html>
`;

const POPUP_JS = `// NexusAI Agent Bridge — popup. Fail-closed: nothing happens without an activated session.
const $ = (id) => document.getElementById(id);
const status = (t) => { $("status").textContent = t; };

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

$("activate").addEventListener("click", async () => {
  const bridge_url = $("bridge").value.trim();
  const project_id = $("project").value.trim();
  const token = $("token").value.trim();
  if (!bridge_url || !project_id || !token) { status("Bridge URL, project ID and token are all required."); return; }
  const res = await send({ type: "activate", bridge_url, project_id, token });
  status(res && res.ok ? \`Activated for agent \${res.agent} (24h session).\` : \`Refused: \${(res && res.error) || "activation failed"}\`);
});

$("browse").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) { status("No http(s) tab active."); return; }
  const res = await send({ type: "browse", url: tab.url });
  if (!(res && res.ok)) { status(\`Refused: \${(res && res.error) || "browse failed"}\`); return; }
  const p = res.page;
  status(\`Read \${(p.text || "").length} chars, \${(p.forms || []).length} form(s).\`);
  window.__lastPage = p;
});

$("fill").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { status("No active tab."); return; }
  const collected = await chrome.tabs.sendMessage(tab.id, { type: "collect_fields" });
  if (!(collected && collected.ok) || !collected.fields.length) { status("No fillable fields on this page."); return; }
  const res = await send({ type: "fill", intent: $("intent").value.trim(), page_text: collected.page_text, fields: collected.fields });
  if (!(res && res.ok)) { status(\`Refused: \${(res && res.error) || "fill failed"}\`); return; }
  const applied = await chrome.tabs.sendMessage(tab.id, { type: "apply_fills", fills: res.plan.fills });
  status(applied && applied.ok ? \`Filled \${applied.applied} field(s).\` : "Could not apply the plan.");
});

send({ type: "state" }).then((s) => { if (s && s.ok) status(s.session ? \`Session active (agent \${s.agent}).\` : "Not activated yet."); });
`;

const FILES = {
  "manifest.json": { type: "application/json", body: MANIFEST },
  "background.js": { type: "text/javascript", body: BACKGROUND },
  "content.js": { type: "text/javascript", body: CONTENT },
  "popup.html": { type: "text/html", body: POPUP },
  "popup.js": { type: "text/javascript", body: POPUP_JS },
};

export default async function (req) {
  const file = new URL(req.url).searchParams.get("file") || "";
  const f = FILES[file];
  if (!f) {
    return Response.json({ error: "Unknown file", files: Object.keys(FILES) }, { status: 404 });
  }
  return new Response(f.body, {
    headers: { "content-type": `${f.type}; charset=utf-8`, "cache-control": "no-store" },
  });
}
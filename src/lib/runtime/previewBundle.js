// Turns the project's files into a self-contained sandboxed document.
//
// Module loading strategy: each file becomes a blob: URL ES module created INSIDE the
// sandboxed document, and relative imports are rewritten to the dependency's blob URL.
// Blob URLs (not data: URLs) are used deliberately: browsers refuse to evaluate a module
// script fetched from a data: URL, so the previous data:-URL bundle imported nothing and the
// preview rendered a blank page. Blob URLs are minted in the iframe's own origin, so the
// dependency graph resolves normally.
//
// Because the URLs only exist at runtime, dependency specifiers are emitted as %%MOD:path%%
// placeholders and substituted by the loader in dependency-first order.
import { runtimeSource } from "./runtimeSource";

const RUNTIME_KEY = "\u0000runtime";
const ph = (key) => `%%MOD:${key}%%`;

// The CSP that governs the sandboxed preview document. This MUST be applied to the builder
// preview as well as the production runtime: a srcDoc iframe inherits the parent page's CSP,
// and the Base44 platform's CSP does not include blob:/data: in script-src. Without this meta
// tag the preview's module loading is silently blocked and nothing renders. The policy mirrors
// base44/shared/securityHeaders.ts APP_CSP — keep them in sync.
export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob: data: https://cdn.tailwindcss.com",
  "style-src 'unsafe-inline' https://cdn.tailwindcss.com",
  "img-src data: blob: https:",
  "font-src data: https:",
  "connect-src blob: data: https:",
  "media-src data: blob: https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

// Always-injected collaboration telemetry (route tracking + throttled cursor position). Lightweight:
// a mousemove listener throttled to ~20fps posting runtime:cursor to the parent. No DOM mutation,
// no source change, no element attributes — cursor position is iframe-viewport-relative; element
// identity for selections is a deterministic child-index path computed at pick time. Reuses the
// EXISTING postMessage channel; adds one iframe→parent message: runtime:cursor. Builder-preview only.
const COLLAB_HTML = `<script>(function(){window.__nxRoute="/";window.addEventListener("message",function(e){if(e.data&&e.data.type==="runtime:goto"&&typeof e.data.path==="string")window.__nxRoute=e.data.path;});var last=0;document.addEventListener("mousemove",function(e){var now=Date.now();if(now-last<50)return;last=now;parent.postMessage({type:"runtime:cursor",x:e.clientX,y:e.clientY,route:window.__nxRoute,t:now},"*");},true);})();</script>`;

// Opt-in preview element picker, injected into the srcdoc ONLY when bundlePreview is called
// with { picker: true }. Byte-identical (no extra markup/script) when picker is false, so the
// deployed runtime and normal preview are unchanged. Extends the EXISTING postMessage
// protocol with one iframe→parent message: runtime:element-select. No new transport.
const PICKER_HTML = `<style>.__b44_pk{position:fixed;pointer-events:none;border:1.5px solid #6366f1;background:rgba(99,102,241,.14);border-radius:3px;z-index:2147483646;display:none}</style><script>(function(){var b=document.createElement('div');b.className='__b44_pk';document.body.appendChild(b);function show(el){var r=el.getBoundingClientRect();b.style.left=r.left+'px';b.style.top=r.top+'px';b.style.width=r.width+'px';b.style.height=r.height+'px';b.style.display='block';}function onMove(e){var el=document.elementFromPoint(e.clientX,e.clientY);if(!el||el===b)return;show(el);}function onKey(e){if(e.key==='Escape'){cleanup();parent.postMessage({type:'runtime:element-select',cancelled:true},'*');}}function onClick(e){e.preventDefault();e.stopPropagation();var el=document.elementFromPoint(e.clientX,e.clientY);cleanup();if(!el||el===b||el===document.documentElement||el===document.body){parent.postMessage({type:'runtime:element-select',cancelled:true},'*');return;}var r=el.getBoundingClientRect();var __p=[],__n=el;while(__n&&__n!==document.documentElement){var __pp=__n.parentElement;if(!__pp)break;__p.unshift(Array.prototype.indexOf.call(__pp.children,__n));__n=__pp;}parent.postMessage({type:'runtime:element-select',tag:el.tagName.toLowerCase(),html:el.outerHTML.slice(0,400),text:(el.textContent||'').trim().slice(0,200),rect:{x:r.left,y:r.top,width:r.width,height:r.height},route:window.__nxRoute||'/',elementId:__p.join('/')},'*');}function cleanup(){document.removeEventListener('mousemove',onMove,true);document.removeEventListener('click',onClick,true);document.removeEventListener('keydown',onKey,true);if(b.parentNode)b.parentNode.removeChild(b);}document.addEventListener('mousemove',onMove,true);document.addEventListener('click',onClick,true);document.addEventListener('keydown',onKey,true);})();</script>`;

export function resolveRelative(from, spec) {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") dir.pop(); else dir.push(seg);
  }
  return dir.join("/");
}

export function bundlePreview(files, { csp = PREVIEW_CSP, picker = false, packages = null } = {}) {
  const byPath = new Map(files.map((f) => [f.path, f.content || ""]));
  // B5: package modules produced server-side by the one packageModules() path (preview + deploy).
  const pkgModules = new Map((packages?.modules || []).map((m) => [m.key, m]));
  const pkgImports = packages?.imports || {};
  const sources = { [RUNTIME_KEY]: runtimeSource };
  const order = [RUNTIME_KEY];
  const done = new Set([RUNTIME_KEY]);
  const visiting = new Set();

  const build = (path) => {
    if (done.has(path)) return;
    if (visiting.has(path)) throw new Error(`Circular import involving ${path}`);
    // B5: a server-normalized package module. Its import sources were rewritten by AST range to
    // exact "nx:<key>" string literals (one per entry in deps), so only those literals are swapped.
    const pkg = pkgModules.get(path);
    if (pkg) {
      visiting.add(path);
      let code = pkg.code;
      for (const dep of pkg.deps || []) {
        if (!pkgModules.has(dep)) throw new Error(`${path}: missing package module ${dep}`);
        build(dep);
        code = code.split(JSON.stringify("nx:" + dep)).join(JSON.stringify(ph(dep)));
      }
      visiting.delete(path);
      sources[path] = code;
      order.push(path);
      done.add(path);
      return;
    }
    if (!byPath.has(path)) throw new Error(`Missing file: ${path}`);
    visiting.add(path);
    const code = byPath.get(path).replace(/(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g, (m, kw, q, spec) => {
      if (spec === "runtime") return kw + q + ph(RUNTIME_KEY) + q;
      if (spec.startsWith("nx:")) throw new Error(`${path}: "${spec}" is a reserved import`);
      if (Object.prototype.hasOwnProperty.call(pkgImports, spec)) {
        const key = pkgImports[spec];
        build(key);
        return kw + q + ph(key) + q;
      }
      if (!spec.startsWith(".")) throw new Error(`${path}: unsupported import "${spec}"`);
      const dep = resolveRelative(path, spec);
      build(dep);
      return kw + q + ph(dep) + q;
    });
    visiting.delete(path);
    sources[path] = code;
    order.push(path);
    done.add(path);
  };

  const main = "src/main.js";
  build(main);

  const css = byPath.get("styles.css") || "";
  const cspMeta = csp ? `<meta http-equiv="Content-Security-Policy" content="${String(csp).replace(/"/g, "&quot;")}">` : "";
  const loader = `
const SOURCES = ${JSON.stringify(sources)};
const ORDER = ${JSON.stringify(order)};
const MAIN = ${JSON.stringify(main)};
const urls = Object.create(null);
try {
  for (const key of ORDER) {
    const code = SOURCES[key].replace(/%%MOD:([^%]*)%%/g, (m, dep) => urls[dep] || m);
    urls[key] = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  }
  import(urls[MAIN]).then(() => scheduleMountCheck()).catch((e) => { window.__nxErrored = true; parent.postMessage({ type: "runtime:error", message: String(e && e.message || e) }, "*"); });
} catch (e) {
  window.__nxErrored = true;
  parent.postMessage({ type: "runtime:error", message: String(e && e.message || e) }, "*");
}
window.addEventListener("error", (e) => { window.__nxErrored = true; parent.postMessage({ type: "runtime:error", message: String(e.message || e) }, "*"); });
window.addEventListener("unhandledrejection", (e) => { window.__nxErrored = true; parent.postMessage({ type: "runtime:error", message: String((e.reason && e.reason.message) || e.reason) }, "*"); });
// Diagnostic only: a bounded visible-content check under #app (the picker overlay lives on <body>).
function mountCheck() {
  const root = document.getElementById("app");
  const els = root ? root.querySelectorAll("*") : [];
  const limit = Math.min(els.length, 2000);
  let visible = 0, text = 0, media = 0;
  for (let i = 0; i < limit; i++) {
    const el = els[i], r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const isMedia = /^(IMG|SVG|CANVAS|VIDEO|INPUT|BUTTON|TEXTAREA|SELECT|IFRAME)$/i.test(el.tagName);
    const ownText = Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
    if (isMedia) media++;
    if (ownText) text++;
    if (isMedia || ownText) visible++;
  }
  return { visible: visible > 0, nodes: els.length, scanned: limit, visible_nodes: visible, text_nodes: text, media_nodes: media };
}
function scheduleMountCheck() {
  const send = (phase) => {
    if (window.__nxErrored) return true;
    const c = mountCheck();
    if (c.visible || phase === "deadline") { parent.postMessage({ type: "runtime:mounted", phase, route: window.__nxRoute || "/", ...c }, "*"); return true; }
    return false;
  };
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!send("frame")) setTimeout(() => send("deadline"), 3000); }));
}
`;
  return `<!doctype html><html><head>${cspMeta}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><script src="https://cdn.tailwindcss.com"></script><style>${css}</style></head><body><div id="app"></div><script type="module">${loader}</script>${COLLAB_HTML}${picker ? PICKER_HTML : ""}</body></html>`;
}
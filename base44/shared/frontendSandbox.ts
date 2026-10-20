// Executes a generated app's FRONTEND module graph inside the existing closed sandbox.
//
// Why this exists: until now the builder could only prove that generated code PARSES and
// LINKS (buildEngine). This module actually runs it: it links the module graph, mounts the
// app, invokes components and effects, and reports what threw. It is a verification harness,
// not a second runtime — the browser still renders the real app.
//
// SECURITY: execution goes through jsInterp, so the same closed sandbox applies — no fetch,
// no Deno, no globalThis, no dynamic evaluation, no platform SDK. The 'runtime' module the
// generated code imports is replaced by INERT STUBS here: db/server/auth/files calls are
// recorded and answered with empty values, so verifying an app can neither read nor write
// real data nor reach the network. Quotas bound time and work.
import { createInterpreter, parseModule } from "./jsInterp.ts";
import { resolveRelative } from "./buildEngine.ts";

const MAX_COMPONENT_CALLS = 80;
const MAX_DEPTH = 4;
const MAX_EFFECTS = 30;

// Inert stand-ins for the real 'runtime' exports. Every I/O primitive resolves to an empty,
// well-typed value so a component's happy path executes without touching anything real.
export function createStubRuntime(state, entities) {
  const record = (kind, detail) => state.calls.push({ kind, detail });

  const h = (type, props, ...children) => ({ __vnode: true, type, props: props || {}, children: children.flat() });

  // htm-style tagged template. Component functions appear as interpolated values; invoking
  // them (bounded) is what makes this a real smoke test instead of a parse check.
  const html = async (strings, ...values) => {
    const children = [];
    const fns = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      // Only call functions in the component-type position (<${Component}), never event
      // handlers or other prop callbacks. In preact-htm a component type always follows '<'
      // in the markup; an event handler like onInput=${(e) => setX(e.target.value)} follows
      // 'onInput='. Calling the handler with {} throws because e.target is undefined, which
      // produces a false STARTUP_ERROR that masks real defects and rolls back correct code.
      const isComponent = strings[i].endsWith("<");
      if (isComponent && typeof v === "function" && state.componentCalls < MAX_COMPONENT_CALLS && state.depth < MAX_DEPTH) {
        fns.push(v);
        state.componentCalls++;
        state.depth++;
        try { children.push(await v({})); } finally { state.depth--; }
      } else children.push(v);
    }
    return { __vnode: true, type: "fragment", props: {}, children, fns, markup: strings.join("${}") };
  };

  const entityStub = (name) => ({
    list: async () => [], filter: async () => [], count: async () => 0,
    get: async () => { throw new Error(`verification stub: ${name} record not found`); },
    create: async (data) => ({ id: "verify-stub", ...(data || {}) }),
    update: async (id, data) => ({ id, ...(data || {}) }),
    delete: async () => true,
    bulkCreate: async (rows) => (rows || []).map((r, i) => ({ id: `verify-stub-${i}`, ...r })),
  });
  const db = {};
  for (const e of entities || []) db[e.name] = entityStub(e.name);

  const serverStub = new Proxy({}, {
    get: (_t, name) => async (payload) => { record("server", String(name)); return { ok: true, stub: true, payload: payload ?? null }; },
  });

  return {
    default: undefined,
    named: {
      h, html,
      render: (component, mount) => {
        // In preact-htm, render(html`<${App} />`, mount) passes a vnode produced by the html
        // tagged template. The html stub eagerly calls App({}) for smoke testing but also
        // records the original function in fns; extract it so the verifier can call root({}).
        let root = component;
        if (root && root.__vnode && Array.isArray(root.fns) && typeof root.fns[0] === "function") root = root.fns[0];
        state.mounted.push({ component: root, mount: mount ?? null });
        return component;
      },
      useState: (initial) => [initial, (next) => { record("setState", typeof next); }],
      useEffect: async (fn) => {
        if (state.effects >= MAX_EFFECTS) return;
        state.effects++;
        await fn();
      },
      useMemo: async (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (initial) => ({ current: initial ?? null }),
      useReducer: (reducer, initial) => [initial, (action) => { record("dispatch", JSON.stringify(action ?? null).slice(0, 80)); }],
      db,
      auth: { me: async () => null, login: async () => null, signup: async () => null, logout: async () => true },
      files: { upload: async () => ({ id: "verify-stub" }), list: async () => [], access: async () => ({ url: "" }), delete: async () => true },
      server: serverStub,
      navigate: (path) => { record("navigate", String(path)); state.navigations.push(String(path)); },
      useRoute: () => ({ path: state.path, params: state.params || {} }),
      Link: (props) => h("a", { href: (props || {}).to || "#" }, (props || {}).children),
    },
  };
}

// Links and executes the frontend module graph starting at `entry`, returning the mounted
// root component. Import specifiers are resolved against the project's own files only:
// 'runtime' hits the stubs above and anything else is refused, so no host module is reachable.
// Minimal browser-global stubs so the entry file (which calls document.getElementById('app'))
// and any component effect that touches the DOM execute without hitting an undefined global.
const documentStub = {
  getElementById: () => ({ id: "app", children: [], appendChild() {}, removeChild() {}, setAttribute() {}, style: {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ tagName: "div", children: [], appendChild() {}, setAttribute() {}, style: {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild() {}, removeChild() {} },
  documentElement: { style: {} },
};

export async function mountFrontend(files, entry, state, entities, { maxSteps, timeoutMs }) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const cache = new Map();
  const loading = new Set();
  const runtimeNs = createStubRuntime(state, entities);

  const interp = createInterpreter({
    maxSteps, timeoutMs,
    resolveModule: async (spec) => load(spec, state.currentPath),
    globals: { document: documentStub },
  });

  async function load(spec, from) {
    if (spec === "runtime") return runtimeNs;
    if (!String(spec).startsWith(".")) throw new Error(`import of '${spec}' is not allowed in a generated app`);
    const path = resolveRelative(from, spec);
    if (cache.has(path)) return cache.get(path);
    if (loading.has(path)) throw new Error(`circular import at ${path}`);
    if (!byPath.has(path)) throw new Error(`cannot resolve import '${spec}' from ${from} (looked for ${path})`);
    loading.add(path);
    const prev = state.currentPath;
    state.currentPath = path;
    try {
      const ns = await interp.runModule(parseModule(byPath.get(path)));
      cache.set(path, ns);
      return ns;
    } finally {
      state.currentPath = prev;
      loading.delete(path);
    }
  }

  state.currentPath = entry;
  if (!byPath.has(entry)) throw new Error(`entry file ${entry} is missing`);
  await interp.runModule(parseModule(byPath.get(entry)));
  return { mounted: state.mounted, steps: interp.stats().steps };
}
// Server-side interpreter for generated backend-function code.
//
// The platform forbids dynamic code evaluation (no eval / new Function / runtime WASM),
// so generated function source is PARSED with acorn and executed by walking the AST.
// Consequences, all deliberate:
//   - the sandbox is closed by construction: the only reachable bindings are the
//     whitelisted globals below plus the host context passed to the handler. There is
//     no way to reach fetch, Deno, globalThis, import or the platform SDK from generated code.
//   - the supported syntax is a subset (see SUPPORTED_NODES). The build engine statically
//     rejects anything outside it, so unsupported syntax is a build error, never a runtime surprise.
import * as acorn from "npm:acorn@8.12.1";

export const SUPPORTED_NODES = new Set([
  "Program", "ExportDefaultDeclaration", "ExportNamedDeclaration",
  "VariableDeclaration", "VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "BlockStatement", "ExpressionStatement", "ReturnStatement", "IfStatement", "ForStatement", "ForOfStatement",
  "ForInStatement", "WhileStatement", "DoWhileStatement", "BreakStatement", "ContinueStatement", "EmptyStatement",
  "TryStatement", "CatchClause", "ThrowStatement", "SwitchStatement", "SwitchCase", "LabeledStatement",
  "Identifier", "Literal", "TemplateLiteral", "TemplateElement", "ObjectExpression", "Property", "ArrayExpression",
  "MemberExpression", "CallExpression", "NewExpression", "SpreadElement", "RestElement",
  "BinaryExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression", "ConditionalExpression",
  "AssignmentExpression", "AwaitExpression", "SequenceExpression", "ChainExpression",
  "ObjectPattern", "ArrayPattern", "AssignmentPattern",
]);

export function parseModule(source) {
  return acorn.parse(source, { ecmaVersion: 2022, sourceType: "module" });
}

// Static syntax gate used by the build engine.
export function findUnsupported(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) findUnsupported(n, out); return out; }
  if (typeof node.type === "string" && !SUPPORTED_NODES.has(node.type)) {
    out.push({ type: node.type, line: node.loc?.start?.line });
    return out;
  }
  for (const [k, v] of Object.entries(node)) { if (k !== "loc" && k !== "range") findUnsupported(v, out); }
  return out;
}

// Resource-quota termination. Deliberately NOT a Thrown value: generated code cannot
// observe or catch it (see TryStatement), so a function can never burn its whole budget
// inside a try block and then report success.
export class QuotaExceeded extends Error {
  constructor(quota, message) { super(message); this.name = "QuotaExceeded"; this.quota = quota; }
}

class Signal { constructor(type, value) { this.type = type; this.value = value; } }
class Thrown extends Error {
  constructor(value) { super(typeof value?.message === "string" ? value.message : String(value)); this.value = value; }
}

class Scope {
  constructor(parent) { this.v = new Map(); this.parent = parent; }
  get(n) {
    if (this.v.has(n)) return this.v.get(n);
    if (this.parent) return this.parent.get(n);
    throw new Thrown(new ReferenceError(`${n} is not defined`));
  }
  has(n) { return this.v.has(n) || (this.parent ? this.parent.has(n) : false); }
  set(n, val) {
    if (this.v.has(n)) { this.v.set(n, val); return val; }
    if (this.parent) return this.parent.set(n, val);
    throw new Thrown(new ReferenceError(`${n} is not defined`));
  }
  declare(n, val) { this.v.set(n, val); return val; }
}

// Whitelisted globals. Everything here is a pure value/formatting primitive: nothing can
// reach the network, the filesystem, the host process or dynamic code evaluation. I/O stays
// exclusively on the handler context (db, files, http, secrets, email, push), so adding
// these does not widen the sandbox boundary.
const BASE_GLOBALS = {
  JSON, Math, Object, Array, String, Number, Boolean, Date, Promise, RegExp, Map, Set, WeakMap,
  Error, TypeError, RangeError, SyntaxError, URLSearchParams, URL, Intl,
  isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  encodeURI, decodeURI, atob, btoa, structuredClone,
  // Narrowed crypto: id/randomness generation only. subtle, and everything else on the
  // host crypto object, is deliberately unreachable.
  crypto: {
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (arr) => crypto.getRandomValues(arr),
  },
  undefined: undefined, NaN, Infinity,
};

const INTERP = Symbol("interpreted");
const HOF = new Set(["map", "filter", "forEach", "find", "findIndex", "some", "every", "flatMap", "reduce", "sort"]);

// Array higher-order methods must await interpreted callbacks, which are async by nature.
async function callHof(receiver, name, fn, extra) {
  const out = [];
  if (name === "reduce") {
    let acc = extra.length ? extra[0] : receiver[0];
    for (let i = extra.length ? 0 : 1; i < receiver.length; i++) acc = await fn(acc, receiver[i], i, receiver);
    return acc;
  }
  if (name === "sort") {
    const items = [...receiver];
    // insertion sort: the comparator is async, so Array#sort cannot be used
    for (let i = 1; i < items.length; i++) {
      const cur = items[i];
      let j = i - 1;
      while (j >= 0 && (await fn(items[j], cur)) > 0) { items[j + 1] = items[j]; j--; }
      items[j + 1] = cur;
    }
    receiver.length = 0; receiver.push(...items);
    return receiver;
  }
  for (let i = 0; i < receiver.length; i++) {
    const res = await fn(receiver[i], i, receiver);
    if (name === "map") out.push(res);
    else if (name === "flatMap") Array.isArray(res) ? out.push(...res) : out.push(res);
    else if (name === "filter") { if (res) out.push(receiver[i]); }
    else if (name === "find") { if (res) return receiver[i]; }
    else if (name === "findIndex") { if (res) return i; }
    else if (name === "some") { if (res) return true; }
    else if (name === "every") { if (!res) return false; }
  }
  if (name === "find") return undefined;
  if (name === "findIndex") return -1;
  if (name === "some") return false;
  if (name === "every") return true;
  return out;
}

// `resolveModule` is OPTIONAL and off by default: backend functions still cannot import
// anything. It exists so the runtime verifier can link a generated FRONTEND module graph
// (which does import relative files and the 'runtime' module) inside this same sandbox,
// instead of introducing a second, weaker execution path.
export function createInterpreter({ globals = {}, maxSteps = 200000, timeoutMs = 20000, resolveModule = null } = {}) {
  const ctx = { steps: 0, maxSteps, deadline: Date.now() + timeoutMs };
  const root = new Scope(null);
  for (const [k, v] of Object.entries({ ...BASE_GLOBALS, ...globals })) root.declare(k, v);

  const tick = () => {
    if (++ctx.steps > ctx.maxSteps) throw new QuotaExceeded("steps", `execution aborted: step limit (${ctx.maxSteps}) exceeded — possible infinite loop`);
    if (Date.now() > ctx.deadline) throw new QuotaExceeded("timeout", "execution aborted: time limit exceeded");
  };

  function makeFunction(node, defScope) {
    const fn = async (...args) => {
      const scope = new Scope(defScope);
      for (let i = 0; i < node.params.length; i++) {
        const p = node.params[i];
        if (p.type === "RestElement") await bindPattern(p.argument, args.slice(i), scope);
        else await bindPattern(p, args[i], scope);
      }
      if (node.body.type !== "BlockStatement") return evalNode(node.body, scope);
      const res = await execBlock(node.body.body, new Scope(scope));
      return res instanceof Signal && res.type === "return" ? res.value : undefined;
    };
    fn[INTERP] = true;
    return fn;
  }

  async function bindPattern(pattern, value, scope, assign = false) {
    const put = (name, val) => (assign ? scope.set(name, val) : scope.declare(name, val));
    switch (pattern.type) {
      case "Identifier": return put(pattern.name, value);
      case "AssignmentPattern":
        return bindPattern(pattern.left, value === undefined ? await evalNode(pattern.right, scope) : value, scope, assign);
      case "ObjectPattern": {
        const taken = [];
        for (const p of pattern.properties) {
          if (p.type === "RestElement") {
            const rest = {};
            for (const [k, v] of Object.entries(value || {})) if (!taken.includes(k)) rest[k] = v;
            await bindPattern(p.argument, rest, scope, assign);
            continue;
          }
          const key = p.computed ? await evalNode(p.key, scope) : (p.key.name ?? p.key.value);
          taken.push(key);
          await bindPattern(p.value, (value ?? {})[key], scope, assign);
        }
        return;
      }
      case "ArrayPattern": {
        const arr = value ?? [];
        for (let i = 0; i < pattern.elements.length; i++) {
          const el = pattern.elements[i];
          if (!el) continue;
          if (el.type === "RestElement") await bindPattern(el.argument, Array.from(arr).slice(i), scope, assign);
          else await bindPattern(el, Array.from(arr)[i], scope, assign);
        }
        return;
      }
      case "MemberExpression": {
        const obj = await evalNode(pattern.object, scope);
        const key = pattern.computed ? await evalNode(pattern.property, scope) : pattern.property.name;
        obj[key] = value;
        return;
      }
      default: throw new Error(`unsupported binding pattern: ${pattern.type}`);
    }
  }

  async function execBlock(body, scope) {
    for (const node of body) if (node.type === "FunctionDeclaration") scope.declare(node.id.name, makeFunction(node, scope));
    for (const node of body) {
      const res = await evalNode(node, scope);
      if (res instanceof Signal) return res;
    }
  }

  async function evalArgs(nodes, scope) {
    const out = [];
    for (const a of nodes) {
      if (a.type === "SpreadElement") out.push(...(await evalNode(a.argument, scope)));
      else out.push(await evalNode(a, scope));
    }
    return out;
  }

  async function evalNode(node, scope) {
    tick();
    switch (node.type) {
      case "Program": return execBlock(node.body, scope);
      case "EmptyStatement": return undefined;
      case "ExpressionStatement": return void (await evalNode(node.expression, scope));
      case "BlockStatement": return execBlock(node.body, new Scope(scope));
      case "VariableDeclaration": {
        for (const d of node.declarations) await bindPattern(d.id, d.init ? await evalNode(d.init, scope) : undefined, scope);
        return undefined;
      }
      case "FunctionDeclaration": return void scope.declare(node.id.name, makeFunction(node, scope));
      case "FunctionExpression":
      case "ArrowFunctionExpression": return makeFunction(node, scope);
      case "ReturnStatement": return new Signal("return", node.argument ? await evalNode(node.argument, scope) : undefined);
      case "BreakStatement": return new Signal("break");
      case "ContinueStatement": return new Signal("continue");
      case "ThrowStatement": throw new Thrown(await evalNode(node.argument, scope));
      case "LabeledStatement": return evalNode(node.body, scope);
      case "IfStatement":
        if (await evalNode(node.test, scope)) return evalNode(node.consequent, scope);
        return node.alternate ? evalNode(node.alternate, scope) : undefined;
      case "WhileStatement":
      case "DoWhileStatement": {
        if (node.type === "DoWhileStatement") {
          do { const r = await evalNode(node.body, scope); if (r instanceof Signal) { if (r.type === "break") break; if (r.type === "return") return r; } tick(); }
          while (await evalNode(node.test, scope));
          return undefined;
        }
        while (await evalNode(node.test, scope)) {
          const r = await evalNode(node.body, scope);
          if (r instanceof Signal) { if (r.type === "break") break; if (r.type === "return") return r; }
          tick();
        }
        return undefined;
      }
      case "ForStatement": {
        const s = new Scope(scope);
        if (node.init) await evalNode(node.init, s);
        while (node.test ? await evalNode(node.test, s) : true) {
          const r = await evalNode(node.body, new Scope(s));
          if (r instanceof Signal) { if (r.type === "break") break; if (r.type === "return") return r; }
          if (node.update) await evalNode(node.update, s);
          tick();
        }
        return undefined;
      }
      case "ForOfStatement":
      case "ForInStatement": {
        const iterable = await evalNode(node.right, scope);
        const items = node.type === "ForInStatement" ? Object.keys(iterable || {}) : (iterable ?? []);
        for (const item of items) {
          const s = new Scope(scope);
          if (node.left.type === "VariableDeclaration") await bindPattern(node.left.declarations[0].id, item, s);
          else await bindPattern(node.left, item, s, true);
          const r = await evalNode(node.body, s);
          if (r instanceof Signal) { if (r.type === "break") break; if (r.type === "return") return r; }
          tick();
        }
        return undefined;
      }
      case "SwitchStatement": {
        const disc = await evalNode(node.discriminant, scope);
        const s = new Scope(scope);
        let matched = false;
        for (const c of node.cases) {
          if (!matched && c.test && (await evalNode(c.test, s)) !== disc) continue;
          if (!matched && !c.test && node.cases.some((x) => x.test)) { /* default runs only if nothing matched */ }
          matched = true;
          const r = await execBlock(c.consequent, s);
          if (r instanceof Signal) { if (r.type === "break") return undefined; return r; }
        }
        return undefined;
      }
      case "TryStatement": {
        let result;
        try {
          result = await evalNode(node.block, scope);
        } catch (e) {
          // A quota termination is fatal and uncatchable: it bypasses the handler (and the
          // finalizer, which would itself be running on an exhausted budget) and unwinds.
          if (e instanceof QuotaExceeded) throw e;
          if (!node.handler) { if (node.finalizer) await evalNode(node.finalizer, scope); throw e; }
          const s = new Scope(scope);
          const bound = e instanceof Thrown ? e.value : e;
          if (node.handler.param) await bindPattern(node.handler.param, bound, s);
          try { result = await execBlock(node.handler.body.body, s); }
          finally { if (node.finalizer) await evalNode(node.finalizer, scope); }
          return result;
        }
        if (node.finalizer) { const f = await evalNode(node.finalizer, scope); if (f instanceof Signal) return f; }
        return result;
      }
      case "Literal": return node.value;
      case "Identifier": return node.name === "undefined" ? undefined : scope.get(node.name);
      case "TemplateLiteral": {
        let out = "";
        for (let i = 0; i < node.quasis.length; i++) {
          out += node.quasis[i].value.cooked;
          if (i < node.expressions.length) out += String(await evalNode(node.expressions[i], scope));
        }
        return out;
      }
      case "ArrayExpression": {
        const out = [];
        for (const el of node.elements) {
          if (!el) out.push(undefined);
          else if (el.type === "SpreadElement") out.push(...(await evalNode(el.argument, scope)));
          else out.push(await evalNode(el, scope));
        }
        return out;
      }
      case "ObjectExpression": {
        const obj = {};
        for (const p of node.properties) {
          if (p.type === "SpreadElement") { Object.assign(obj, await evalNode(p.argument, scope)); continue; }
          const key = p.computed ? await evalNode(p.key, scope) : (p.key.name ?? p.key.value);
          obj[key] = await evalNode(p.value, scope);
        }
        return obj;
      }
      case "ChainExpression": return evalNode(node.expression, scope);
      // Tagged templates (html`...`) are deliberately NOT in SUPPORTED_NODES, so backend
      // functions still cannot use them; the frontend verifier needs them to evaluate
      // generated view code.
      case "TaggedTemplateExpression": {
        const tag = await evalNode(node.tag, scope);
        if (typeof tag !== "function") throw new Thrown(new TypeError("template tag is not a function"));
        const strings = node.quasi.quasis.map((q) => q.value.cooked);
        strings.raw = node.quasi.quasis.map((q) => q.value.raw);
        const values = [];
        for (const e of node.quasi.expressions) values.push(await evalNode(e, scope));
        return tag(strings, ...values);
      }
      case "MemberExpression": {
        const obj = await evalNode(node.object, scope);
        if (obj == null) {
          if (node.optional) return undefined;
          throw new Thrown(new TypeError(`Cannot read properties of ${obj} (reading '${node.property.name || ""}')`));
        }
        const key = node.computed ? await evalNode(node.property, scope) : node.property.name;
        if (key === "constructor" || key === "__proto__" || key === "prototype") throw new Error(`access to '${key}' is not allowed`);
        const val = obj[key];
        return typeof val === "function" ? val.bind(obj) : val;
      }
      case "CallExpression": {
        const args = await evalArgs(node.arguments, scope);
        if (node.callee.type === "MemberExpression") {
          const recv = await evalNode(node.callee.object, scope);
          if (recv == null) {
            if (node.callee.optional || node.optional) return undefined;
            throw new Thrown(new TypeError(`Cannot read properties of ${recv}`));
          }
          const key = node.callee.computed ? await evalNode(node.callee.property, scope) : node.callee.property.name;
          if (key === "constructor" || key === "__proto__" || key === "prototype") throw new Error(`access to '${key}' is not allowed`);
          const fn = recv[key];
          if (typeof fn !== "function") {
            if (node.optional && fn == null) return undefined;
            throw new Thrown(new TypeError(`${key} is not a function`));
          }
          if (Array.isArray(recv) && HOF.has(key) && typeof args[0] === "function" && args[0][INTERP]) {
            return callHof(recv, key, args[0], args.slice(1));
          }
          return fn.apply(recv, args);
        }
        const fn = await evalNode(node.callee, scope);
        if (typeof fn !== "function") {
          if (node.optional && fn == null) return undefined;
          throw new Thrown(new TypeError("attempted to call a non-function"));
        }
        return fn(...args);
      }
      case "NewExpression": {
        const Ctor = await evalNode(node.callee, scope);
        if (typeof Ctor !== "function") throw new Thrown(new TypeError("not a constructor"));
        return new Ctor(...(await evalArgs(node.arguments, scope)));
      }
      case "AwaitExpression": return await evalNode(node.argument, scope);
      case "UnaryExpression": {
        if (node.operator === "typeof" && node.argument.type === "Identifier" && !scope.has(node.argument.name)) return "undefined";
        const v = await evalNode(node.argument, scope);
        switch (node.operator) {
          case "!": return !v;
          case "-": return -v;
          case "+": return +v;
          case "typeof": return typeof v;
          case "void": return undefined;
          default: throw new Error(`unsupported unary operator ${node.operator}`);
        }
      }
      case "UpdateExpression": {
        const old = Number(await evalNode(node.argument, scope));
        const next = node.operator === "++" ? old + 1 : old - 1;
        await bindPattern(node.argument, next, scope, true);
        return node.prefix ? next : old;
      }
      case "BinaryExpression": {
        const l = await evalNode(node.left, scope);
        const r = await evalNode(node.right, scope);
        switch (node.operator) {
          case "+": return l + r; case "-": return l - r; case "*": return l * r; case "/": return l / r;
          case "%": return l % r; case "**": return l ** r;
          case "==": return l == r; case "!=": return l != r; case "===": return l === r; case "!==": return l !== r;
          case "<": return l < r; case "<=": return l <= r; case ">": return l > r; case ">=": return l >= r;
          case "in": return key_in(l, r); case "instanceof": return l instanceof r;
          case "&": return l & r; case "|": return l | r; case "^": return l ^ r;
          case "<<": return l << r; case ">>": return l >> r; case ">>>": return l >>> r;
          default: throw new Error(`unsupported operator ${node.operator}`);
        }
      }
      case "LogicalExpression": {
        const l = await evalNode(node.left, scope);
        if (node.operator === "&&") return l ? evalNode(node.right, scope) : l;
        if (node.operator === "||") return l ? l : evalNode(node.right, scope);
        return l == null ? evalNode(node.right, scope) : l;
      }
      case "ConditionalExpression":
        return (await evalNode(node.test, scope)) ? evalNode(node.consequent, scope) : evalNode(node.alternate, scope);
      case "AssignmentExpression": {
        if (node.operator === "=") {
          const value = await evalNode(node.right, scope);
          await bindPattern(node.left, value, scope, true);
          return value;
        }
        const cur = await evalNode(node.left, scope);
        const rhs = await evalNode(node.right, scope);
        const op = node.operator.slice(0, -1);
        const value =
          op === "+" ? cur + rhs : op === "-" ? cur - rhs : op === "*" ? cur * rhs : op === "/" ? cur / rhs :
          op === "%" ? cur % rhs : op === "||" ? (cur || rhs) : op === "&&" ? (cur && rhs) : op === "??" ? (cur ?? rhs) :
          (() => { throw new Error(`unsupported assignment operator ${node.operator}`); })();
        await bindPattern(node.left, value, scope, true);
        return value;
      }
      case "SequenceExpression": {
        let last;
        for (const e of node.expressions) last = await evalNode(e, scope);
        return last;
      }
      default: throw new Error(`unsupported syntax: ${node.type}`);
    }
  }

  const key_in = (k, o) => k in (o || {});

  // Executes a module body and returns its exports. Imports are rejected: backend functions
  // receive everything they need through the handler context.
  async function runModule(ast) {
    const scope = new Scope(root);
    const exports = { default: undefined, named: {} };
    // Imports are hoisted: bind every imported binding before the module body executes.
    if (resolveModule) {
      for (const node of ast.body) {
        if (node.type !== "ImportDeclaration") continue;
        const ns = await resolveModule(node.source.value);
        for (const s of node.specifiers || []) {
          if (s.type === "ImportDefaultSpecifier") scope.declare(s.local.name, ns.default);
          else if (s.type === "ImportNamespaceSpecifier") scope.declare(s.local.name, { ...ns.named, default: ns.default });
          else {
            const name = s.imported.name ?? s.imported.value;
            if (!(name in ns.named)) throw new Thrown(new Error(`'${node.source.value}' does not export '${name}'`));
            scope.declare(s.local.name, ns.named[name]);
          }
        }
      }
    }
    for (const node of ast.body) if (node.type === "FunctionDeclaration") scope.declare(node.id.name, makeFunction(node, scope));
    for (const node of ast.body) {
      if (node.type === "ImportDeclaration") {
        if (resolveModule) continue;
        throw new Error("backend functions cannot import modules — use the handler context (db, secrets, http, log)");
      }
      if (node.type === "ExportDefaultDeclaration") {
        const d = node.declaration;
        exports.default = d.type === "FunctionDeclaration" ? makeFunction(d, scope) : await evalNode(d, scope);
        if (d.type === "FunctionDeclaration" && d.id) scope.declare(d.id.name, exports.default);
        continue;
      }
      if (node.type === "ExportNamedDeclaration") {
        if (node.declaration) {
          await evalNode(node.declaration, scope);
          const d = node.declaration;
          if (d.type === "VariableDeclaration") for (const dec of d.declarations) exports.named[dec.id.name] = scope.get(dec.id.name);
          else if (d.id) exports.named[d.id.name] = scope.get(d.id.name);
        }
        for (const s of node.specifiers || []) exports.named[s.exported.name] = scope.get(s.local.name);
        continue;
      }
      const r = await evalNode(node, scope);
      if (r instanceof Signal) break;
    }
    return exports;
  }

  return { runModule, stats: () => ({ steps: ctx.steps }) };
}
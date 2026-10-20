// Test-only: wraps an SDK client so ONE entity operation throws, on both the user client and
// asServiceRole. Every other call passes through to the real data layer unchanged.
export function withFailingOp(client, entity, op) {
  const wrapEntities = (ents) => new Proxy(ents, {
    get(t, k) {
      const e = t[k];
      if (k !== entity) return e;
      return new Proxy(e, {
        get(t2, k2) {
          if (k2 === op) return async () => { throw new Error(`injected ${entity}.${op} failure`); };
          const v = t2[k2];
          return typeof v === "function" ? v.bind(t2) : v;
        },
      });
    },
  });
  return new Proxy(client, {
    get(t, k) {
      if (k === "entities") return wrapEntities(t.entities);
      if (k === "asServiceRole") return t.asServiceRole ? withFailingOp(t.asServiceRole, entity, op) : t.asServiceRole;
      return t[k];
    },
  });
}

export async function captureError(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
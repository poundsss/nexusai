// In-memory entity store for certification suites (no database). Supports equality filters,
// optional sort ("-field") and limit, so it is a drop-in for the service-role entity API.
export function memStore(seed = {}) {
  const tables = {};
  let n = 0;
  const table = (name) => (tables[name] ||= (seed[name] || []).map((r) => ({ ...r })));
  const match = (r, q) => Object.entries(q || {}).every(([k, v]) =>
    (v && typeof v === "object" && "$ne" in v) ? r[k] !== v.$ne : r[k] === v);
  const sortBy = (rows, s) => {
    if (typeof s !== "string") return rows;
    const desc = s.startsWith("-"), k = s.replace(/^[-+]/, "");
    return [...rows].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (desc ? -1 : 1));
  };
  const api = (name) => ({
    filter: async (q, s, lim) => {
      const o = (s && typeof s === "object") ? s : {};
      const sort = o.sort !== undefined ? o.sort : s, limit = o.limit !== undefined ? o.limit : lim;
      const rows = sortBy(table(name).filter((r) => match(r, q)), sort)
        .slice(0, typeof limit === "number" ? limit : undefined)
        .map((r) => {
          const c = { ...r };
          if (Array.isArray(o.fields)) { const out = { id: r.id }; for (const f of o.fields) if (f in c) out[f] = c[f]; return out; }
          return c;
        });
      // Like the real API, an options-object call returns a PAGE object; a positional
      // call (sort, limit) still returns a plain array.
      return (s && typeof s === "object") ? { items: rows, next_cursor: null, has_more: false } : rows;
    },
    list: async () => table(name).map((r) => ({ ...r })),
    get: async (id) => { const r = table(name).find((x) => x.id === id); if (!r) throw new Error("not found"); return { ...r }; },
    create: async (d) => { const r = { id: `${name}_${++n}`, created_date: new Date(Date.now() + n).toISOString(), ...d }; table(name).push(r); return { ...r }; },
    update: async (id, d) => { const r = table(name).find((x) => x.id === id); if (!r) throw new Error("not found"); Object.assign(r, d); return { ...r }; },
    delete: async (id) => { const t = table(name); const i = t.findIndex((x) => x.id === id); if (i >= 0) t.splice(i, 1); },
    deleteMany: async (q) => { const t = table(name); const keep = t.filter((r) => !match(r, q)); const n = t.length - keep.length; tables[name] = keep; return { deleted: n }; },
  });
  const entities = new Proxy({}, { get: (_t, k) => api(String(k)) });
  return { svc: { entities }, tables: (k) => table(k), t: (k) => table(k) };
}
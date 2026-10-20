// R-7 Phase 2 certification: field-level WRITE enforcement, zero writes on rule denial.
// In-memory storage stub — no real data is read or written.
import { createServerDb } from "../../shared/appData.ts";

const P = "proj_flsP2";
let rows = [];
let writes = 0; // mutations of Emp rows (create/update of entity_name Emp)
const seed = () => {
  writes = 0;
  rows = [
    { id: "r1", project_id: P, entity_name: "Emp", owner_id: "u1", created_date: "2026-01-01T00:00:00Z", updated_date: "2026-01-01T00:00:00Z", data: { title: "A", salary: 100, public: true, notes: "n1" } },
    { id: "r2", project_id: P, entity_name: "Emp", owner_id: "u1", created_date: "2026-01-02T00:00:00Z", updated_date: "2026-01-02T00:00:00Z", data: { title: "B", salary: 200, public: false, notes: "n2" } },
  ];
};
let seq = 0;
const match = (r, q) => Object.entries(q || {}).every(([k, v]) => k.startsWith("data.") ? (r.data || {})[k.slice(5)] === v : (typeof v === "object" && v !== null ? true : r[k] === v));
const AppRecord = {
  filter: async (q, _s, limit = 50, skip = 0) => rows.filter((r) => match(r, q)).slice(skip, skip + limit),
  get: async (id) => rows.find((r) => r.id === id) || null,
  create: async (rec) => {
    const row = { id: `n${++seq}`, created_date: new Date().toISOString(), updated_date: new Date().toISOString(), ...rec };
    if (rec.entity_name === "Emp") { writes++; rows.push(row); }
    return row;
  },
  update: async (id, doc) => {
    const r = rows.find((x) => x.id === id);
    if (r && r.entity_name === "Emp") { writes++; Object.assign(r, doc, { updated_date: new Date().toISOString() }); }
    return r || { id, ...doc };
  },
  delete: async (id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) { writes++; rows.splice(i, 1); } },
};
const generic = { filter: async () => [], get: async () => null, create: async (x) => ({ id: "g", ...x }), update: async () => ({}), delete: async () => {}, deleteMany: async () => {} };
const store = { entities: new Proxy({ AppRecord }, { get: (t, k) => t[k] || generic }) };
store.asServiceRole = store;

const ADMIN = { id: "u1", email: "a@x.io", role: "admin" };
const USER = { id: "u2", email: "u@x.io", role: "user" };
const empDef = (extra = {}) => ({
  name: "Emp",
  fields: {
    title: { type: "string", required: true },
    public: { type: "boolean", required: false },
    salary: { type: "number", required: false, default: 0, rls: { create: { user_condition: { role: "admin" } }, update: { user_condition: { role: "admin" } } } },
    notes: { type: "string", required: false, rls: { write: { "data.public": true } } },
  },
  ...extra,
});
const db = (user, fieldRules = true, def = empDef()) => createServerDb(store, P, [def], { rls: false, user, fieldRules });

export default async function () {
  try { return await run(); } catch (e) { return Response.json({ ok: false, crash: `${e?.code || ""} ${e?.message}`, stack: String(e?.stack || "").slice(0, 600) }); }
}

async function run() {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 300) });
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const denied = (e, field, index) => e && e.code === "DATABASE_FIELD_NOT_WRITABLE" && e.status === 403 && e.details?.field === field
    && (index === undefined || e.details?.index === index) && !/100|200|999/.test(e.message);
  const snap = () => JSON.stringify(rows);

  // 1. create
  seed(); check("1a. admin create with salary", (await db(ADMIN).Emp.create({ title: "C", salary: 5 })).salary === 5 && writes === 1);
  for (const [who, u] of [["user", USER], ["anon", null]]) {
    seed(); const s = snap();
    const e = await err(() => db(u).Emp.create({ title: "C", salary: 999 }));
    check(`1b. ${who} create with salary denied, 0 writes`, denied(e, "salary") && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  }
  seed(); const omitted = await db(USER).Emp.create({ title: "C" }).catch((e) => e);
  check("1c. user create omitting salary passes (default applied)", omitted && !omitted.code && writes === 1, JSON.stringify(omitted));

  // 2. update
  seed(); let s = snap();
  let e = await err(() => db(USER).Emp.update("r1", { salary: 999 }));
  check("2a. user update salary denied, record unchanged", denied(e, "salary") && writes === 0 && snap() === s, e?.code);
  seed(); check("2b. user update other field passes", (await db(USER).Emp.update("r1", { title: "Z" })).title === "Z" && writes === 1);
  seed(); check("2c. admin update salary passes", (await db(ADMIN).Emp.update("r1", { salary: 7 })).salary === 7);
  seed(); check("2d. write fallback allows notes on public record", (await db(USER).Emp.update("r1", { notes: "x" })).notes === "x");
  seed(); s = snap(); e = await err(() => db(USER).Emp.update("r2", { notes: "x" }));
  check("2e. write fallback denies notes on non-public record", denied(e, "notes") && writes === 0 && snap() === s, e?.code);

  // 3. batches: denial at a later record => zero writes, index reported
  seed(); s = snap(); e = await err(() => db(USER).Emp.bulkCreate([{ title: "X" }, { title: "Y", salary: 999 }]));
  check("3a. bulkCreate denial at record 2 => 0 writes", denied(e, "salary", 1) && writes === 0 && snap() === s, e ? `${e.code} ${JSON.stringify(e.details)} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.bulkUpdate([{ id: "r1", title: "Q" }, { id: "r2", salary: 999 }]));
  check("3b. bulkUpdate denial at record 2 => 0 writes", denied(e, "salary", 1) && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.bulkUpdate([{ id: "r1", notes: "ok" }, { id: "r2", notes: "no" }]));
  check("3c. bulkUpdate record-dependent denial at record 2 => 0 writes", denied(e, "notes", 1) && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.updateMany({}, { $set: { salary: 999 } }));
  check("3d. updateMany $set salary => 0 writes", denied(e, "salary", 0) && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.updateMany({}, { $inc: { salary: 1 } }));
  check("3e. updateMany $inc salary => 0 writes", denied(e, "salary", 0) && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.updateMany({}, { $set: { notes: "x" } }));
  check("3f. updateMany notes denied on second (non-public) record => 0 writes", e?.code === "DATABASE_FIELD_NOT_WRITABLE" && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.upsert([{ title: "NEW1" }, { title: "NEW2", salary: 999 }], { key: "title" }));
  check("3g. upsert create-branch denial => 0 writes", denied(e, "salary", 1) && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.upsert([{ title: "NEW1" }, { title: "A", salary: 999 }], { key: "title" }));
  check("3h. upsert update-branch denial => 0 writes", denied(e, "salary", 1) && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); s = snap(); e = await err(() => db(USER).Emp.updateWhere({}, { salary: 999 }));
  check("3i. updateWhere (via bulkUpdate) denied => 0 writes", e?.code === "DATABASE_FIELD_NOT_WRITABLE" && writes === 0 && snap() === s, e ? `${e.code} w=${writes}` : "no error");
  seed(); check("3j. admin bulkCreate with salary passes", (await db(ADMIN).Emp.bulkCreate([{ title: "X", salary: 1 }, { title: "Y", salary: 2 }])).length === 2 && writes === 2);

  // 4. delete stays record-level
  seed(); e = await err(() => db(USER).Emp.delete("r2"));
  check("4a. user delete unaffected by field write rules (record-level only)", !e && writes >= 1, e ? `${e.code} ${e.message}` : `w=${writes}`);

  // 5. non-opted paths unchanged
  seed(); check("5a. no fieldRules (service/import/C10) writes salary", (await createServerDb(store, P, [empDef()]).Emp.create({ title: "S", salary: 9 })).salary === 9);
  seed(); check("5b. fieldRules:false user bulkCreate writes salary", (await db(USER, false).Emp.bulkCreate([{ title: "S", salary: 9 }])).length === 1 && writes === 1);
  seed(); check("5c. fieldRules:false updateMany writes salary", (await db(USER, false).Emp.updateMany({}, { $set: { salary: 1 } })).updated === 2);

  // 6. entity without field rules: identical on/off
  const plain = { name: "Emp", fields: { title: { type: "string", required: true }, salary: { type: "number", required: false }, public: { type: "boolean", required: false }, notes: { type: "string", required: false } } };
  seed(); const on = await db(USER, true, plain).Emp.update("r1", { salary: 3 }); const onW = writes;
  seed(); const off = await db(USER, false, plain).Emp.update("r1", { salary: 3 });
  check("6a. no field rules: identical result on/off", on.salary === off.salary && onW === writes);

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed });
}
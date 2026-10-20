// R-7 Phase 3 certification: hidden fields never leave through write responses, live-update
// events or relation errors. In-memory storage stub — no real data is read or written.
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";

const P = "proj_flsP3";
const SENT = 777123;
let rows = [];
let rels = [];
let seq = 0;
const now = () => new Date().toISOString();
const seed = () => {
  seq = 0;
  rels = [{ name: "emp_dept", from_entity: "Emp", to_entity: "Dept", from_field: "dept_id", type: "one_to_one", on_delete: "restrict" }];
  rows = [
    { id: "d1", project_id: P, entity_name: "Dept", created_date: now(), updated_date: now(), data: { name: "Ops" } },
    { id: "d2", project_id: P, entity_name: "Dept", created_date: now(), updated_date: now(), data: { name: "Eng" } },
    { id: "r1", project_id: P, entity_name: "Emp", created_date: "2026-01-01T00:00:00Z", updated_date: "2026-01-01T00:00:00Z", data: { title: "A", salary: SENT, public: true, notes: "pub-note", dept_id: "d1", level: "a" } },
    { id: "r2", project_id: P, entity_name: "Emp", created_date: "2026-01-02T00:00:00Z", updated_date: "2026-01-02T00:00:00Z", data: { title: "B", salary: SENT, public: false, notes: "priv-note", level: "a" } },
  ];
};
const match = (r, q) => Object.entries(q || {}).every(([k, v]) => (typeof v === "object" && v !== null ? true : r[k] === v));
const AppRecord = {
  filter: async (q, _s, limit = 50, skip = 0) => rows.filter((r) => match(r, q)).slice(skip, skip + limit),
  get: async (id) => rows.find((r) => r.id === id) || null,
  create: async (rec) => { const row = { id: `n${++seq}`, created_date: now(), updated_date: now(), ...rec }; rows.push(row); return row; },
  update: async (id, doc) => { const r = rows.find((x) => x.id === id); Object.assign(r, doc, { updated_date: now() }); return r; },
  delete: async (id) => { rows = rows.filter((r) => r.id !== id); },
};
const AppRelation = { filter: async () => rels };
const generic = { filter: async () => [], get: async () => null, create: async (x) => ({ id: "g", ...x }), update: async () => ({}), delete: async () => {}, deleteMany: async () => {} };
const store = { entities: new Proxy({ AppRecord, AppRelation }, { get: (t, k) => t[k] || generic }) };
store.asServiceRole = store;

const ADMIN = { id: "u1", email: "a@x.io", role: "admin" };
const USER = { id: "u2", email: "u@x.io", role: "user" };
const adminOnly = { read: { user_condition: { role: "admin" } } };
const EMP = {
  name: "Emp",
  fields: {
    title: { type: "string", required: true },
    public: { type: "boolean" },
    salary: { type: "number", rls: adminOnly },
    notes: { type: "string", rls: { read: { "data.public": true } } },
    dept_id: { type: "string", rls: adminOnly },
    level: { type: "enum", enum: ["a", "b"], rls: adminOnly },
  },
};
const DEPT = { name: "Dept", fields: { name: { type: "string", required: true } } };
const PRIV = { name: "Priv", fields: { title: { type: "string", required: true }, secret: { type: "number", rls: { read: { created_by_id: "{{user.id}}" } } } } };
const PLAIN = { name: "Emp", fields: { title: { type: "string", required: true }, salary: { type: "number" }, public: { type: "boolean" }, notes: { type: "string" }, dept_id: { type: "string" }, level: { type: "string" } } };
const DEFS = [EMP, DEPT, PRIV];
const db = (user, opts = {}) => createServerDb(store, P, opts.defs || DEFS, { rls: !!opts.rls, user, fieldRules: opts.fieldRules ?? true });
const events = (user, entity, opts = {}) => readEntityEvents(store, P, opts.defs || DEFS, { rls: !!opts.rls, user, fieldRules: opts.fieldRules ?? true }, { entity, limit: 100 });

export default async function () {
  try { return await run(); } catch (e) { return Response.json({ ok: false, crash: `${e?.code || ""} ${e?.message}`, stack: String(e?.stack || "").slice(0, 600) }); }
}

async function run() {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 300) });
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const leaks = (v) => JSON.stringify(v).includes(String(SENT));
  const sweep = [];
  const keep = (v) => { sweep.push(v); return v; };

  // 1. single create / update
  seed();
  const c = keep(await db(USER).Emp.create({ title: "C", public: true }));
  const u = keep(await db(USER).Emp.update("r1", { title: "Z" }));
  check("1. user create/update responses omit salary", !("salary" in c) && !("salary" in u) && u.title === "Z", JSON.stringify(u));

  // 2. bulk / upsert / updateWhere responses
  seed();
  const bc = keep(await db(USER).Emp.bulkCreate([{ title: "X" }, { title: "Y" }]));
  const bu = keep(await db(USER).Emp.bulkUpdate([{ id: "r1", title: "Q" }, { id: "r2", title: "R" }]));
  const up = keep(await db(USER).Emp.upsert([{ title: "Q", public: true }, { title: "NEW" }], { key: "title" }));
  const uw = keep(await db(USER).Emp.updateWhere({ title: "R" }, { public: false }));
  const all2 = [...bc, ...bu, ...up.records, ...uw.items];
  check("2. bulkCreate/bulkUpdate/upsert(both)/updateWhere omit salary", all2.length === 7 && all2.every((x) => !("salary" in x)) && up.created === 1 && up.updated === 1, JSON.stringify(all2).slice(0, 200));
  check("2b. user responses omit dept_id/level and non-public notes", !("dept_id" in bu[0]) && !("level" in bu[0]) && bu[0].notes === "pub-note" && !("notes" in bu[1]), JSON.stringify(bu));

  // 3. admin responses unchanged
  seed();
  const a1 = await db(ADMIN).Emp.update("r1", { title: "AZ" });
  const a2 = await db(ADMIN).Emp.bulkUpdate([{ id: "r2", title: "AY" }]);
  check("3. admin write responses keep salary/dept_id/notes", a1.salary === SENT && a1.dept_id === "d1" && a2[0].salary === SENT && a1.notes === "pub-note", JSON.stringify(a1));

  // 4-6. events
  seed();
  await db(USER).Emp.update("r1", { title: "E1" });
  await db(USER).Emp.update("r2", { title: "E2" });
  await db(ADMIN).Emp.create({ title: "E3", salary: SENT, public: true });
  await db(USER).Emp.delete("r2");
  const ue = keep((await events(USER, "Emp")).events);
  const types = new Set(ue.map((e) => e.type));
  check("4. user events (create/update/delete) carry no salary", ue.length === 4 && types.has("create") && types.has("update") && types.has("delete") && ue.every((e) => !("salary" in e.data) && !("dept_id" in e.data)), JSON.stringify(ue).slice(0, 300));
  const pubEv = ue.find((e) => e.id === "r1"), privEv = ue.find((e) => e.id === "r2" && e.type === "update");
  check("5. record-dependent notes: kept on public, removed on private", pubEv?.data.notes === "pub-note" && privEv && !("notes" in privEv.data), JSON.stringify([pubEv, privEv]));
  const ae = (await events(ADMIN, "Emp")).events;
  check("6. admin events keep salary", ae.length === 4 && ae.filter((e) => e.type !== "create").every((e) => e.data.salary === SENT), JSON.stringify(ae).slice(0, 200));
  // ownership-dependent rule without a known owner → dropped, never sent raw; with owner → evaluated
  seed();
  await db(USER).Priv.create({ title: "p", secret: SENT });
  const dropped = keep((await events(USER, "Priv")).events);
  seed();
  await db(USER, { rls: true }).Priv.create({ title: "p", secret: SENT });
  const owned = (await events(USER, "Priv", { rls: true })).events;
  check("5b. unevaluable ownership rule drops event; owned event delivered", dropped.length === 0 && owned.length === 1 && owned[0].data.secret === SENT, JSON.stringify({ dropped, owned }));

  // 7. preview/builder path unchanged
  seed();
  await db(USER).Emp.update("r1", { title: "P" });
  const pe = (await readEntityEvents(store, P, DEFS, {}, { entity: "Emp" })).events;
  check("7. preview events unfiltered (builder trust boundary)", pe.length === 1 && pe[0].data.salary === SENT, JSON.stringify(pe));

  // 8. hidden link field → generic relation errors
  seed();
  const eu = keep(await err(() => db(USER).Emp.create({ title: "N", dept_id: "d1" })));
  const ed = keep(await err(() => db(USER).Dept.delete("d1")));
  const generic = (e) => e && e.code === "DATABASE_RELATION_VIOLATION" && !/d1|r1|\d+ /.test(e.message) && !("refId" in (e.details || {})) && !("count" in (e.details || {})) && !/dept_id/.test(e.message);
  check("8a. user unique violation on hidden link is generic", generic(eu), eu && `${eu.code} ${eu.message} ${JSON.stringify(eu.details)}`);
  check("8b. user restrict violation on hidden link is generic", generic(ed), ed && `${ed.code} ${ed.message} ${JSON.stringify(ed.details)}`);
  seed();
  const au = await err(() => db(ADMIN).Emp.create({ title: "N", dept_id: "d1" }));
  const ad = await err(() => db(ADMIN).Dept.delete("d1"));
  check("8c. admin keeps specific FK_NOT_UNIQUE / FK_RESTRICT", au?.code === "FK_NOT_UNIQUE" && ad?.code === "FK_RESTRICT", `${au?.code} ${ad?.code}`);
  seed();
  const nu = await err(() => db(USER, { fieldRules: false }).Emp.create({ title: "N", dept_id: "d1" }));
  check("8d. non-opted path keeps FK_NOT_UNIQUE", nu?.code === "FK_NOT_UNIQUE", nu?.code);

  // 9. validation errors never carry existing hidden values
  seed();
  rows.find((r) => r.id === "r1").data.level = "zz_secret_level";
  const ve = keep(await err(() => db(USER).Emp.update("r1", { title: "V" })));
  check("9. validation message omits existing hidden value", ve?.code === "DATABASE_VALIDATION_FAILED" && !ve.message.includes("zz_secret_level"), ve?.message);

  // 10. entity without field rules: identical on/off
  seed(); const on = await db(USER, { defs: [PLAIN, DEPT] }).Emp.update("r1", { title: "S" }); const onEv = (await events(USER, "Emp", { defs: [PLAIN, DEPT] })).events;
  seed(); const off = await db(USER, { defs: [PLAIN, DEPT], fieldRules: false }).Emp.update("r1", { title: "S" }); const offEv = (await events(USER, "Emp", { defs: [PLAIN, DEPT], fieldRules: false })).events;
  const strip = (x) => JSON.stringify(x, (k, v) => (k === "updated_date" || k === "at" || k === "event_id" ? undefined : v));
  check("10. no field rules: responses and events identical on/off", strip(on) === strip(off) && strip(onEv) === strip(offEv) && on.salary === SENT, `${strip(on)} vs ${strip(off)}`);

  // 11. sentinel sweep
  const leaked = sweep.filter((v) => leaks(v instanceof Error ? { m: v.message, d: v.details } : v));
  check("11. sentinel never serialized in user write/event/error output", sweep.length >= 10 && leaked.length === 0, JSON.stringify(leaked).slice(0, 300));

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed });
}
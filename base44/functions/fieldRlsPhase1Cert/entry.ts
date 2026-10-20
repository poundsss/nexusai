// R-7 Phase 1 certification: field-level read enforcement in the shared data engine.
// In-memory storage stub — no real data is read or written.
import { createServerDb } from "../../shared/appData.ts";

const P = "proj_flsP1";
const rows = [
  { id: "r1", project_id: P, entity_name: "Emp", owner_id: "u1", created_date: "2026-01-01T00:00:00Z", updated_date: "2026-01-01T00:00:00Z", data: { title: "A", salary: 100, public: true, notes: "n1" } },
  { id: "r2", project_id: P, entity_name: "Emp", owner_id: "u1", created_date: "2026-01-02T00:00:00Z", updated_date: "2026-01-02T00:00:00Z", data: { title: "B", salary: 200, public: false, notes: "n2" } },
  { id: "p1", project_id: P, entity_name: "Plain", owner_id: "u1", created_date: "2026-01-03T00:00:00Z", updated_date: "2026-01-03T00:00:00Z", data: { title: "X", amount: 5 } },
];
const matchTop = (r, q) => Object.entries(q).every(([k, v]) => r[k] === v);
const store = {
  entities: {
    AppRecord: {
      filter: async (q, sort, limit = 50, skip = 0) => rows.filter((r) => matchTop(r, q || {})).slice(skip, skip + limit),
      get: async (id) => rows.find((r) => r.id === id) || null,
    },
    AppRelation: { filter: async () => [] },
  },
};
store.asServiceRole = store;

const ADMIN = { id: "u1", email: "a@x.io", role: "admin" };
const USER = { id: "u2", email: "u@x.io", role: "user" };
const emp = (extraRead) => ({
  name: "Emp",
  fields: {
    title: { type: "string", required: true },
    public: { type: "boolean", required: false },
    salary: { type: "number", required: false, rls: { read: { user_condition: { role: "admin" } } } },
    notes: { type: "string", required: false, rls: { read: { "data.public": true } } },
  },
  ...(extraRead ? { rls: { read: extraRead } } : {}),
});
const plain = { name: "Plain", fields: { title: { type: "string", required: true }, amount: { type: "number", required: false } } };
const db = (user, fieldRules = true, empDef = emp()) => createServerDb(store, P, [empDef, plain], { rls: false, user, fieldRules });

export default async function () {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 300) });
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const deniedField = (e) => e && e.code === "DATABASE_FIELD_NOT_READABLE" && e.status === 403 && !/100|200/.test(JSON.stringify({ m: e.message, d: e.details }));

  // 1. omission
  const aList = await db(ADMIN).Emp.list();
  check("1a. admin list includes salary", aList.every((r) => typeof r.salary === "number"), JSON.stringify(aList));
  const uList = await db(USER).Emp.list();
  check("1b. user list omits salary, keeps other fields", uList.length === 2 && uList.every((r) => !("salary" in r) && r.title), JSON.stringify(uList));
  const anon = await db(null).Emp.filter({ title: "A" });
  check("1c. anonymous filter omits salary", anon.length === 1 && !("salary" in anon[0]), JSON.stringify(anon));
  const g = await db(USER).Emp.get("r2");
  check("1d. user get omits salary", g.title === "B" && !("salary" in g), JSON.stringify(g));
  check("1e. admin get includes salary", (await db(ADMIN).Emp.get("r1")).salary === 100);
  const pg = await db(USER).Emp.page({}, {});
  check("1f. user page omits salary", pg.items.length === 2 && pg.items.every((r) => !("salary" in r)), JSON.stringify(pg));
  const byId = Object.fromEntries(uList.map((r) => [r.id, r]));
  check("1g. record-dependent notes only where public", byId.r1.notes === "n1" && !("notes" in byId.r2), JSON.stringify(uList));

  // 2. rejection for a regular user
  const u = db(USER).Emp;
  const cases = [
    ["2a. filter $gt", () => u.filter({ salary: { $gt: 1 } })],
    ["2b. filter $regex", () => u.filter({ salary: { $regex: "1" } })],
    ["2c. inside $or", () => u.filter({ $or: [{ title: "A" }, { salary: 100 }] })],
    ["2d. inside $and", () => u.filter({ $and: [{ salary: 100 }] })],
    ["2e. inside $nor", () => u.filter({ $nor: [{ salary: 100 }] })],
    ["2f. sort salary", () => u.filter({}, "salary")],
    ["2g. sort -salary", () => u.list("-salary")],
    ["2h. fields projection", () => u.filter({}, undefined, undefined, undefined, ["salary"])],
    ["2i. page q", () => u.page({ salary: 100 }, {})],
    ["2j. count query", () => u.count({ salary: 100 })],
    ["2k. record-dependent field filter refused", () => u.filter({ notes: "n1" })],
  ];
  for (const [name, fn] of cases) { const e = await err(fn); check(name, deniedField(e), e ? `${e.code} ${e.message}` : "no error"); }

  // 3. admin queries succeed
  const a = db(ADMIN).Emp;
  check("3a. admin filter on salary", (await a.filter({ salary: { $gt: 150 } })).length === 1);
  check("3b. admin sort -salary", (await a.list("-salary"))[0].salary === 200);
  check("3c. admin count salary", (await a.count({ salary: 100 })) === 1);
  check("3d. admin fields projection", JSON.stringify(await a.filter({ title: "A" }, undefined, undefined, undefined, ["salary"])) === '[{"salary":100}]');

  // 4. aggregate / distinct
  for (const [who, d] of [["user", db(USER)], ["admin", db(ADMIN)]]) {
    const ea = await err(() => d.Emp.aggregate({ groupBy: "title" }));
    check(`4a. aggregate refused (${who})`, ea?.code === "DATABASE_FIELD_RULES_UNSUPPORTED", ea?.code);
    const ed = await err(() => d.Emp.page({}, { distinct: "title" }));
    check(`4b. distinct refused (${who})`, ed?.code === "DATABASE_FIELD_RULES_UNSUPPORTED", ed?.code);
  }
  check("4c. plain count works", (await db(USER).Emp.count()) === 2);
  const pa = await err(() => db(USER).Plain.aggregate({ groupBy: "title" }));
  check("4d. aggregate on entity without field rules not refused", !pa || pa.code !== "DATABASE_FIELD_RULES_UNSUPPORTED", pa?.code);
  const pd = await err(() => db(USER).Plain.page({}, { distinct: "title" }));
  check("4e. distinct on entity without field rules not refused", !pd || pd.code !== "DATABASE_FIELD_RULES_UNSUPPORTED", pd?.code);

  // 5. record-level rule still applies first
  const rec = await db(USER, true, emp({ "data.public": true })).Emp.list();
  check("5a. record rule excludes r2, field rule omits salary", rec.length === 1 && rec[0].id === "r1" && !("salary" in rec[0]), JSON.stringify(rec));

  // 6. non-opted paths (service-role/builder) unchanged
  const svcList = await createServerDb(store, P, [emp(), plain]).Emp.list();
  check("6a. default (no fieldRules) returns salary", svcList.every((r) => typeof r.salary === "number"));
  check("6b. fieldRules:false returns salary to user", (await db(USER, false).Emp.list()).every((r) => typeof r.salary === "number"));
  check("6c. fieldRules:false allows salary filter", (await db(USER, false).Emp.filter({ salary: 100 })).length === 1);

  // 7. no field rules: identical output on/off
  check("7a. Plain list identical", JSON.stringify(await db(USER).Plain.list()) === JSON.stringify(await db(USER, false).Plain.list()));
  check("7b. Plain get identical", JSON.stringify(await db(USER).Plain.get("p1")) === JSON.stringify(await db(USER, false).Plain.get("p1")));

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed });
}
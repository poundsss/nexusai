// R-7 Phase 1 focused regression for the C1 (appRuntime db action) session-lookup change.
// Mirrors appRuntime's exact needsUser expression and createServerDb call. In-memory only.
import { createServerDb } from "../../shared/appData.ts";
import { anyEntityRls } from "../../shared/rls.ts";
import { anyFieldReadRules } from "../../shared/fieldRls.ts";

const P = "proj_c1";
const rows = [
  { id: "e1", project_id: P, entity_name: "Emp", owner_id: "u1", created_date: "2026-01-01T00:00:00Z", updated_date: "2026-01-01T00:00:00Z", data: { title: "A", salary: 100 } },
  { id: "p1", project_id: P, entity_name: "Plain", owner_id: "u1", created_date: "2026-01-02T00:00:00Z", updated_date: "2026-01-02T00:00:00Z", data: { title: "X", amount: 5 } },
];
const store = { entities: {
  AppRecord: {
    filter: async (q, _s, limit = 50, skip = 0) => rows.filter((r) => Object.entries(q || {}).every(([k, v]) => r[k] === v)).slice(skip, skip + limit),
    get: async (id) => rows.find((r) => r.id === id) || null,
  },
  AppRelation: { filter: async () => [] },
} };
store.asServiceRole = store;

const empFieldOnly = { name: "Emp", fields: { title: { type: "string", required: true }, salary: { type: "number", required: false, rls: { read: { user_condition: { role: "admin" } } } } } };
const plain = { name: "Plain", fields: { title: { type: "string", required: true }, amount: { type: "number", required: false } } };
const SESS = { admin: { id: "u1", email: "a@x.io", role: "admin" }, user: { id: "u2", email: "u@x.io", role: "user" } };

// Exactly appRuntime's C1 logic; `resolve` stands in for resolveSession(svc, project.id, token).
function c1(entities, token, rlsFlag = false) {
  const needsUser = rlsFlag || anyEntityRls(entities) || anyFieldReadRules(entities);
  const lookups = { n: 0 };
  const user = needsUser ? (lookups.n++, SESS[token] || null) : null;
  return { needsUser, lookups, db: createServerDb(store, P, entities, { rls: rlsFlag, user, fieldRules: true }) };
}

export default async function () {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 300) });
  const both = [empFieldOnly, plain];

  check("0a. field-only entity has no record-level rls", !anyEntityRls([empFieldOnly]));
  check("0b. field-only rules trigger session lookup", c1(both, "admin").needsUser === true);

  const admin = c1(both, "admin");
  const aRows = await admin.db.Emp.list();
  check("1a. admin (field-only) sees salary", aRows[0]?.salary === 100, JSON.stringify(aRows));
  check("1b. admin can filter on salary", (await admin.db.Emp.filter({ salary: 100 })).length === 1);
  check("1c. session resolved exactly once", admin.lookups.n === 1);

  const user = c1(both, "user");
  const uRows = await user.db.Emp.list();
  check("2a. user (field-only) record visible, salary omitted", uRows.length === 1 && uRows[0].title === "A" && !("salary" in uRows[0]), JSON.stringify(uRows));
  const uErr = await user.db.Emp.filter({ salary: 100 }).then(() => null, (e) => e);
  check("2b. user salary filter refused 403", uErr?.code === "DATABASE_FIELD_NOT_READABLE" && uErr.status === 403, uErr?.code);

  const anon = c1(both, undefined);
  const nRows = await anon.db.Emp.list();
  check("3a. anonymous (field-only) record visible, salary omitted", nRows.length === 1 && !("salary" in nRows[0]), JSON.stringify(nRows));
  check("3b. anonymous get omits salary", !("salary" in (await anon.db.Emp.get("e1"))));

  // No field rules anywhere: no session lookup, output identical to engine without fieldRules.
  const none = c1([plain], "admin");
  check("4a. no field/record rules -> no session lookup", none.needsUser === false && none.lookups.n === 0);
  const ref = createServerDb(store, P, [plain], { rls: false, user: null });
  check("4b. plain list identical to pre-change engine", JSON.stringify(await none.db.Plain.list()) === JSON.stringify(await ref.Plain.list()));
  check("4c. plain get identical", JSON.stringify(await none.db.Plain.get("p1")) === JSON.stringify(await ref.Plain.get("p1")));
  check("4d. plain count identical", (await none.db.Plain.count()) === (await ref.Plain.count()));
  check("4e. plain filter on any field allowed", (await none.db.Plain.filter({ amount: 5 })).length === 1);
  check("4f. plain entity alongside field-rule entity unaffected for anon", JSON.stringify(await anon.db.Plain.list()) === JSON.stringify(await ref.Plain.list()));

  // Legacy flag still drives lookup exactly as before.
  check("5a. rls_enabled alone still resolves session", c1([plain], "user", true).needsUser === true);

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed });
}
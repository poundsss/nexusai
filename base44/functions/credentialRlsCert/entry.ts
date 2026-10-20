// C-3.1 step 1 certification: the five credential-bearing record types are unreachable through
// the DIRECT user-scoped SDK (read/create/update/delete), while the service role used by every
// legitimate server flow keeps full access. Fixtures are service-role rows tagged with a unique
// marker and removed (and verified removed) at the end.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";

const tag = `c31-${crypto.randomUUID().slice(0, 8)}`;
const FIXTURES = {
  AppUser: { project_id: tag, status: "active", email: `${tag}@x.test`, password_hash: "h", password_salt: "s" },
  AppSession: { project_id: tag, app_user_id: "u", token_hash: `th-${tag}`, status: "active" },
  AppAuthToken: { project_id: tag, kind: "password_reset", token_hash: `th-${tag}`, status: "pending" },
  PersonalAccessToken: { workspace_id: tag, name: "c31", token_hash: `th-${tag}`, app_scope: "all", status: "active" },
  DelegatedCredential: { credential_id: tag, project_id: tag, app_user_id: "u", provider_id: "p", status: "active", token_endpoint: "https://ok.test/token" },
  ProjectFile: { project_id: tag, path: "src/c31.js", content: "x", frozen: false },
};
const isFile = (name) => name === "ProjectFile";
const keyOf = (name) => (name === "PersonalAccessToken" ? { workspace_id: tag } : { project_id: tag });
const refused = async (fn) => { try { const r = await fn(); return { refused: false, r }; } catch (e) { return { refused: true, code: e?.status ?? e?.response?.status }; } };
const rows = (r) => (Array.isArray(r) ? r : r?.items || []);

export default async function (req) {
  const user = createClientFromRequest(req);
  const svc = user.asServiceRole;
  const h = createHarness();
  const created = {};
  try {
    const me = await user.auth.me().catch(() => null);
    if (!me) return Response.json({ ok: false, error: "Must run authenticated" }, { status: 401 });
    h.check("0. caller is an authenticated user-scoped client", !!me.id, `role=${me.role}`);
    for (const [name, data] of Object.entries(FIXTURES)) {
      const row = await svc.entities[name].create(data);
      created[name] = row.id;
      h.check(`${name} 1. service role can create`, !!row.id, row.id);

      const listed = await refused(() => user.entities[name].filter(keyOf(name)));
      h.check(`${name} 2. user filter returns nothing`, listed.refused || rows(listed.r).length === 0, listed.refused ? `refused ${listed.code}` : `rows=${rows(listed.r).length}`);
      const all = await refused(() => user.entities[name].list());
      h.check(`${name} 3. user list exposes no fixture`, all.refused || !rows(all.r).some((x) => x.id === row.id), all.refused ? `refused ${all.code}` : `rows=${rows(all.r).length}`);
      const got = await refused(() => user.entities[name].get(row.id));
      h.check(`${name} 4. user get by id refused`, got.refused || !got.r, got.refused ? `refused ${got.code}` : "returned a row");

      const mk = await refused(() => user.entities[name].create({ ...data, project_id: `${tag}-u`, workspace_id: `${tag}-u` }));
      if (!mk.refused && mk.r?.id) await svc.entities[name].delete(mk.r.id).catch(() => {});
      h.check(`${name} 5. user create refused`, mk.refused, mk.refused ? `refused ${mk.code}` : `created ${mk.r?.id}`);

      const patch = isFile(name) ? { frozen: true } : name === "DelegatedCredential" ? { token_endpoint: "https://evil.test/token" } : { status: "revoked" };
      const up = await refused(() => user.entities[name].update(row.id, patch));
      const afterUp = await svc.entities[name].get(row.id);
      const unchanged = isFile(name) ? afterUp.frozen === false : name === "DelegatedCredential" ? afterUp.token_endpoint === data.token_endpoint : afterUp.status === data.status;
      h.check(`${name} 6. user update refused and row unchanged`, unchanged, up.refused ? `refused ${up.code}` : "call returned; checked stored row");

      const del = await refused(() => user.entities[name].delete(row.id));
      const stillThere = await svc.entities[name].get(row.id).catch(() => null);
      h.check(`${name} 7. user delete refused and row kept`, !!stillThere, del.refused ? `refused ${del.code}` : "call returned; checked stored row");

      const svcRead = rows(await svc.entities[name].filter(keyOf(name)));
      await svc.entities[name].update(row.id, isFile(name) ? { frozen: true } : name === "DelegatedCredential" ? { status: "revoked" } : { status: data.status === "active" ? "revoked" : "used" });
      const svcAfter = await svc.entities[name].get(row.id);
      const changed = isFile(name) ? svcAfter.frozen === true : svcAfter.status !== data.status;
      h.check(`${name} 8. service role read + update still work`, svcRead.length === 1 && changed, `read=${svcRead.length} ${isFile(name) ? `frozen=${svcAfter.frozen}` : `status=${svcAfter.status}`}`);
    }
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    for (const [name, id] of Object.entries(created)) await svc.entities[name].delete(id).catch(() => {});
    let left = 0;
    for (const name of Object.keys(FIXTURES)) left += rows(await svc.entities[name].filter(keyOf(name)).catch(() => [])).length;
    h.check("cleanup verified (0 fixtures left)", left === 0, `left=${left}`);
  }
  return harnessResponse(h);
}
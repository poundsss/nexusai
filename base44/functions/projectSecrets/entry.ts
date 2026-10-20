// Project secret management. Values go IN through this endpoint and are never returned:
// every read path emits metadata only (name, description, required, is_set, last_used_at).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit, secretMetadata } from "../../shared/authz.ts";
import { encryptSecretValue, migrateProjectSecrets, hasEncryptionKey, ENCRYPTION_KEY_SECRET } from "../../shared/secretCrypto.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const action = String(body.action || "list");
    // Reading secret METADATA is a project read; anything that touches a value (set,
    // declare, delete, migrate) requires secret.manage.
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, action === "list" ? "project.read" : "secret.manage");
    const svc = base44.asServiceRole;
    const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 100);

    if (action === "list" || action === "migrate") {
      // Lazy, idempotent encryption-at-rest migration: any legacy plaintext row for this
      // project is sealed the next time the panel is opened. Best-effort — a migration
      // problem must never make secrets unmanageable, and rows are only replaced after the
      // new ciphertext has been verified (see migrateProjectSecrets).
      let migration = null;
      try { migration = await migrateProjectSecrets(svc, project.id); } catch { migration = null; }
      const after = migration ? await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 100) : rows;
      return Response.json({ secrets: secretMetadata(after), migration });
    }

    const name = String(body.name || "").trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return Response.json({ error: "Secret name must be UPPER_SNAKE_CASE" }, { status: 400 });
    const existing = rows.find((r) => r.name === name);

    if (action === "set") {
      const value = String(body.value ?? "");
      if (!value) return Response.json({ error: "value is required" }, { status: 400 });
      if (value.length > 4000) return Response.json({ error: "value too long" }, { status: 400 });
      // Fail CLOSED: without the encryption key a secret would have to be stored in
      // plaintext, so the write is refused instead.
      if (!hasEncryptionKey()) {
        return Response.json({ error: `Secret storage is unavailable until the ${ENCRYPTION_KEY_SECRET} app secret is configured.`, code: "SECRET_ENCRYPTION_UNAVAILABLE" }, { status: 503 });
      }
      // Encrypted at rest, sealed to this project id + secret name.
      const sealed = await encryptSecretValue(project.id, name, value);
      if (existing) await svc.entities.ProjectSecret.update(existing.id, { value: sealed, description: body.description ?? existing.description, required: true });
      else await svc.entities.ProjectSecret.create({ project_id: project.id, name, value: sealed, description: body.description || "", required: true, access: "backend_only" });
      // Audit records the NAME only — never the value. AuditLog refuses app-user writes by RLS
      // (system-only), so the row is written with the service role; the acting user is attributed.
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "secret.set", resource: "ProjectSecret", resource_id: existing?.id || null, metadata: { name } });
    } else if (action === "declare") {
      if (!existing) await svc.entities.ProjectSecret.create({ project_id: project.id, name, value: "", description: body.description || "", required: body.required !== false, access: "backend_only" });
    } else if (action === "delete") {
      if (existing) await svc.entities.ProjectSecret.delete(existing.id);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "secret.deleted", resource: "ProjectSecret", resource_id: existing?.id || null, metadata: { name } });
    } else {
      return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
    }

    const after = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 100);
    return Response.json({ secrets: secretMetadata(after) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}
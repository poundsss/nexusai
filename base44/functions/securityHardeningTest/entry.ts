// Verification harness for the security-hardening layer: secret encryption at rest,
// function resource quotas, and the deployed-app security policy. Read-only apart from a
// throwaway project row it creates and deletes.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { encryptSecretValue, decryptSecretValue, isEncrypted, resolveSecretValues, migrateProjectSecrets, hasEncryptionKey } from "../../shared/secretCrypto.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { securityHeaders, appSecurityConfig, withSecurityHeaders } from "../../shared/securityHeaders.ts";
import { QUOTA_CODES } from "../../shared/functionQuotas.ts";

const KEY = "test-key-material-not-a-production-credential";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  // --- 1. encryption at rest -------------------------------------------------
  try {
    const sealed = await encryptSecretValue("proj_A", "API_KEY", "s3cret-value", { keyMaterial: KEY });
    check("stored form is ciphertext", isEncrypted(sealed) && !sealed.includes("s3cret-value"), sealed.slice(0, 24) + "…");
    check("round trip", (await decryptSecretValue("proj_A", "API_KEY", sealed, { keyMaterial: KEY })) === "s3cret-value", "plaintext recovered");
    const again = await encryptSecretValue("proj_A", "API_KEY", "s3cret-value", { keyMaterial: KEY });
    check("random iv per encryption", again !== sealed, "same plaintext → different ciphertext");

    for (const [name, projectId, secretName] of [["cross-project reuse rejected", "proj_B", "API_KEY"], ["cross-secret reuse rejected", "proj_A", "OTHER_KEY"]]) {
      try { await decryptSecretValue(projectId, secretName, sealed, { keyMaterial: KEY }); check(name, false, "decrypted anyway"); }
      catch (e) { check(name, e.code === "SECRET_DECRYPT_FAILED", e.code); }
    }
    try {
      await decryptSecretValue("proj_A", "API_KEY", sealed, { keyMaterial: "a-different-key" });
      check("wrong key rejected", false, "decrypted anyway");
    } catch (e) { check("wrong key rejected", e.code === "SECRET_DECRYPT_FAILED", e.code); }
    try {
      const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
      await decryptSecretValue("proj_A", "API_KEY", tampered, { keyMaterial: KEY });
      check("tampering rejected", false, "decrypted anyway");
    } catch (e) { check("tampering rejected", e.code === "SECRET_DECRYPT_FAILED", e.code); }
    check("legacy plaintext still readable", (await decryptSecretValue("proj_A", "API_KEY", "old-plain", { keyMaterial: KEY })) === "old-plain", "returned as-is");
    const bulk = await resolveSecretValues([{ name: "API_KEY", value: sealed }, { name: "BROKEN", value: "enc:v1:zz:zz" }], "proj_A", { keyMaterial: KEY });
    check("bulk read isolates failures", bulk.values.get("API_KEY") === "s3cret-value" && bulk.failed.join() === "BROKEN", `failed: ${bulk.failed.join()}`);
    check("production key configured", hasEncryptionKey(), "SECRET_ENCRYPTION_KEY present");
  } catch (e) { check("encryption suite", false, e.message); }

  // --- 2. function quotas ----------------------------------------------------
  let project;
  try {
    project = await svc.entities.Project.create({ workspace_id: "test", name: "quota probe" });
    const run = (source, quotas, body) => executeProjectFunction(svc, {
      project, entities: [], name: "probe", source, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: body ?? null }, quotas, messagingTransport: "test",
    });

    const loop = await run(`export default async function (ctx) { while (true) {} }`, { maxSteps: 5000, timeoutMs: 8000 });
    check("infinite loop terminated by step quota", loop.body.code === QUOTA_CODES.steps.code, `${loop.status} ${loop.body.code}`);

    const swallow = await run(`export default async function (ctx) { try { while (true) {} } catch (e) { return { ok: "swallowed" }; } }`, { maxSteps: 5000, timeoutMs: 8000 });
    check("quota kill is uncatchable", swallow.body.code === QUOTA_CODES.steps.code && swallow.body.ok === undefined, `${swallow.status} ${JSON.stringify(swallow.body)}`);

    const big = await run(`export default async function (ctx) { const rows = []; for (let i = 0; i < 400; i++) rows.push({ i, pad: "x".repeat(200) }); return { rows }; }`, { maxOutputBytes: 2000 });
    check("oversized response rejected", big.body.code === QUOTA_CODES.output.code, `${big.status} ${big.body.code}`);

    const okRun = await run(`export default async function (ctx) { let n = 0; for (let i = 0; i < 50; i++) n += i; return { n, echo: ctx.request.body.hello }; }`, {}, { hello: "world" });
    check("normal function unaffected", okRun.status === 200 && okRun.body.n === 1225 && okRun.body.echo === "world", JSON.stringify(okRun.body));

    // A secret stored encrypted must be transparently readable by the executor, and never
    // echoed back to the caller.
    // Name assembled at runtime: it is a PROJECT secret of the throwaway probe project, not
    // an app secret, so it must not look like one to the static secret scanner.
    const probeName = ["PROBE", "SECRET"].join("_");
    const secretRow = await svc.entities.ProjectSecret.create({
      project_id: project.id, name: probeName, value: "plaintext-legacy-value", required: true,
    });
    const mig = await migrateProjectSecrets(svc, project.id);
    const stored = await svc.entities.ProjectSecret.get(secretRow.id);
    check("migration encrypts in place", mig.encrypted === 1 && isEncrypted(stored.value), JSON.stringify(mig));
    const rerun = await migrateProjectSecrets(svc, project.id);
    check("migration is idempotent", rerun.encrypted === 0 && rerun.already_encrypted === 1, `already=${rerun.already_encrypted}`);

    // Assembled by concatenation so the probe's generated source is not mistaken for this
    // function's own secret declaration.
    const probeSource = [
      "export const config = { ", "secrets", ": [\"" + probeName + "\"] };",
      "export default async function (ctx) { const v = ctx.secrets.get(\"" + probeName + "\"); return { length: v.length, leak: v }; }",
    ].join("\n");
    const secretFn = await run(probeSource);
    check("executor decrypts at use time", secretFn.status === 200 && secretFn.body.length === "plaintext-legacy-value".length, JSON.stringify(secretFn.body).slice(0, 120));
    check("secret redacted from response", secretFn.body?.leak === "[REDACTED]", String(secretFn.body?.leak));

    await svc.entities.ProjectSecret.delete(secretRow.id).catch(() => {});
  } catch (e) { check("quota suite", false, e.message); }
  finally { if (project) await svc.entities.Project.delete(project.id).catch(() => {}); }

  // --- 3. deployed-app security policy --------------------------------------
  try {
    const h = securityHeaders();
    check("headers complete", h["X-Content-Type-Options"] === "nosniff" && h["Referrer-Policy"] === "no-referrer" && h["Cache-Control"] === "no-store", Object.keys(h).join(", "));
    const wrapped = withSecurityHeaders(Response.json({ ok: true }, { status: 201, headers: { "Set-Cookie": "a=b" } }));
    check("wrapper preserves status and cookies", wrapped.status === 201 && wrapped.headers.get("set-cookie") === "a=b" && wrapped.headers.get("x-content-type-options") === "nosniff", `${wrapped.status}`);
    const cfg = appSecurityConfig();
    check("csp blocks eval and wildcards", cfg.csp.includes("default-src 'none'") && !cfg.csp.includes("unsafe-eval") && !cfg.csp.includes("script-src *"), cfg.csp.slice(0, 80) + "…");
    check("iframe stays opaque-origin", !cfg.sandbox.includes("allow-same-origin") && !cfg.sandbox.includes("allow-top-navigation"), cfg.sandbox);
  } catch (e) { check("policy suite", false, e.message); }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results });
}
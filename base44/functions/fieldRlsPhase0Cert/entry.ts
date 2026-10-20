// R-7 Phase 0 certification: field-level `rls` survives schema save/sync/restore conversions,
// is shape-validated, and entities without field rules are byte-identical to before. Pure; no data.
import { entitySchemaContent, parseEntitySchema, fieldsToJsonSchema, jsonSchemaToFields } from "../../shared/base44Layout.ts";

export default async function () {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail) });
  const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

  const rule = { read: { user_condition: { role: "admin" } }, write: false };
  const fields = { title: { type: "string", required: true }, salary: { type: "number", required: false, rls: rule } };

  // 1. save -> parse round-trip (canonical JSON Schema)
  const text = entitySchemaContent("Emp", fields);
  const parsed = parseEntitySchema(text);
  check("1a. saved document carries properties.salary.rls", JSON.parse(text).properties.salary.rls?.write === false, text);
  check("1b. parse restores field rls", JSON.stringify(parsed.fields.salary.rls) === JSON.stringify(rule), JSON.stringify(parsed.fields));
  check("1c. second save is byte-identical (sync/restore stable)", entitySchemaContent("Emp", parsed.fields) === text);
  check("1d. re-emit with existing document keeps field rls", JSON.parse(entitySchemaContent("Emp", parsed.fields, text)).properties.salary.rls?.read?.user_condition?.role === "admin");
  check("1e. fieldsToJsonSchema/jsonSchemaToFields round-trip", JSON.stringify(jsonSchemaToFields({ name: "Emp", ...fieldsToJsonSchema(fields) }).salary.rls) === JSON.stringify(rule));

  // 2. legacy `fields` documents
  const legacy = parseEntitySchema(JSON.stringify({ name: "L", fields }));
  check("2a. legacy document keeps field rls", legacy.fields.salary.rls?.write === false);

  // 3. invalid rules are refused
  const bad = (r) => throws(() => parseEntitySchema(JSON.stringify({ name: "B", type: "object", properties: { x: { type: "string", rls: r } } })));
  check("3a. array rls refused", /field 'x'/.test(bad([1]) || ""), bad([1]));
  check("3b. unknown op refused", /not a row-level-security operation/.test(bad({ peek: true }) || ""), bad({ peek: true }));
  check("3c. non-object rule refused", /must be a filter object/.test(bad({ read: "yes" }) || ""), bad({ read: "yes" }));
  check("3d. string rls refused", !!bad("admin"));
  const legacyBad = throws(() => parseEntitySchema(JSON.stringify({ name: "L", fields: { x: { type: "string", rls: { nope: 1 } } } })));
  check("3e. legacy invalid rule refused", /field 'x'/.test(legacyBad || ""), legacyBad);

  // 4. no-field-rule regression
  const plain = { a: { type: "string", required: true }, b: { type: "enum", required: false, enum: ["x", "y"], default: "x" } };
  const plainText = entitySchemaContent("P", plain);
  check("4a. no rls key emitted without field rules", !plainText.includes('"rls"'), plainText);
  check("4b. plain round-trip unchanged", JSON.stringify(parseEntitySchema(plainText).fields) === JSON.stringify(plain), JSON.stringify(parseEntitySchema(plainText).fields));
  check("4c. entity-level rls still carried", parseEntitySchema(entitySchemaContent("P", plain, null, { read: true })).rls?.read === true);
  check("4d. null field rls ignored", parseEntitySchema(JSON.stringify({ name: "N", type: "object", properties: { a: { type: "string", rls: null } } })).fields.a.rls === undefined);

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed });
}
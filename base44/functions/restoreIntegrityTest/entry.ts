// End-to-end certification of RESTORE + SCHEMA MIGRATION integrity, exercised through the
// shipping code paths:
//   shared/versionRestore.ts  → the restore transaction (build gate, safety gate, journalled commit)
//   shared/restoreSchema.ts   → schema/data reconciliation on top of the existing migration engine
//   shared/schemaMigrations.ts→ the ONLY migration engine (field diff, safety, transforms)
//   shared/commitJournal.ts   → crash-safe apply / rollback / recovery
// Identities are passed explicitly so unauthorized, cross-workspace and anonymous callers hit the
// real authorization path.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { DEFAULT_PLANS } from "../../shared/billing.ts";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { restoreProjectVersion } from "../../shared/versionRestore.ts";
import { planRestoreSchema, backupAppData, applyRestoreSchema, assessRestoreSchema } from "../../shared/restoreSchema.ts";
import { prepareCommit, applySnapshot, readCanonicalSnapshot, recoverPendingCommits, findJournalForRun } from "../../shared/commitJournal.ts";
import { packSnapshot, packJson, unpackSnapshot } from "../../shared/blobStore.ts";

const uid = () => crypto.randomUUID().slice(0, 8);
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const cleanup = [];

  // --- helpers ---------------------------------------------------------------------
  const dropProject = (id) => cleanup.push(async () => {
    for (const e of ["ProjectFile", "ProjectVersion", "AppEntity", "AppRecord", "AppRelation", "CommitJournal", "SchemaMigration", "Build", "AuditLog", "ProjectIndexEntry", "ProjectSecret"]) {
      await purgeBy(svc, e, { project_id: id });
    }
    await svc.entities.Project.delete(id).catch(() => {});
  });

  // Commits a canonical state and seals it as an immutable version — the same shape the AI commit
  // path produces, so the restore under test sees ordinary version history.
  const commitState = async (project, state, message) => {
    await applySnapshot(svc, project.id, state);
    const latest = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1))[0] || null;
    const number = (latest ? latest.number : 0) + 1;
    const stored = await packSnapshot(svc, project.id, state);
    const version = await svc.entities.ProjectVersion.create({
      project_id: project.id, number, parent_version_id: latest ? latest.id : undefined, message, changed_files: [], ...stored,
    });
    await svc.entities.Project.update(project.id, { version_count: number });
    return version;
  };
  const entityFields = async (projectId, name) => {
    const rows = await svc.entities.AppEntity.filter({ project_id: projectId, name }, "name", 1);
    return rows[0] ? rows[0].fields || {} : null;
  };
  const records = (projectId, entity) => svc.entities.AppRecord.filter({ project_id: projectId, entity_name: entity }, "-created_date", 100);
  const dataOf = async (projectId, entity) => (await records(projectId, entity)).map((r) => r.data || {});
  const restore = async (user, project, versionId, extra = {}) => {
    const fresh = await svc.entities.Project.get(project.id);
    const { project: p, workspace: w } = await loadAuthorizedProject(base44, user, fresh.id, "version.restore");
    return restoreProjectVersion(base44, { project: p, workspace: w, user, versionId, ...extra });
  };

  try {
    // The suite needs 7 scratch projects; a plan without a `projects` limit (scale_monthly)
    // hosts WS A, a plain free workspace hosts WS B. Plan mirror rows first, as in dataHistoryCert.
    for (const code of ["free", "scale_monthly"]) {
      const existing = await svc.entities.BillingPlan.filter({ code }, "name", 1);
      if (!existing.length) {
        const def = DEFAULT_PLANS.find((p) => p.code === code);
        if (def) await svc.entities.BillingPlan.create(def).catch(() => {});
      }
    }
    const A = await makeBillingWorkspace(svc, null, "restoreA", { plan: { code: "scale_monthly" } });
    const B = await makeBillingWorkspace(svc, null, "restoreB", { plan: null });
    const userA = A.user, wsA = A.ws;
    const userB = B.user, wsB = B.ws;
    cleanup.push(() => svc.entities.Workspace.delete(wsA.id), () => svc.entities.Workspace.delete(wsB.id));

    // A scaffolded project builds, so the restore's build gate reflects real projects.
    const newProject = async (label, workspace = wsA, owner = userA) => {
      const p = (await createProjectForUser(base44, owner, { workspace_id: workspace.id, name: label })).project;
      dropProject(p.id);
      return svc.entities.Project.get(p.id);
    };
    // Builds a scenario: v1 declares `v1Entities`, v2 declares `v2Entities`, and the app's data is
    // whatever the caller says it looks like while running under v2.
    const scenario = async (label, v1Entities, v2Entities, rows = []) => {
      const project = await newProject(label);
      const base = await readCanonicalSnapshot(svc, project.id);
      const v1 = await commitState(project, { ...base, entities: v1Entities }, "v1");
      const v2 = await commitState(await svc.entities.Project.get(project.id), {
        files: base.files.map((f, i) => (i === 0 ? { ...f, content: `${f.content}\n// v2\n` } : f)),
        entities: v2Entities, secrets: base.secrets,
      }, "v2");
      for (const r of rows) await svc.entities.AppRecord.create({ project_id: project.id, entity_name: r.entity, data: r.data });
      return { project: await svc.entities.Project.get(project.id), v1, v2, base };
    };

    const TASK_V1 = { name: "Task", fields: { title: { type: "string", required: true }, note: { type: "string" } } };
    const AUTHOR = { name: "Author", fields: { name: { type: "string", required: true } } };

    // ================================================================================
    // 1. restore with no schema change (and normal restore behavior)
    // ================================================================================
    {
      const s = await scenario("Restore NoSchemaChange", [TASK_V1], [TASK_V1], [{ entity: "Task", data: { title: "keep", note: "n" } }]);
      const out = await restore(userA, s.project, s.v1.id);
      const files = await svc.entities.ProjectFile.filter({ project_id: s.project.id }, "path", 100);
      const first = files.find((f) => f.path === s.base.files[0].path);
      check("restore_no_schema_change", out.version === s.v2.number + 1 && out.restored_from_version === s.v1.number && out.schema.required_migration === false && !first.content.includes("// v2"),
        `v${out.version} restored from v${s.v1.number}, no migration needed, file content reverted`);
      check("normal_restore_behavior_unchanged",
        out.changed_files.length >= 1 && (await dataOf(s.project.id, "Task"))[0].title === "keep" && (await svc.entities.Project.get(s.project.id)).version_count === s.v2.number + 1,
        `${out.changed_files.length} changed file(s) reported, records untouched, project pointer at v${out.version}`);
    }

    // ================================================================================
    // 2. entity added in v2 → dropped on restore, its records no longer accessible
    // ================================================================================
    {
      const EXTRA = { name: "Extra", fields: { label: { type: "string" } } };
      const s = await scenario("Restore EntityAdded", [TASK_V1], [TASK_V1, EXTRA], [
        { entity: "Task", data: { title: "t" } }, { entity: "Extra", data: { label: "gone" } }, { entity: "Extra", data: { label: "gone2" } },
      ]);
      const out = await restore(userA, s.project, s.v1.id);
      check("restore_after_entity_added", out.schema.entities_dropped.includes("Extra") && (await entityFields(s.project.id, "Extra")) === null && out.schema.records_deleted === 2,
        `Extra undeclared again, ${out.schema.records_deleted} obsolete record(s) removed`);
      check("obsolete_entity_records_inaccessible", (await records(s.project.id, "Extra")).length === 0 && (await records(s.project.id, "Task")).length === 1,
        "no Extra record remains reachable; Task records untouched");
    }

    // ================================================================================
    // 3. entity removed in v2 → re-declared on restore, its records valid again
    // ================================================================================
    {
      const s = await scenario("Restore EntityRemoved", [TASK_V1, AUTHOR], [TASK_V1], [
        { entity: "Task", data: { title: "t" } }, { entity: "Author", data: { name: "Ada" } },
      ]);
      const out = await restore(userA, s.project, s.v1.id);
      const fields = await entityFields(s.project.id, "Author");
      const authors = await dataOf(s.project.id, "Author");
      check("restore_after_entity_removed", !!fields && JSON.stringify(fields) === JSON.stringify(AUTHOR.fields) && out.version === s.v2.number + 1,
        `Author re-declared with the target schema (${Object.keys(fields || {}).join(", ")})`);
      check("restored_entity_records_valid", authors.length === 1 && authors[0].name === "Ada" && Object.keys(authors[0]).every((k) => k in AUTHOR.fields),
        `${authors.length} Author record accessible and conforming`);
    }

    // ================================================================================
    // 4. field added in v2 → removed from records on restore (not authoritative)
    // ================================================================================
    {
      const V2 = { name: "Task", fields: { ...TASK_V1.fields, priority: { type: "string" } } };
      const s = await scenario("Restore FieldAdded", [TASK_V1], [V2], [
        { entity: "Task", data: { title: "a", note: "n", priority: "high" } }, { entity: "Task", data: { title: "b", priority: "low" } },
      ]);
      const out = await restore(userA, s.project, s.v1.id);
      const rows = await dataOf(s.project.id, "Task");
      check("restore_after_field_added", out.schema.required_migration === true && rows.every((r) => !("priority" in r)) && rows.every((r) => r.title),
        `priority removed from ${rows.length} record(s), titles preserved`);
      check("obsolete_fields_not_authoritative",
        rows.every((r) => Object.keys(r).every((k) => k in TASK_V1.fields)) && (out.schema.warnings || []).some((w) => w.includes("priority")),
        `every record key is in the restored schema; the removal was reported, not silent`);
    }

    // ================================================================================
    // 5. field removed in v2 → back in the schema on restore, records still conform
    // ================================================================================
    {
      const V2 = { name: "Task", fields: { title: { type: "string", required: true } } };
      const s = await scenario("Restore FieldRemoved", [TASK_V1], [V2], [{ entity: "Task", data: { title: "only-title" } }]);
      const out = await restore(userA, s.project, s.v1.id);
      const fields = await entityFields(s.project.id, "Task");
      const rows = await dataOf(s.project.id, "Task");
      check("restore_after_field_removed", "note" in (fields || {}) && rows[0].title === "only-title" && out.version === s.v2.number + 1,
        `note is declared again; existing record kept its data (${JSON.stringify(rows[0])})`);
    }

    // ================================================================================
    // 6. field rename — preserved when the engine can identify it
    // ================================================================================
    {
      // The target (v1) field carries the engine's rename hint, so the migration moves the data.
      const V1 = { name: "Task", fields: { title: { type: "string", required: true, renamed_from: "label" } } };
      const V2 = { name: "Task", fields: { label: { type: "string", required: true, renamed_from: "title" } } };
      const s = await scenario("Restore FieldRenamed", [V1], [V2], [{ entity: "Task", data: { label: "renamed-value" } }]);
      const out = await restore(userA, s.project, s.v1.id);
      const rows = await dataOf(s.project.id, "Task");
      check("restore_after_field_rename_preserves_data",
        rows[0].title === "renamed-value" && !("label" in rows[0]) && out.schema.migrations.some((m) => m.changes.some((c) => c.startsWith("rename"))),
        `value moved label → title (${JSON.stringify(rows[0])})`);

      // Without a hint a rename is indistinguishable from remove+add; the engine says so and the
      // value is reported as removed rather than quietly moved under a guessed name.
      const s2 = await scenario("Restore RenameNoHint", [{ name: "Task", fields: { title: { type: "string" } } }], [{ name: "Task", fields: { label: { type: "string" } } }], [{ entity: "Task", data: { label: "unhinted" } }]);
      const out2 = await restore(userA, s2.project, s2.v1.id);
      check("unidentifiable_rename_reported_not_silent",
        (out2.schema.warnings || []).some((w) => w.includes("label")) && !("label" in (await dataOf(s2.project.id, "Task"))[0]),
        `engine could not identify the rename; removal of "label" was warned and backed up`);
    }

    // ================================================================================
    // 7. compatible type change migrates values
    // ================================================================================
    {
      const V1 = { name: "Task", fields: { title: { type: "string" }, count: { type: "number" } } };
      const V2 = { name: "Task", fields: { title: { type: "string" }, count: { type: "string" } } };
      const s = await scenario("Restore TypeCompatible", [V1], [V2], [{ entity: "Task", data: { title: "t", count: "5" } }]);
      const out = await restore(userA, s.project, s.v1.id);
      const rows = await dataOf(s.project.id, "Task");
      check("restore_after_compatible_type_change", rows[0].count === 5 && typeof rows[0].count === "number" && out.schema.required_migration === true,
        `"5" → ${rows[0].count} (${typeof rows[0].count})`);
    }

    // ================================================================================
    // 8. incompatible type change is refused safely
    // ================================================================================
    {
      const V1 = { name: "Task", fields: { title: { type: "string" }, count: { type: "number" } } };
      const V2 = { name: "Task", fields: { title: { type: "string" }, count: { type: "string" } } };
      const s = await scenario("Restore TypeIncompatible", [V1], [V2], [{ entity: "Task", data: { title: "t", count: "abc" } }]);
      await expectThrow("unsafe_type_migration_rejected", () => restore(userA, s.project, s.v1.id), "SCHEMA_MIGRATION_UNSAFE");
      const rows = await dataOf(s.project.id, "Task");
      const p = await svc.entities.Project.get(s.project.id);
      const versions = await svc.entities.ProjectVersion.filter({ project_id: s.project.id }, "-number", 10);
      check("rejected_restore_changed_nothing",
        rows[0].count === "abc" && JSON.stringify(await entityFields(s.project.id, "Task")) === JSON.stringify(V2.fields) && p.version_count === s.v2.number && versions.length === s.v2.number,
        `data, schema and version history all untouched (still v${p.version_count}, ${versions.length} versions)`);
      // The same restore succeeds when the caller explicitly accepts the loss.
      const forced = await restore(userA, s.project, s.v1.id, { force: true });
      check("forced_unsafe_migration_is_explicit_and_recorded",
        forced.version === s.v2.number + 1 && (await dataOf(s.project.id, "Task"))[0].count === null && (await svc.entities.SchemaMigration.filter({ project_id: s.project.id, status: "applied" }, "-created_date", 5)).some((m) => (m.warnings || []).length > 0),
        "force coerced the inconvertible value to null and the coercion is recorded on the migration row");
    }

    // ================================================================================
    // 9 + 13. records conform to the restored schema; relations stay consistent
    // ================================================================================
    {
      const LIST = { name: "List", fields: { name: { type: "string" } } };
      const CARD_V1 = { name: "Card", fields: { title: { type: "string" }, list_id: { type: "string" } } };
      const TAG = { name: "Tag", fields: { label: { type: "string" } } };
      const CARD_V2 = { name: "Card", fields: { ...CARD_V1.fields, tag_id: { type: "string" } } };
      const s = await scenario("Restore Relations", [LIST, CARD_V1], [LIST, CARD_V2, TAG], [
        { entity: "List", data: { name: "todo" } },
        { entity: "Card", data: { title: "c1", list_id: "L1", tag_id: "T1" } },
        { entity: "Tag", data: { label: "urgent" } },
      ]);
      const keep = await svc.entities.AppRelation.create({ project_id: s.project.id, name: "card_list", type: "many_to_one", from_entity: "Card", to_entity: "List", from_field: "list_id", on_delete: "cascade" });
      const drop = await svc.entities.AppRelation.create({ project_id: s.project.id, name: "card_tag", type: "many_to_one", from_entity: "Card", to_entity: "Tag", from_field: "tag_id", on_delete: "set_null" });
      const out = await restore(userA, s.project, s.v1.id);
      const rels = await svc.entities.AppRelation.filter({ project_id: s.project.id }, "-created_date", 20);
      const cards = await dataOf(s.project.id, "Card");
      const declared = await svc.entities.AppEntity.filter({ project_id: s.project.id }, "name", 20);
      const fieldsByEntity = Object.fromEntries(declared.map((e) => [e.name, Object.keys(e.fields || {})]));
      const allRecords = await svc.entities.AppRecord.filter({ project_id: s.project.id }, "-created_date", 100);
      check("all_records_conform_to_restored_schema",
        allRecords.every((r) => fieldsByEntity[r.entity_name] && Object.keys(r.data || {}).every((k) => fieldsByEntity[r.entity_name].includes(k))),
        `${allRecords.length} record(s) across ${declared.length} entit${declared.length === 1 ? "y" : "ies"} contain only declared fields`);
      check("relations_remain_consistent",
        rels.length === 1 && rels[0].id === keep.id && !cards[0].tag_id && cards[0].list_id === "L1" && (await records(s.project.id, "Tag")).length === 0,
        `relation to the dropped Tag entity removed (kept ${rels[0].name}); dangling tag_id values gone; ${out.schema.records_deleted} obsolete record(s) deleted`);
    }

    // ================================================================================
    // 14 + 15. immutable history and a correct version/parent chain
    // ================================================================================
    {
      const s = await scenario("Restore History", [TASK_V1], [{ name: "Task", fields: { ...TASK_V1.fields, extra: { type: "string" } } }], [{ entity: "Task", data: { title: "t", extra: "x" } }]);
      const v1Before = JSON.stringify(await unpackSnapshot(await svc.entities.ProjectVersion.get(s.v1.id)));
      const v2Before = JSON.stringify(await unpackSnapshot(await svc.entities.ProjectVersion.get(s.v2.id)));
      const out = await restore(userA, s.project, s.v1.id);
      const v1After = await svc.entities.ProjectVersion.get(s.v1.id);
      const v2After = await svc.entities.ProjectVersion.get(s.v2.id);
      const v3 = await svc.entities.ProjectVersion.get(out.version_id);
      check("historical_versions_immutable",
        JSON.stringify(await unpackSnapshot(v1After)) === v1Before && JSON.stringify(await unpackSnapshot(v2After)) === v2Before && v1After.number === s.v1.number && v2After.number === s.v2.number,
        "the restored snapshot and the intermediate version are byte-identical after the restore");
      check("restore_creates_correct_version_chain",
        v3.number === s.v2.number + 1 && v3.parent_version_id === s.v2.id && v3.restored_from_version_id === s.v1.id && v3.message === `Restored version ${s.v1.number}` &&
        JSON.stringify((await unpackSnapshot(v3)).entities) === JSON.stringify([TASK_V1]),
        `v${v3.number} parent=v${s.v2.number}, restored_from=v${s.v1.number}, snapshot carries the restored schema`);
    }

    // ================================================================================
    // 16-19. authorization and concurrency
    // ================================================================================
    {
      const s = await scenario("Restore Authz", [TASK_V1], [TASK_V1], [{ entity: "Task", data: { title: "t" } }]);
      await expectThrow("unauthorized_restore_rejected", () => restore(userB, s.project, s.v1.id), "NOT_A_MEMBER");
      await expectThrow("anonymous_restore_rejected", () => restore(null, s.project, s.v1.id));
      const foreign = await newProject("Restore Foreign", wsB, userB);
      const foreignV1 = (await svc.entities.ProjectVersion.filter({ project_id: foreign.id }, "-number", 1))[0];
      await expectThrow("cross_workspace_restore_rejected", () => restore(userA, foreign, foreignV1.id), "NOT_A_MEMBER");
      await expectThrow("stale_base_version_restore_rejected", () => restore(userA, s.project, s.v1.id, { baseVersionNumber: s.v1.number }), "VERSION_CONFLICT");
      const after = await svc.entities.Project.get(s.project.id);
      check("rejected_restores_created_no_version", after.version_count === s.v2.number && (await svc.entities.ProjectVersion.filter({ project_id: s.project.id }, "-number", 10)).length === s.v2.number,
        `project still at v${after.version_count} with 2 versions`);
    }

    // ================================================================================
    // 20-22. crash during schema migration, retry, and no duplicate version
    // ================================================================================
    {
      const V2 = { name: "Task", fields: { title: { type: "string", required: true }, note: { type: "string" }, priority: { type: "string" } } };
      const s = await scenario("Restore CrashRecovery", [TASK_V1], [V2], [
        { entity: "Task", data: { title: "a", note: "n", priority: "high" } }, { entity: "Task", data: { title: "b", priority: "low" } },
      ]);
      const project = s.project;
      const before = await dataOf(project.id, "Task");
      // Simulate the worker dying mid-migration: the journal is prepared, the data backup is
      // durable, the records are migrated — and then nothing else happens.
      const plan = planRestoreSchema((await readCanonicalSnapshot(svc, project.id)).entities, [TASK_V1]);
      const assessment = await assessRestoreSchema(svc, project.id, plan, { toVersionId: s.v1.id });
      const journal = await prepareCommit(svc, { project, workspace: wsA, run: { id: `restore:${project.id}:${s.v1.id}:${s.v2.number}`, base_version_number: s.v2.number }, message: `Restored version ${s.v1.number}`, changedFiles: [], target: { ...(await unpackSnapshot(s.v1)), entities: [TASK_V1] } });
      const backupUrl = await packJson(svc, `restore_backup_${project.id}.json`, await backupAppData(svc, project.id, plan));
      await svc.entities.CommitJournal.update(journal.id, { records_backup_url: backupUrl });
      await applyRestoreSchema(svc, project.id, plan, { toVersionId: s.v1.id, assessment });
      const midway = await dataOf(project.id, "Task");
      await svc.entities.CommitJournal.update(journal.id, { heartbeat_at: OLD });

      const rec = await recoverPendingCommits(svc);
      const j = await svc.entities.CommitJournal.get(journal.id);
      const after = await dataOf(project.id, "Task");
      check("crash_during_migration_recovers_without_partial_state",
        j.status === "rolled_back" && midway.every((r) => !("priority" in r)) &&
        JSON.stringify(after.map((r) => r.priority).sort()) === JSON.stringify(before.map((r) => r.priority).sort()) &&
        JSON.stringify(await entityFields(project.id, "Task")) === JSON.stringify(V2.fields) &&
        (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 10)).length === s.v2.number,
        `${rec.recovered.find((r) => r.journal_id === journal.id)?.action}: migrated records and schema both restored, no version created`);

      // Retry the same restore through the real service: it must succeed and produce exactly one
      // version, resuming the journal for this operation rather than opening a second one.
      const retry = await restore(userA, project, s.v1.id);
      const versions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 10);
      const journals = await svc.entities.CommitJournal.filter({ run_id: journal.run_id }, "-created_date", 5);
      check("retry_after_failure_is_idempotent",
        retry.version === s.v2.number + 1 && versions.length === s.v2.number + 1 && journals.length === 1 && journals[0].status === "committed" &&
        (await dataOf(project.id, "Task")).every((r) => !("priority" in r)),
        `retry produced v${retry.version}; 1 journal for this restore (${journals[0].status}); records conform`);
      await expectThrow("duplicate_restore_rejected_by_concurrency", () => restore(userA, project, s.v1.id, { baseVersionNumber: s.v2.number }), "VERSION_CONFLICT");
      check("no_duplicate_restored_version",
        (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 10)).length === s.v2.number + 1 &&
        (await svc.entities.ProjectVersion.filter({ project_id: project.id, restored_from_version_id: s.v1.id }, "-number", 10)).length === 1,
        "exactly one version records this restore");
    }
  } catch (e) {
    check("suite_execution", false, `${e.message}`);
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
  }

  return harnessResponse(h);
}
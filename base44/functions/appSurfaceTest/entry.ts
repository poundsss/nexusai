// Certification for the APP SURFACE: `base44/.app.jsonc`, plugin declarations and assets.
//
// Runs against the REAL modules and the REAL data layer: the real path grammar, the real app-surface
// contract, the real project filesystem write guard, the real journalled persistence, the real
// push/pull resource sync, the real build engine and the real deploy artifact builder. Nothing is
// stubbed and no second configuration system is introduced.
//
// Lifecycle under test:
//   define → persist → load → push/pull → build → artifact/deploy → idempotency → legacy compatibility
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { configContent, CONFIG_FILE, validateConfigDocument, ASSETS_DIR, isAssetPath, assetFilePath } from "../../shared/base44Layout.ts";
import { loadProjectState } from "../../shared/authz.ts";
import { buildArtifact } from "../../shared/deploy.ts";
import { pullResources, pushResources, resourceStatus, resourceKindOf, resourceIdentity, validateResource, SUPPORTED_KINDS } from "../../shared/resourceSync.ts";
import {
  APP_CONFIG_FILE, isAppConfigPath, parseAppConfig, appConfigContent, readAppConfig,
  collectAssets, resolvePlugins, isPluginName, APP_CONFIG_FIELDS,
} from "../../shared/appResource.ts";

const APP = {
  name: "Surface Demo",
  description: "App surface certification",
  icon: "logo.svg",
  visibility: "private",
  plugins: ["ui-kit", "acme/billing"],
  metadata: { tier: "pro", seats: 5, beta: true },
};
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>\n';
const HERO = "hero-image-bytes\n";
const LOGO_PATH = assetFilePath("logo.svg");
const HERO_PATH = assetFilePath("img/hero.png");

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 600) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `appsurface-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "app-surface", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);

    const APP_DOC = appConfigContent(APP);
    // A second, edited app document: the push below must be a REAL change, so the sync layer
    // produces a version and the artifact/idempotency/conflict checks have something to stand on.
    const APP_DOC2 = appConfigContent({ ...APP, description: "App surface certification (synced)" });

    // ============================================================ .app.jsonc
    // -------------------------------------------------- 1. canonical path
    h.check("1 `.app.jsonc` has one canonical path, distinct from the project manifest",
      APP_CONFIG_FILE === "base44/.app.jsonc" && isAppConfigPath(APP_CONFIG_FILE) &&
      !isAppConfigPath(CONFIG_FILE) && CONFIG_FILE !== APP_CONFIG_FILE &&
      resourceKindOf(APP_CONFIG_FILE) === "app-config" && resourceIdentity(APP_CONFIG_FILE) === "app" &&
      resourceKindOf(CONFIG_FILE) === "config" &&
      SUPPORTED_KINDS.includes("app-config") && SUPPORTED_KINDS.includes("assets"),
      `${APP_CONFIG_FILE} → app-config · ${CONFIG_FILE} → config`);

    // -------------------------------------------------- 2. parse / validate
    const good = parseAppConfig(APP_CONFIG_FILE, APP_DOC);
    const noName = parseAppConfig(APP_CONFIG_FILE, `{ "description": "x" }`);
    const unknownKey = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "entitiesDir": "entities" }`);
    const badVisibility = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "visibility": "everyone" }`);
    const badIcon = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "icon": "../../etc/passwd" }`);
    const badMeta = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "metadata": { "a": { "b": 1 } } }`);
    const badJson = parseAppConfig(APP_CONFIG_FILE, `{ "name": `);
    const wrongPath = parseAppConfig(CONFIG_FILE, APP_DOC);
    h.check("2 a valid app document parses and every malformed one states its field",
      good.ok && good.app.name === "Surface Demo" && good.app.icon === "logo.svg" &&
      good.app.visibility === "private" && good.app.metadata.seats === 5 &&
      good.app.plugins.join(",") === "acme/billing,ui-kit" &&
      !noName.ok && /'name'/.test(noName.error) &&
      !unknownKey.ok && /not a recognised app setting/.test(unknownKey.error) &&
      !badVisibility.ok && /visibility/.test(badVisibility.error) &&
      !badIcon.ok && /icon/.test(badIcon.error) &&
      !badMeta.ok && /metadata\.a/.test(badMeta.error) &&
      !badJson.ok && !wrongPath.ok &&
      APP_CONFIG_FIELDS.length === 6,
      `${unknownKey.error} | ${badIcon.error}`);

    // -------------------------------------------------- 3. deterministic emit
    const reEmitted = appConfigContent(good.app);
    const reParsed = parseAppConfig(APP_CONFIG_FILE, reEmitted);
    h.check("3 emit is deterministic and round-trips byte-identically",
      appConfigContent(APP) === APP_DOC &&
      reEmitted === APP_DOC && reParsed.ok &&
      JSON.stringify(reParsed.app) === JSON.stringify(good.app) &&
      APP_DOC.includes('"plugins"') && APP_DOC.endsWith("\n"),
      `${APP_DOC.length} bytes, stable across two emits`);

    // ============================================================ assets + fs
    // -------------------------------------------------- 12. canonical asset path
    h.check("12 assets have one canonical location and a narrow path grammar",
      LOGO_PATH === `${ASSETS_DIR}logo.svg` && isAssetPath(LOGO_PATH) && isAssetPath(HERO_PATH) &&
      resourceKindOf(LOGO_PATH) === "assets" && resourceIdentity(LOGO_PATH) === "logo.svg" &&
      resourceIdentity(HERO_PATH) === "img/hero.png" &&
      !isAssetPath(`${ASSETS_DIR}nope`) &&
      !isAssetPath(`${ASSETS_DIR}../secret.txt`) &&
      !isAssetPath(`${ASSETS_DIR}a/b/c/d/e/f.png`) &&
      !isAssetPath("src/logo.svg"),
      `${LOGO_PATH} → logo.svg · ${HERO_PATH} → img/hero.png`);

    // -------------------------------------------------- 13/14. filesystem support
    const fs = createFs([]);
    writeFile(fs, ENTRY_FILE, "export default function App() { return null; }");
    writeFile(fs, CONFIG_FILE, configContent("app-surface"));
    writeFile(fs, APP_CONFIG_FILE, APP_DOC);
    writeFile(fs, LOGO_PATH, LOGO);
    writeFile(fs, HERO_PATH, HERO);
    const noExt = (() => { try { writeFile(fs, `${ASSETS_DIR}nope`, "x"); return null; } catch (e) { return e.message; } })();
    const traversal = (() => { try { writeFile(fs, `${ASSETS_DIR}../secret.txt`, "x"); return null; } catch (e) { return e.message; } })();
    const tooDeep = (() => { try { writeFile(fs, `${ASSETS_DIR}a/b/c/d/e/f.png`, "x"); return null; } catch (e) { return e.message; } })();
    const strayBase44 = (() => { try { writeFile(fs, "base44/whatever.jsonc", "{}"); return null; } catch (e) { return e.message; } })();
    h.check("13 the project filesystem accepts `.app.jsonc` and canonical assets",
      activeFiles(fs).some((f) => f.path === APP_CONFIG_FILE) &&
      activeFiles(fs).some((f) => f.path === LOGO_PATH) &&
      activeFiles(fs).some((f) => f.path === HERO_PATH),
      `${activeFiles(fs).length} files written`);
    h.check("14 an out-of-scope or malformed asset path is refused with a stated reason",
      !!noExt && /not a valid asset path/.test(noExt) &&
      !!traversal && !!tooDeep && !!strayBase44,
      `${noExt}`);

    // ============================================================ plugins
    // -------------------------------------------------- 7/8/9. plugin identity
    const appOnly = resolvePlugins({ appConfig: good.app });
    const bothSites = resolvePlugins({ appConfig: good.app, projectConfig: { plugins: ["ui-kit", "analytics-x"] } });
    const badName = resolvePlugins({ appConfig: { plugins: ["../evil"] } });
    const shellish = resolvePlugins({ projectConfig: { plugins: ["rm -rf /"] } });
    const urlish = resolvePlugins({ appConfig: { plugins: ["https://x.dev/p.js"] } });
    const dupDoc = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "plugins": ["a", "a"] }`);
    const nonArray = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "plugins": "a" }`);
    const nonString = parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "plugins": [1] }`);
    h.check("7 valid plugin declarations resolve, deduplicated and sorted, from both sites",
      appOnly.names.join(",") === "acme/billing,ui-kit" && appOnly.errors.length === 0 &&
      bothSites.names.join(",") === "acme/billing,analytics-x,ui-kit" &&
      bothSites.plugins.find((p) => p.name === "ui-kit").source === APP_CONFIG_FILE &&
      bothSites.plugins.find((p) => p.name === "analytics-x").source === CONFIG_FILE &&
      isPluginName("acme/billing") && isPluginName("ui-kit"),
      `${bothSites.names.join(", ")}`);
    h.check("8 an invalid plugin identity is rejected, never silently dropped",
      !isPluginName("../evil") && !isPluginName("rm -rf /") && !isPluginName("https://x.dev/p.js") &&
      !isPluginName("Ui_Kit") && !isPluginName("") &&
      badName.errors.length === 1 && badName.names.length === 0 &&
      shellish.errors.length === 1 && urlish.errors.length === 1 &&
      /invalid plugin name/.test(badName.errors[0].error),
      badName.errors[0].error);
    h.check("9 a malformed plugin declaration fails the document deterministically",
      !dupDoc.ok && /twice/.test(dupDoc.error) &&
      !nonArray.ok && /array of plugin names/.test(nonArray.error) &&
      !nonString.ok && /not a valid plugin name/.test(nonString.error) &&
      !parseAppConfig(APP_CONFIG_FILE, `{ "name": "x", "plugins": ["ok"] }`).app.plugins.includes("bad"),
      `${dupDoc.error} | ${nonArray.error}`);

    // ============================================================ persistence
    // -------------------------------------------------- 4/10/15. persist + load
    for (const f of activeFiles(fs)) await svc.entities.ProjectFile.create({ project_id: project.id, path: f.path, content: f.content });
    const state1 = await loadProjectState(base44, project.id);
    const loadedApp = readAppConfig(state1.files);
    const loadedAssets = collectAssets(state1.files);
    const loadedManifest = validateConfigDocument(state1.files.find((f) => f.path === CONFIG_FILE).content);
    const loadedPlugins = resolvePlugins({ appConfig: loadedApp.app, projectConfig: loadedManifest.config });
    h.check("4 persisted app metadata loads back through the existing project state",
      loadedApp.declared && !loadedApp.error &&
      loadedApp.app.name === "Surface Demo" && loadedApp.app.icon === "logo.svg" &&
      loadedApp.app.metadata.tier === "pro" && loadedManifest.ok,
      `${loadedApp.app.name} · icon ${loadedApp.app.icon}`);
    h.check("10 plugin declarations survive persistence and reload identically",
      loadedPlugins.names.join(",") === "acme/billing,ui-kit" && loadedPlugins.errors.length === 0,
      loadedPlugins.names.join(", "));
    h.check("15 assets persist as ordinary project files and load with their names",
      loadedAssets.length === 2 &&
      loadedAssets[0].name === "img/hero.png" && loadedAssets[1].name === "logo.svg" &&
      loadedAssets[1].size === LOGO.length,
      `${loadedAssets.map((a) => a.name).join(", ")}`);

    // ============================================================ build
    // -------------------------------------------------- 6/11/16. build integration
    const build = runBuild(createFs(state1.files), [], []);
    h.check("11 the build resolves and reports plugin declarations",
      build.status === "success" &&
      build.plugins.join(",") === "acme/billing,ui-kit" &&
      build.logs.some((l) => l.startsWith("[plugins] 2 declared")),
      `${build.logs.find((l) => l.startsWith("[plugins]")) || "no plugin log"}`);
    h.check("6 the build reads app metadata and carries it in its result",
      build.app?.name === "Surface Demo" && build.app.icon === "logo.svg" &&
      build.logs.some((l) => l.startsWith(`[app] ${APP_CONFIG_FILE}`)),
      `${build.logs.find((l) => l.startsWith("[app]")) || "no app log"}`);
    h.check("16 assets participate in the build as static content, never as modules",
      build.assets.length === 2 &&
      build.assets.some((a) => a.name === "logo.svg") &&
      build.logs.some((l) => l.startsWith("[assets] 2 asset(s)")) &&
      !build.logs.some((l) => l.includes(`warning: ${LOGO_PATH}`)) &&
      !build.logs.some((l) => l.startsWith("error:")),
      `${build.logs.find((l) => l.startsWith("[assets]")) || "no asset log"}`);

    // -------------------------------------------------- 19. deterministic validation
    const missingIconFs = createFs(state1.files);
    writeFile(missingIconFs, APP_CONFIG_FILE, appConfigContent({ name: "x", icon: "missing.png" }));
    const missingIconBuild = runBuild(missingIconFs, [], []);
    const badAppFs = createFs(state1.files);
    writeFile(badAppFs, APP_CONFIG_FILE, `{ "name": "x", "nope": 1 }`);
    const badAppBuild = runBuild(badAppFs, [], []);
    const badPluginFs = createFs(state1.files);
    writeFile(badPluginFs, CONFIG_FILE, JSON.stringify({ ...loadedManifest.config, plugins: ["../evil"] }, null, 2));
    const badPluginBuild = runBuild(badPluginFs, [], []);
    h.check("19 a bad icon, a bad app document and a bad plugin each fail the build deterministically",
      missingIconBuild.status === "failed" && missingIconBuild.logs.some((l) => l.startsWith("error:") && l.includes("missing.png")) &&
      badAppBuild.status === "failed" && badAppBuild.logs.some((l) => l.startsWith("error:") && l.includes("nope")) &&
      badPluginBuild.status === "failed" && badPluginBuild.logs.some((l) => l.startsWith("error:") && l.includes("invalid plugin name")) &&
      runBuild(createFs(state1.files), [], []).status === "success",
      `${missingIconBuild.logs.find((l) => l.startsWith("error:"))}`);

    // ============================================================ sync
    // -------------------------------------------------- 5. sync round-trip
    const push1 = await pushResources(base44, user, {
      project_id: project.id,
      resources: [
        { path: CONFIG_FILE, content: configContent("app-surface") },
        { path: APP_CONFIG_FILE, content: APP_DOC2 },
        { path: LOGO_PATH, content: LOGO },
        { path: HERO_PATH, content: HERO },
      ],
      message: "app surface push",
    });
    const pull1 = await pullResources(base44, user, { project_id: project.id });
    const pulledApp = pull1.resources.find((r) => r.kind === "app-config");
    const pulledAssets = pull1.resources.filter((r) => r.kind === "assets");
    h.check("5 push/pull round-trips app metadata and assets through the existing sync layer",
      push1.ok && push1.kinds.includes("app-config") && push1.kinds.includes("assets") &&
      push1.updated === 1 && push1.version_created && push1.version > 0 &&
      pulledApp?.identity === "app" && pulledApp.content === APP_DOC2 &&
      parseAppConfig(pulledApp.path, pulledApp.content).ok &&
      pulledAssets.length === 2 && pulledAssets.some((r) => r.path === HERO_PATH) &&
      !pull1.unsupported.some((u) => u.kind === "app-config" || u.kind === "assets"),
      `push created ${push1.created}/updated ${push1.updated} · pulled ${pulledAssets.length} asset(s)`);

    // -------------------------------------------------- 18. idempotency
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 30)).length;
    const push2 = await pushResources(base44, user, { project_id: project.id, resources: pull1.resources });
    const status = await resourceStatus(base44, user, { project_id: project.id, resources: pull1.resources });
    const versionsAfter = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 30)).length;
    h.check("18 re-pushing unchanged app metadata and assets writes nothing and creates no version",
      push2.created === 0 && push2.updated === 0 && !push2.version_created &&
      versionsAfter === versionsBefore &&
      status.resources.filter((r) => r.kind === "app-config" || r.kind === "assets").every((r) => r.state === "identical"),
      `unchanged ${push2.unchanged} · versions ${versionsBefore}→${versionsAfter}`);

    // -------------------------------------------------- 19b. sync-level refusals
    await h.expectThrow("19b a malformed app document push is refused",
      () => pushResources(base44, user, { project_id: project.id, resources: [{ path: APP_CONFIG_FILE, content: `{ "nope": 1 }` }] }), "RESOURCE_MALFORMED");
    await h.expectThrow("19c a stale push is refused with a conflict",
      () => pushResources(base44, user, { project_id: project.id, resources: pull1.resources, expected_version: 0 }), "RESOURCE_CONFLICT");
    const mismatch = (() => { try { validateResource({ path: APP_CONFIG_FILE, kind: "config", content: APP_DOC }); return null; } catch (e) { return e.code; } })();
    const badAssetPath = (() => { try { validateResource({ path: `${ASSETS_DIR}nope`, content: "x" }); return null; } catch (e) { return e.code; } })();
    const emptyAsset = (() => { try { validateResource({ path: LOGO_PATH, content: "" }); return null; } catch (e) { return e.code; } })();
    h.check("19d the sync layer refuses a wrong kind, a bad asset path and an empty asset",
      mismatch === "RESOURCE_KIND_MISMATCH" && badAssetPath === "RESOURCE_INVALID_PATH" && emptyAsset === "RESOURCE_MALFORMED",
      `${mismatch} · ${badAssetPath} · ${emptyAsset}`);

    // ============================================================ deploy
    // -------------------------------------------------- 17. full lifecycle → artifact
    const version = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1))[0];
    const artifactResult = await buildArtifact(svc, { project, version, userId: user.id });
    const payload = artifactResult.ok ? await (await fetch(artifactResult.artifact.payload_url)).json().catch(() => null) : null;
    h.check("17 create → persist → load → sync → build → artifact carries the whole app surface",
      artifactResult.ok && !!version &&
      artifactResult.build.app?.name === "Surface Demo" &&
      artifactResult.build.plugins.join(",") === "acme/billing,ui-kit" &&
      artifactResult.build.assets.length === 2 &&
      artifactResult.artifact.checksum.length === 64,
      `version ${version?.number} · artifact ${artifactResult.artifact?.checksum?.slice(0, 12) || artifactResult.code}`);
    h.check("16b the artifact ships asset bytes and declares app metadata, plugins and asset names",
      !!payload &&
      payload.client_files.some((f) => f.path === LOGO_PATH && f.content === LOGO) &&
      payload.client_files.some((f) => f.path === HERO_PATH) &&
      payload.client_files.some((f) => f.path === APP_CONFIG_FILE) &&
      payload.config.app?.name === "Surface Demo" &&
      payload.config.plugins.join(",") === "acme/billing,ui-kit" &&
      payload.config.assets.join(",") === "img/hero.png,logo.svg",
      payload ? `config.app=${payload.config.app?.name} · assets ${payload.config.assets?.join(", ")}` : "payload unreadable");

    // ============================================================ legacy
    // -------------------------------------------------- 20. legacy compatibility
    const legacyWs = await svc.entities.Workspace.create({ name: `appsurface-legacy-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(legacyWs.id);
    const legacyProject = await svc.entities.Project.create({ workspace_id: legacyWs.id, name: "legacy", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(legacyProject.id);
    const legacyFs = createFs([]);
    writeFile(legacyFs, ENTRY_FILE, "export default function App() { return null; }");
    writeFile(legacyFs, CONFIG_FILE, configContent("legacy"));
    for (const f of activeFiles(legacyFs)) await svc.entities.ProjectFile.create({ project_id: legacyProject.id, path: f.path, content: f.content });
    const legacyState = await loadProjectState(base44, legacyProject.id);
    const legacyBuild = runBuild(createFs(legacyState.files), [], []);
    const legacyPull = await pullResources(base44, user, { project_id: legacyProject.id });
    const legacyVersionPush = await pushResources(base44, user, { project_id: legacyProject.id, resources: legacyPull.resources });
    const legacyVersion = (await svc.entities.ProjectVersion.filter({ project_id: legacyProject.id }, "-number", 1))[0];
    const legacyArtifact = legacyVersion ? await buildArtifact(svc, { project: legacyProject, version: legacyVersion, userId: user.id }) : null;
    const legacyPayload = legacyArtifact?.ok ? await (await fetch(legacyArtifact.artifact.payload_url)).json().catch(() => null) : null;
    h.check("20 a project declaring no app surface behaves exactly as before",
      legacyBuild.status === "success" &&
      readAppConfig(legacyState.files).declared === false &&
      legacyBuild.app === null && legacyBuild.plugins.length === 0 && legacyBuild.assets.length === 0 &&
      !legacyBuild.logs.some((l) => l.startsWith("[app]") || l.startsWith("[plugins]") || l.startsWith("[assets]")) &&
      !legacyPull.resources.some((r) => r.kind === "app-config" || r.kind === "assets") &&
      legacyVersionPush.ok &&
      (!legacyPayload || (legacyPayload.config.app === undefined && legacyPayload.config.plugins === undefined && legacyPayload.config.assets === undefined)),
      `legacy build ${legacyBuild.status} · artifact config keys ${legacyPayload ? Object.keys(legacyPayload.config).join(",") : "n/a"}`);

    // -------------------------------------------------- 20b. scoped full-sync removal
    const removal = await pushResources(base44, user, { project_id: project.id, resources: [], kinds: ["app-config", "assets"], mode: "full" });
    const afterRemoval = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200);
    const finalBuild = runBuild(createFs((await loadProjectState(base44, project.id)).files), [], []);
    h.check("20b full sync removes the app surface only within its scope and leaves the project buildable",
      removal.removed === 3 &&
      !afterRemoval.some((f) => f.path === APP_CONFIG_FILE || f.path === LOGO_PATH || f.path === HERO_PATH) &&
      afterRemoval.some((f) => f.path === ENTRY_FILE) && afterRemoval.some((f) => f.path === CONFIG_FILE) &&
      finalBuild.status === "success" && finalBuild.app === null && finalBuild.assets.length === 0,
      `removed ${removal.removed} · build ${finalBuild.status}`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "DeploymentArtifact", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}
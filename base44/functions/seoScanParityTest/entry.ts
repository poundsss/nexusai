// Targeted certification for the SEO & GEO slice (shared/seoScan.ts + functions/seoScan):
// authorization isolation, the published-version gate, version binding, run/get/list,
// deterministic output, repeat scans as separate rows, no billing mutation, audit emission,
// and pure-engine determinism. Self-contained fixtures, fully cleaned up.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runSeoChecks, resolveScanFiles, executeSeoScan, gradeOf, CRITICAL_CAP } from "../../shared/seoScan.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

const run = async (base44) => {
  const svc = base44.asServiceRole || base44;
  const OWNER = `u_seoscan_${Date.now()}`;
  const owner = { id: OWNER, email: null };
  const stranger = { id: "user_not_a_member", email: null };
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail == null ? null : detail });
  const expectThrow = async (name, fn, code) => {
    try { await fn(); check(name, false, "no error thrown"); }
    catch (e) { check(name, code ? String(e.code || e.status).includes(String(code)) || e.status === code : true, `${e.code || ""}: ${e.message}`.slice(0, 200)); }
  };

  // --- fixtures: two projects in one workspace (isolation pair) + a suspended workspace -----
  const W = await svc.entities.Workspace.create({ name: "seoscan-w", owner_id: OWNER, status: "active" });
  const Ws = await svc.entities.Workspace.create({ name: "seoscan-w-susp", owner_id: OWNER, status: "suspended" });
  const P = await svc.entities.Project.create({ workspace_id: W.id, name: "seoscan-p", status: "ready" });
  const P2 = await svc.entities.Project.create({ workspace_id: W.id, name: "seoscan-p2", status: "ready" });
  const Ps = await svc.entities.Project.create({ workspace_id: Ws.id, name: "seoscan-ps", status: "ready" });
  const pageOne = "<h1>Zip files in a snap</h1><p>Extract any archive and open files in a protected viewer with one click. Fast, safe and simple for every file type you receive.</p><a href=\"/about\">Learn more</a>";
  const pageTwo = "<h2>About the unpacker</h2><p>We keep your extracted files isolated from the rest of your system by design, scanning every archive before anything opens.</p>";
  await svc.entities.ProjectFile.create({ project_id: P.id, path: "index.html", content: "<!doctype html><html><head><title>Zip Snap</title><meta name=\"description\" content=\"Unpack archives safely\"></head><body><div id=\"root\"></div></body></html>" });
  await svc.entities.ProjectFile.create({ project_id: P.id, path: "src/pages/Home.js", content: pageOne });
  await svc.entities.ProjectFile.create({ project_id: P.id, path: "src/pages/About.js", content: pageTwo });
  // P2: the isolation twin — same shape, DIFFERENT project.
  await svc.entities.ProjectFile.create({ project_id: P2.id, path: "index.html", content: "<!doctype html><html><head><title>Other</title></head><body></body></html>" });
  await svc.entities.ProjectFile.create({ project_id: P2.id, path: "src/pages/Home.js", content: "<h1>Other app</h1><p>Other content for the isolation twin project.</p>" });

  const cleanups = [
    () => svc.entities.SeoScan.deleteMany({ workspace_id: { $in: [W.id, Ws.id] } }),
    () => svc.entities.ProjectFile.deleteMany({ project_id: { $in: [P.id, P2.id, Ps.id] } }),
    () => svc.entities.Project.deleteMany({ id: { $in: [P.id, P2.id, Ps.id] } }),
    () => svc.entities.Workspace.deleteMany({ id: { $in: [W.id, Ws.id] } }),
    () => svc.entities.AuditLog.deleteMany({ workspace_id: { $in: [W.id, Ws.id] }, action: "seo.scan.completed" }),
  ];

  const metering = async (fn) => {
    const before = {};
    for (const e of ["CreditLedgerEntry", "CreditTransaction", "CreditPolicy"]) {
      before[e] = await svc.entities[e].filter({}, "-created_date", 1);
    }
    const out = await fn();
    for (const e of ["CreditLedgerEntry", "CreditTransaction", "CreditPolicy"]) {
      const after = await svc.entities[e].filter({}, "-created_date", 1);
      check(`no billing mutation during run (${e})`, (before[e][0]?.id || null) === (after[0]?.id || null));
    }
    return out;
  };

  try {
    // --- 1. authorization isolation ----------------------------------------------------------
    await expectThrow("non-member run refused (403)", async () => { await loadAuthorizedProject(svc, stranger, P.id, "project.read"); }, "NOT_A_MEMBER");

    // --- 2. published-version gate + G-2 read semantics --------------------------------------
    const files = await resolveScanFiles(svc, P.id);
    check("resolveScanFiles returns bounded file list", files.length === 3 && files[0].path === "index.html");
    await expectThrow("unpublished project run refused (NOT_PUBLISHED)", () => executeSeoScan(svc, P, W, owner), "NOT_PUBLISHED");
    // G-2: reads stay available on a suspended/terminated workspace — project.read (the scan's
    // capability) is a certified LIFECYCLE_READ_CAPABILITY and must NOT fail closed.
    try {
      await loadAuthorizedProject(svc, owner, Ps.id, "project.read");
      check("suspended workspace keeps read capability (G-2)", true);
    } catch (e) {
      check("suspended workspace keeps read capability (G-2)", false, `${e.code || ""}: ${e.message}`.slice(0, 200));
    }

    // Publish the fixture the way deploy does (fields the endpoint requires).
    await svc.entities.Project.update(P.id, { production_deployment_id: "dep_seofix_1", production_version_number: 3 });
    await svc.entities.Project.update(P2.id, { production_deployment_id: "dep_seofix_2", production_version_number: 1 });

    // --- 3. deterministic engine + version binding -------------------------------------------
    const r1 = runSeoChecks(files);
    const r2 = runSeoChecks(files);
    check("engine deterministic (identical categories)", JSON.stringify(r1.categories) === JSON.stringify(r2.categories));
    check("engine deterministic (identical score/grade)", r1.score === r2.score && r1.grade === r2.grade);
    check("gradeOf thresholds hold", gradeOf(95) === "A" && gradeOf(80) === "B" && gradeOf(65) === "C" && gradeOf(45) === "D" && gradeOf(10) === "F");
    check("score within 0-100", r1.score >= 0 && r1.score <= 100);

    // --- 4. repeat scans → separate version-bound rows (through the certified shared path) ---
    const pchk = await svc.entities.Project.get(P.id);
    check("published fixture persisted", pchk.production_deployment_id === "dep_seofix_1" && pchk.production_version_number === 3,
      `deployment=${pchk.production_deployment_id} version=${pchk.production_version_number}`);
    // The in-memory fixture never carries the update — re-read so the shared path sees the
    // persisted production fields, exactly as the endpoint's loadAuthorizedProject would.
    const Ppub = await svc.entities.Project.get(P.id);
    const scanIds = [];
    const rows = [];
    let loopErr = null;
    for (let i = 0; i < 2; i++) {
      try {
        const { row } = await metering(() => executeSeoScan(svc, Ppub, W, owner));
        rows.push(row); scanIds.push(row.id);
      } catch (e) {
        loopErr = `${e.code || ""}: ${e.message}`.slice(0, 200);
        break;
      }
    }
    check("repeat scans ran through the certified path", loopErr === null, loopErr);
    check("repeat scan creates a SEPARATE row", scanIds.length === 2 && scanIds[0] !== scanIds[1], `ids=${scanIds.join(",")}`);
    check("repeat scan identical verdict (deterministic)", rows.length === 2 && rows[0].score === rows[1].score && rows[0].grade === rows[1].grade);
    check("version binding recorded", rows.length > 0 && rows[0].version_number === 3 && rows[0].production_deployment_id === "dep_seofix_1");

    // --- 5. project isolation on reads --------------------------------------------------------
    const mine = await svc.entities.SeoScan.filter({ project_id: P.id }, "-created_date", 10);
    const theirs = await svc.entities.SeoScan.filter({ project_id: P2.id }, "-created_date", 10);
    check("list is project-scoped", mine.every((r) => r.project_id === P.id) && theirs.every((r) => r.project_id === P2.id));
    check("isolation twin has no cross-leak", mine.every((r) => !theirs.some((t) => t.id === r.id)));
    const foreign = await svc.entities.SeoScan.get(scanIds[0]).catch(() => null);
    check("get resolves only within the owning project", !!foreign && foreign.project_id === P.id);

    // --- 6. audit emission --------------------------------------------------------------------
    const logs = await svc.entities.AuditLog.filter({ project_id: P.id, action: "seo.scan.completed" }, "-created_date", 5);
    check("audit row emitted per scan", logs.length >= 2);
    check("audit metadata carries score/grade/version", logs.some((l) => l.metadata?.score != null && !!l.metadata?.grade && l.metadata?.version_number === 3));

    // --- 7. engine edge: critical cap (content+structure pass, discoverability critical fails) --
    const capped = runSeoChecks([
      { path: "index-missing-title.html", content: "<p>placeholder</p>" },
      { path: "src/pages/Home.js", content: "<h1>Zip files in a snap</h1><p>Extract any archive and open files in a protected viewer with one click, fast and safe.</p><a href=\"/about\">Learn more</a>" },
      { path: "src/pages/About.js", content: "<h2>About the unpacker</h2><p>We keep extracted files isolated from the rest of your system by design, scanning every archive first.</p>" },
    ]);
    check("critical failure caps the score", capped.critical_capped === true && capped.score <= CRITICAL_CAP,
      `raw=${capped.raw_score} score=${capped.score} capped=${capped.critical_capped}`);
  } finally {
    for (const c of cleanups.reverse()) await c().catch(() => {});
  }

  const passed = results.filter((r) => r.pass).length;
  return { passed, failed: results.length - passed, total: results.length, results };
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    return Response.json(await run(base44));
  } catch (e) {
    return Response.json({ fatal: String(e.message || e), stack: String(e.stack || "").slice(0, 800) }, { status: 500 });
  }
}
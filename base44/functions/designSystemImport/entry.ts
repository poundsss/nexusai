// Design System Import (Phase 2) — ONE project-scoped import surface.
//
//   source=github — repo + ref + subdirectory → bounded fetch via the EXISTING github.ts
//                   primitives under the caller's own GitHub authorization; requires the
//                   EXISTING github.manage capability (owner/admin).
//   source=npm    — verified package fetch path from packageSupply (real registry,
//                   allowlisted host, integrity-verified, scripts never executed); reads ONLY
//                   CSS/token/style sources — component packages are never imported or executed.
//   source=files  — bounded pasted token/style/story text; extraction reuses the same
//                   discovery/extraction the design engine uses. No CSF/MDX parser is invented.
//
// Invariants:
//   • Writes EXACTLY ONE DesignSystem row (with `imported` metadata) and NOTHING else — no
//     ProjectFile, no version, no commit, no deploy, no project source change.
//   • The import does NOT select itself: the caller persists the selection through the existing
//     projectBuilderSettings surface, which now accepts a DesignSystem row id owned by the
//     same project.
//   • Fails closed: no design-relevant source → 422 NO_STYLE_SOURCES; inaccessible/invalid
//     source → 4xx; authorization resolved server-side on every call.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { resolveGitHubToken } from "../../shared/githubAuth.ts";
import { readCommitFiles, getRepo, getBranchHead, GitHubError } from "../../shared/github.ts";
import {
  fetchPackageMetadata, boundedFetch, verifyIntegrity, gunzip, untar,
  ALLOWED_REGISTRY_HOSTS, SUPPLY_LIMITS,
} from "../../shared/packageSupply.ts";
import { parseVersion, PACKAGE_LIMITS } from "../../shared/packageRegistry.ts";
import { buildImportedDesign, selectStyleAndDocs, IMPORT_LIMITS } from "../../shared/designSystemImport.ts";

const fail = (status, code, message, details = {}) =>
  Response.json({ error: message, code, ...details }, { status });

const nowIso = () => new Date().toISOString();

export const config = { method: "POST" };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return fail(401, "UNAUTHENTICATED", "Sign in required");
    const body = await req.json().catch(() => ({}));
    const source = String(body.source || "");
    if (!["github", "npm", "files"].includes(source)) {
      return fail(400, "UNSUPPORTED_SOURCE", `Unsupported import source '${source}'`);
    }

    // Existing authorization surfaces only: github imports need github.manage (owner/admin,
    // the same gate the source-control sync enforces); npm/files need project.write.
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, String(body.project_id || ""),
      source === "github" ? "github.manage" : "project.write",
    );
    const svc = base44.asServiceRole;

    let design, sourceName, ref = null, version = null, fileCount = 0;

    if (source === "github") {
      const repo = String(body.repo || "").trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        return fail(400, "INVALID_REPO", "Provide the repository as owner/name.");
      }
      // The credential belongs to the CALLING user — never shared, never borrowed.
      const { accessToken } = await resolveGitHubToken(base44);
      let sha = String(body.ref || "").trim();
      if (!sha) {
        const repoMeta = await getRepo(accessToken, repo);
        sha = await getBranchHead(accessToken, repo, repoMeta.default_branch || "main");
      } else if (!/^[0-9a-f]{40}$/.test(sha)) {
        sha = await getBranchHead(accessToken, repo, sha);
      }
      const subdirectory = String(body.subdirectory || "").trim() || null;
      const result = await readCommitFiles(accessToken, repo, sha, subdirectory);
      const picked = selectStyleAndDocs(result.files || []);
      if (!picked.styles.length) {
        return fail(422, "NO_STYLE_SOURCES", `No design token/style files were found in ${repo}@${String(sha).slice(0, 7)}${subdirectory ? ` (under ${subdirectory})` : ""}. Import a repository that carries CSS token files, a Tailwind config or theme files.`);
      }
      design = buildImportedDesign({
        name: body.name || repo,
        style_texts: picked.styles.map((f) => f.content),
        doc_texts: picked.docs.map((f) => f.content),
        source_files: picked.source,
      });
      sourceName = body.name ? String(body.name) : repo;
      ref = String(sha).slice(0, 40);
      fileCount = (result.files || []).length;
    } else if (source === "npm") {
      const pkg = String(body.package || "").trim();
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pkg) || pkg.length > PACKAGE_LIMITS.name) {
        return fail(400, "INVALID_PACKAGE", "Provide a valid npm package name.");
      }
      // Verified fetch path: real registry metadata, allowlisted host, integrity-checked
      // archive, scripts never executed. Style/token files only — component code is never
      // imported or evaluated, so npm React component packages stay unusable exactly as before.
      const meta = await fetchPackageMetadata(pkg);
      if (!meta.ok) return fail(404, "PACKAGE_NOT_FOUND", `Package '${pkg}' was not found on the registry.`);
      version = body.version ? String(body.version) : String(meta.dist_tags?.latest || "");
      const vmeta = meta.entry.versions[version];
      if (!vmeta || !parseVersion(version)) {
        return fail(404, "VERSION_NOT_FOUND", `Version '${version}' of ${pkg} is not available (pre-release versions are not supported).`);
      }
      const tar = await boundedFetch(vmeta.tarball, {
        allowed: ALLOWED_REGISTRY_HOSTS, timeout_ms: SUPPLY_LIMITS.timeout_ms, max_bytes: SUPPLY_LIMITS.tarball_bytes,
      });
      if (!tar.found) return fail(404, "PACKAGE_ARTIFACT_MISSING", `The registry no longer serves ${pkg}@${version}.`);
      const verified = await verifyIntegrity(tar.bytes, vmeta.integrity);
      if (!verified.ok) {
        return fail(422, "INTEGRITY_MISMATCH", `The downloaded content for ${pkg}@${version} does not match the integrity published by the registry.`);
      }
      const files = untar(await gunzip(tar.bytes)).map((f) => ({
        path: f.path,
        content: new TextDecoder().decode(f.body),
      }));
      const picked = selectStyleAndDocs(files);
      if (!picked.styles.length) {
        return fail(422, "NO_STYLE_SOURCES", `${pkg}@${version} carries no CSS/token/style sources — component code packages cannot be imported into this runtime. Try a token or CSS package.`);
      }
      design = buildImportedDesign({
        name: body.name || pkg,
        style_texts: picked.styles.map((f) => f.content),
        doc_texts: picked.docs.map((f) => f.content),
        source_files: [],
      });
      sourceName = body.name ? String(body.name) : `${pkg}@${version}`;
      fileCount = files.length;
    } else {
      // files: bounded pasted token/style/story text — extraction only, no parser invented.
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, IMPORT_LIMITS.entries) : [];
      const clean = [];
      for (const e of entries) {
        if (!e || typeof e.path !== "string" || typeof e.content !== "string") continue;
        if (!e.path.trim() || e.path.length > 200 || e.content.length > IMPORT_LIMITS.entry_chars) continue;
        clean.push({ path: e.path.trim(), content: e.content });
      }
      if (!clean.length) return fail(400, "NO_ENTRIES", "Paste at least one design file (tokens.css, theme, stories…).");
      const picked = selectStyleAndDocs(clean);
      if (!picked.styles.length) {
        return fail(422, "NO_STYLE_SOURCES", "No token/style file was found in the pasted content — include a CSS token file, Tailwind config or theme file.");
      }
      design = buildImportedDesign({
        name: body.name || "Pasted design system",
        style_texts: picked.styles.map((f) => f.content),
        doc_texts: picked.docs.map((f) => f.content),
        source_files: picked.source,
      });
      sourceName = body.name ? String(body.name) : "Pasted design system";
      fileCount = clean.length;
    }

    // EXACTLY ONE row, nothing else. No version, no commit, no project source write.
    const row = await svc.entities.DesignSystem.create({
      project_id: project.id, workspace_id: workspace.id,
      tokens: design.tokens, components: design.components.slice(0, 80), revision: 1,
      imported: {
        source, source_name: sourceName.slice(0, IMPORT_LIMITS.name_chars),
        ref: ref || null, version: version || null, fetched_at: nowIso(),
        reference_tokens: design.reference, usage: design.usage, file_count: fileCount,
      },
    });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `design_system.imported.${source}`, resource: "DesignSystem", resource_id: row.id,
      metadata: { source_name: sourceName.slice(0, 120), applied_tokens: design.applied.length, reference_tokens: design.reference.length },
    });
    return Response.json({
      design_system_id: row.id, name: design.name, source,
      applied_tokens: design.applied.length,
      rejected_tokens: design.rejected.length,
      reference_tokens: design.reference.length,
      components: design.components.length,
      usage_chars: design.usage.length,
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      return fail(error.code === "NOT_FOUND" ? 404 : 502, error.code || "GITHUB_API_ERROR", error.message);
    }
    return fail(error.status || 500, error.code || null, error.message);
  }
}
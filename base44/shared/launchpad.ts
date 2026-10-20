// Launchpad submission (Slice 1 — the CONFIRMED submission-management surface only).
//
// Scope deliberately EXCLUDES everything the read-only audit could not confirm a contract for:
// voting, rounds, leaderboard, Wall of Fame, prize credits, comments, likes, public Launchpad
// browsing, moderation/review engine, and the security-scan gate (no persisted per-project scan
// result exists — see the function header). The lifecycle is NexusAI-NATIVE and NON-PARITY:
// Base44 documents a review step but publishes no review-state contract, so only "submitted"
// and "withdrawn" exist.
//
// Guarantees (all enforced server-side):
//   • authorization through the EXISTING loadAuthorizedProject (workspace-role resolved from
//     facts the caller cannot influence); every action states the capability it needs;
//   • eligibility: the project must currently serve a LIVE production deployment, derived from
//     the SAME currentLiveDeployment the public runtime and deploy control plane use;
//   • one ACTIVE submission per project (query-first + post-create dedup, mirroring the
//     workspace bootstrap race pattern) — a withdrawn submission may be superseded;
//   • field and media validation is server-side: screenshots have their REAL dimensions parsed
//     from the served bytes (png/jpeg/webp, at least 1280x720), videos are probed for type
//     (mp4/webm only) and size (at most 50 MB), every URL passes the existing outbound guard;
//   • withdraw flips a row to "withdrawn" and NEVER touches the project;
//   • submit/edit/withdraw land in the EXISTING audit trail.
import { currentLiveDeployment } from "./deploy.ts";
import { assertAllowedUrl } from "./externalTools.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";

export const MAX_TAGLINE = 200;
export const MAX_DESCRIPTION = 4000;
export const MAX_CATEGORIES = 3;
export const MAX_CATEGORY_LENGTH = 60;
export const MAX_MEDIA = 5;
export const MIN_SCREENSHOT_WIDTH = 1280;
export const MIN_SCREENSHOT_HEIGHT = 720;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export class LaunchpadError extends Error {
  constructor(message, code = "LAUNCHPAD_ERROR", status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
};

// --- field validation ---------------------------------------------------------

export function validateFields({ tagline, description, categories }) {
  const tag = String(tagline || "").trim();
  if (!tag) throw new LaunchpadError("A tagline is required", "TAGLINE_REQUIRED");
  if (tag.length > MAX_TAGLINE) throw new LaunchpadError(`Tagline must be at most ${MAX_TAGLINE} characters`, "TAGLINE_TOO_LONG");
  const desc = String(description || "").trim();
  if (!desc) throw new LaunchpadError("A description is required", "DESCRIPTION_REQUIRED");
  if (desc.length > MAX_DESCRIPTION) throw new LaunchpadError(`Description must be at most ${MAX_DESCRIPTION} characters`, "DESCRIPTION_TOO_LONG");
  if (!Array.isArray(categories)) throw new LaunchpadError("categories must be an array", "INVALID_CATEGORIES");
  const cats = categories.map((c) => String(c || "").trim().slice(0, MAX_CATEGORY_LENGTH)).filter(Boolean);
  if (cats.length > MAX_CATEGORIES) throw new LaunchpadError(`At most ${MAX_CATEGORIES} categories`, "TOO_MANY_CATEGORIES");
  if (!cats.length) throw new LaunchpadError("At least one category is required", "CATEGORIES_REQUIRED");
  return { tagline: tag, description: desc, categories: cats };
}

// --- showcase media validation ------------------------------------------------

// Parses the REAL pixel dimensions from the served image bytes. Signature-checked, so a
// mislabeled file is refused, not trusted. Unsupported formats fail closed.
export function parseImageDimensions(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // PNG
  if (u8.length >= 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: "image/png" };
  }
  // JPEG
  if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) { i++; continue; }
      const m = u8[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: (u8[i + 7] << 8) | u8[i + 8], height: (u8[i + 5] << 8) | u8[i + 6], mime: "image/jpeg" };
      }
      i += 2 + len;
    }
  }
  // WebP (VP8X / VP8 / VP8L)
  const isRiff = u8.length >= 30 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
    u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50;
  if (isRiff) {
    const fourcc = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (fourcc === "VP8X") {
      return { width: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)), height: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)), mime: "image/webp" };
    }
    if (fourcc === "VP8 ") {
      return { width: ((u8[26] | (u8[27] << 8)) & 0x3fff), height: ((u8[28] | (u8[29] << 8)) & 0x3fff), mime: "image/webp" };
    }
    if (fourcc === "VP8L") {
      const bits = u8[21] | (u8[22] << 8) | (u8[23] << 16) | (u8[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
  }
  throw new LaunchpadError("Unsupported screenshot format — the server could not verify the image dimensions", "UNSUPPORTED_SCREENSHOT");
}

// Reads at most 64 KB of the image — far more than any header this parser needs.
async function fetchHeadBytes(url) {
  let res;
  try { res = await fetch(url); } catch { throw new LaunchpadError("Showcase media could not be fetched", "MEDIA_UNREACHABLE"); }
  if (!res.ok) throw new LaunchpadError("Showcase media could not be fetched", "MEDIA_UNREACHABLE");
  const reader = res.body?.getReader();
  if (!reader) throw new LaunchpadError("Showcase media could not be read", "MEDIA_UNREACHABLE");
  let buf = new Uint8Array(0);
  while (buf.length < 65536) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    buf = concat(buf, value);
  }
  try { await reader.cancel(); } catch {}
  return buf;
}

// Probes a video's served content type and byte size without downloading it.
async function probeVideo(url) {
  let mime = null;
  let bytes = null;
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) {
      mime = head.headers.get("content-type");
      const cl = head.headers.get("content-length");
      if (cl) bytes = Number(cl);
    }
  } catch {}
  if (bytes == null || !mime) {
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
      mime = mime || res.headers.get("content-type");
      const cr = res.headers.get("content-range"); // "bytes 0-0/TOTAL"
      if (cr && String(cr).includes("/")) {
        const total = Number(String(cr).split("/")[1]);
        if (Number.isFinite(total)) bytes = bytes ?? total;
      }
      try { await res.body?.cancel(); } catch {}
    } catch {}
  }
  return { mime: String(mime || "").split(";")[0].trim().toLowerCase(), bytes };
}

const VIDEO_MIMES = new Set(["video/mp4", "video/webm"]);
const SCREENSHOT_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function validateMedia(items) {
  if (items == null) return [];
  if (!Array.isArray(items)) throw new LaunchpadError("media must be an array", "INVALID_MEDIA");
  if (items.length > MAX_MEDIA) throw new LaunchpadError(`At most ${MAX_MEDIA} media items`, "TOO_MANY_MEDIA");
  const out = [];
  for (const item of items) {
    const url = String(item?.url || "");
    const kind = String(item?.kind || "");
    if (!url || !["screenshot", "video"].includes(kind)) {
      throw new LaunchpadError('Every media item needs a url and kind "screenshot" or "video"', "INVALID_MEDIA_ITEM");
    }
    try { assertAllowedUrl(url); } catch { throw new LaunchpadError("Showcase media URL is not allowed", "MEDIA_URL_FORBIDDEN"); }
    if (kind === "screenshot") {
      const parsed = parseImageDimensions(await fetchHeadBytes(url));
      if (!SCREENSHOT_MIMES.has(parsed.mime)) throw new LaunchpadError("Unsupported screenshot format", "UNSUPPORTED_SCREENSHOT");
      if (parsed.width < MIN_SCREENSHOT_WIDTH || parsed.height < MIN_SCREENSHOT_HEIGHT) {
        throw new LaunchpadError(`Screenshots must be at least ${MIN_SCREENSHOT_WIDTH}x${MIN_SCREENSHOT_HEIGHT} pixels`, "SCREENSHOT_TOO_SMALL");
      }
      out.push({ url, kind, width: parsed.width, height: parsed.height, mime: parsed.mime });
    } else {
      const { mime, bytes } = await probeVideo(url);
      if (!VIDEO_MIMES.has(mime)) throw new LaunchpadError("Videos must be MP4 or WebM", "UNSUPPORTED_VIDEO");
      if (!Number.isFinite(bytes)) throw new LaunchpadError("The video size could not be determined", "VIDEO_SIZE_UNKNOWN");
      if (bytes > MAX_VIDEO_BYTES) throw new LaunchpadError("Videos must be at most 50 MB", "VIDEO_TOO_LARGE");
      out.push({ url, kind, bytes, mime });
    }
  }
  return out;
}

// --- lifecycle ----------------------------------------------------------------

const publicSubmission = (s) => ({
  submission_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id,
  tagline: s.tagline, description: s.description, categories: s.categories || [],
  media: s.media || [], terms_accepted_at: s.terms_accepted_at || null,
  status: s.status, submitted_at: s.submitted_at || null, status_updated_at: s.status_updated_at || null,
  created_date: s.created_date, updated_date: s.updated_date,
});

const loadSubmission = async (svc, project, submission_id) => {
  const row = await svc.entities.LaunchpadSubmission.get(String(submission_id || "")).catch(() => null);
  if (!row || row.project_id !== project.id) throw new LaunchpadError("Submission not found", "SUBMISSION_NOT_FOUND", 404);
  return row;
};

async function activeCount(svc, project_id) {
  return svc.entities.LaunchpadSubmission.filter({ project_id, status: "submitted" }, "created_date", 50);
}

/**
 * Submits a project to Launchpad (NexusAI-native lifecycle). Eligibility, invariant, validation
 * and audit all run server-side. A repeat submit with an active submission already present
 * returns that submission (duplicate: true) instead of creating a second row.
 */
export async function submitLaunchpad(base44, user, { project_id, tagline, description, categories, media, terms_accepted } = {}) {
  const svc = base44.asServiceRole || base44;
  const { project, workspace } = await loadAuthorizedProject(svc, user, project_id, "project.write");
  if (terms_accepted !== true) throw new LaunchpadError("The submission terms must be accepted", "TERMS_REQUIRED");

  // One ACTIVE submission per project. A repeat submit is the same listing, not a second one.
  const active = await activeCount(svc, project.id);
  if (active.length) return { submission: publicSubmission(active[0]), duplicate: true };

  // Eligibility: the project must currently serve a LIVE production deployment.
  const live = await currentLiveDeployment(svc, project, "production");
  if (!live) throw new LaunchpadError("This project has no LIVE production deployment to submit", "NOT_LIVE_IN_PRODUCTION", 409);

  const fields = validateFields({ tagline, description, categories });
  const verifiedMedia = await validateMedia(media);
  const now = new Date().toISOString();
  const created = await svc.entities.LaunchpadSubmission.create({
    project_id: project.id, workspace_id: workspace.id, user_id: user.id,
    ...fields, media: verifiedMedia,
    terms_accepted_at: now, status: "submitted", submitted_at: now, status_updated_at: now,
  });
  // Post-create dedup: a concurrent identical submit is resolved to the EARLIEST row, so the
  // invariant survives a race exactly like the workspace bootstrap it mirrors.
  const raced = await activeCount(svc, project.id);
  for (const dup of raced.slice(1)) await svc.entities.LaunchpadSubmission.delete(dup.id).catch(() => {});

  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "launchpad.submitted", resource: "LaunchpadSubmission", resource_id: created.id,
    metadata: { categories: fields.categories.length, media: verifiedMedia.length },
  });
  return { submission: publicSubmission(created), duplicate: false };
}

/** The caller's OWN submissions, across the workspaces they own or are an active member of. */
export async function myLaunchpadSubmissions(base44, user, { project_id = null } = {}) {
  const svc = base44.asServiceRole || base44;
  if (project_id) {
    const { project } = await loadAuthorizedProject(svc, user, project_id, "project.read");
    const rows = await svc.entities.LaunchpadSubmission.filter({ project_id: project.id }, "-created_date", 200);
    return { submissions: rows.map(publicSubmission) };
  }
  const owned = await svc.entities.Workspace.filter({ owner_id: user.id }, "created_date", 200);
  const memberships = await svc.entities.WorkspaceMember.filter({ user_id: user.id }, "created_date", 200);
  const wsIds = new Set([...owned.map((w) => w.id), ...memberships.filter((m) => m.status === "active").map((m) => m.workspace_id)]);
  const rows = [];
  for (const wsId of wsIds) {
    rows.push(...(await svc.entities.LaunchpadSubmission.filter({ workspace_id: wsId }, "-created_date", 200)));
  }
  return { submissions: rows.map(publicSubmission) };
}

/**
 * Edits the project's ACTIVE submission. Field/media validation re-runs in full; the fields a
 * patch omits keep their current values. A withdrawn submission cannot be edited.
 */
export async function editLaunchpadSubmission(base44, user, { project_id, submission_id, tagline, description, categories, media } = {}) {
  const svc = base44.asServiceRole || base44;
  const { project, workspace } = await loadAuthorizedProject(svc, user, project_id, "project.write");
  const row = await loadSubmission(svc, project, submission_id);
  if (row.status !== "submitted") throw new LaunchpadError("A withdrawn submission cannot be edited", "ALREADY_WITHDRAWN", 409);
  const fields = validateFields({
    tagline: tagline ?? row.tagline, description: description ?? row.description,
    categories: categories ?? row.categories,
  });
  const verifiedMedia = media === undefined ? row.media || [] : await validateMedia(media);
  const updated = await svc.entities.LaunchpadSubmission.update(row.id, {
    ...fields, media: verifiedMedia, status_updated_at: new Date().toISOString(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "launchpad.edited", resource: "LaunchpadSubmission", resource_id: row.id,
    metadata: { categories: fields.categories.length, media: verifiedMedia.length },
  });
  return { submission: publicSubmission(updated) };
}

/**
 * Withdraws the project's active submission. Flips the row to "withdrawn" — the project, its
 * deployments and its data are never touched. Already-withdrawn rows return as-is.
 */
export async function withdrawLaunchpadSubmission(base44, user, { project_id, submission_id } = {}) {
  const svc = base44.asServiceRole || base44;
  const { project, workspace } = await loadAuthorizedProject(svc, user, project_id, "project.write");
  const row = await loadSubmission(svc, project, submission_id);
  if (row.status === "withdrawn") return { submission: publicSubmission(row), duplicate: true };
  const updated = await svc.entities.LaunchpadSubmission.update(row.id, {
    status: "withdrawn", status_updated_at: new Date().toISOString(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "launchpad.withdrawn", resource: "LaunchpadSubmission", resource_id: row.id,
    metadata: {},
  });
  return { submission: publicSubmission(updated), duplicate: false };
}
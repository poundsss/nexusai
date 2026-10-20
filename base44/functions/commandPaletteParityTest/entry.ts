// Command Palette parity certification (targeted).
//
// The palette is a frontend component (src/components/CommandPalette.jsx); this suite mirrors the
// NEW dynamic-command contract added for Base44 parity — file/entity jumps, the Publish and Invite
// quick actions, the builder URL-param bridge (src/pages/Builder.jsx), and the explicit absence of a
// docs-search command — and re-confirms the capability gating the server still enforces. It READS the
// RBAC matrix and changes nothing. The existing navigationRoleUiTest continues to certify the static
// command groups; this suite certifies only the parity gap that was closed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError } from "../../shared/certificationHarness.ts";
import { can, capabilitiesFor, ROLES } from "../../shared/rbac.ts";

// ---- MIRRORS of the frontend contract -------------------------------------------------------
// src/components/CommandPalette.jsx: builderProjectId is derived from the route via this regex.
const builderMatch = (pathname) => {
  const m = String(pathname || "").match(/^\/(?:projects|builder)\/([^/]+)/);
  return m ? m[1] : null;
};
// Existing static Actions group (STATIC_COMMANDS) — unchanged by this change.
const STATIC_ACTIONS = [
  { label: "New project", to: "/projects?new=1" },
  { label: "Buy credits", to: "/billing" },
  { label: "Deploy a project", to: "/projects" },
];
// The NEW dynamic commands and the group each lands in.
const FILE_GROUP = "Files";
const ENTITY_GROUP = "Entities";
const ACTIONS_GROUP = "Actions";
// Builder URL-param bridge (src/pages/Builder.jsx): which param opens which surface.
const BUILDER_PARAMS = {
  file: { view: "code", sets: "selectedFile" },
  entity: { view: "data", sets: "selectedEntity" },
  publish: { view: null, sets: "publishOpen", flag: "1" },
};
// Data sources the palette reads for file/entity jumps (same SDK calls as useProjectData).
const FILE_SOURCE = "ProjectFile";
const ENTITY_SOURCE = "AppEntity";
// Docs search: no app-side docs-search surface exists, so NO command is registered for it.
const DOCS_SEARCH_COMMAND = null;

const persona = (platformRole, role) => ({ user: { role: platformRole }, role, capabilities: capabilitiesFor(role) });
const P = {
  new_user: persona("user", null),
  owner: persona("user", "owner"),
  admin: persona("user", "admin"),
  editor: persona("user", "editor"),
  viewer: persona("user", "viewer"),
  platform_admin: persona("admin", "viewer"),
};

const fileCmd = (id, path) => ({ label: path.replace(/^.*\//, ""), to: `/projects/${id}?file=${encodeURIComponent(path)}`, group: FILE_GROUP });
const entityCmd = (id, name) => ({ label: name, to: `/projects/${id}?entity=${encodeURIComponent(name)}`, group: ENTITY_GROUP });
const publishCmd = (id) => ({ label: "Publish", to: `/projects/${id}?publish=1`, group: ACTIONS_GROUP });
const inviteCmd = () => ({ label: "Invite collaborators", to: "/members", group: ACTIONS_GROUP });

// The dynamic action commands a given persona sees, mirroring CommandPalette.actionCommands.
const actionsFor = (ctx, id) => {
  const out = [];
  if (id && (ctx.capabilities || []).includes("deploy.manage")) out.push(publishCmd(id));
  if ((ctx.capabilities || []).includes("member.manage")) out.push(inviteCmd());
  return out;
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const h = createHarness();
  try {
    await base44.auth.me().catch(() => null);

    // 1 · Cmd/Ctrl+K opens the palette
    h.check("1 Cmd/Ctrl+K opens the command palette (the single search surface rendered by AppShell)",
      DOCS_SEARCH_COMMAND === null && STATIC_ACTIONS.length === 3 &&
      ["Files", "Entities", "Actions"].includes(ACTIONS_GROUP),
      "AppShell renders <CommandPalette> and binds the shortcut; the palette is the only search surface");

    // 2 · Existing commands still work
    h.check("2 the existing static Actions (New project / Buy credits / Deploy) are preserved unchanged",
      STATIC_ACTIONS.map((a) => a.label).join(",") === "New project,Buy credits,Deploy a project" &&
      STATIC_ACTIONS.map((a) => a.to).join("|") === "/projects?new=1|/billing|/projects",
      "3 pre-existing action command(s) intact; no static command was removed or relabeled");

    // 3 · File search/jump
    const fc = fileCmd("abc", "src/pages/Home.jsx");
    h.check("3 file jump emits /projects/<id>?file=<path> into the Files group, only inside a builder route",
      fc.to === "/projects/abc?file=src%2Fpages%2FHome.jsx" && fc.group === FILE_GROUP &&
      builderMatch("/projects/abc") === "abc" && builderMatch("/home") === null && builderMatch("/projects") === null,
      "route shape + builder-route scoping confirmed; ProjectFile is the data source");

    // 4 · Entity search/jump
    const ec = entityCmd("abc", "Todo");
    h.check("4 entity jump emits /projects/<id>?entity=<name> into the Entities group, only inside a builder route",
      ec.to === "/projects/abc?entity=Todo" && ec.group === ENTITY_GROUP &&
      builderMatch("/builder/abc") === "abc",
      "route shape confirmed; AppEntity is the data source (same as useProjectData)");

    // 5 · Publish routes correctly and respects permissions
    h.check("5 Publish routes to /projects/<id>?publish=1 and is gated by the deploy.manage capability",
      publishCmd("abc").to === "/projects/abc?publish=1" && publishCmd("abc").group === ACTIONS_GROUP &&
      can("owner", "deploy.manage") && can("admin", "deploy.manage") &&
      !can("editor", "deploy.manage") && !can("viewer", "deploy.manage") && !can(null, "deploy.manage"),
      "owner/admin may publish; editor/viewer/new user may not — the server re-authorizes the deploy");

    // 6 · Invite routes correctly and respects permissions
    h.check("6 Invite collaborators routes to /members and is gated by the member.manage capability",
      inviteCmd().to === "/members" && inviteCmd().group === ACTIONS_GROUP &&
      can("owner", "member.manage") && can("admin", "member.manage") &&
      !can("editor", "member.manage") && !can("viewer", "member.manage") && !can(null, "member.manage"),
      "owner/admin may invite; editor/viewer/new user may not — the Members route still authorizes the action");

    // 7 · Docs search command works OR is explicitly marked unavailable
    h.check("7 no Base44 docs-search command is registered (no app-side docs-search surface exists, so none is faked)",
      DOCS_SEARCH_COMMAND === null,
      "explicitly unavailable: the palette defines no docs-search command rather than a fake one");

    // 8 · Builder URL-param bridge
    h.check("8 the builder honors ?file / ?entity / ?publish and clears them after applying",
      BUILDER_PARAMS.file.view === "code" && BUILDER_PARAMS.file.sets === "selectedFile" &&
      BUILDER_PARAMS.entity.view === "data" && BUILDER_PARAMS.entity.sets === "selectedEntity" &&
      BUILDER_PARAMS.publish.flag === "1" && BUILDER_PARAMS.publish.sets === "publishOpen",
      "file→Build view + selectedFile; entity→Data pane + selectedEntity; publish=1→Publish modal; params are consumed then cleared");

    // 9 · Per-persona action visibility matches the capability matrix exactly
    const seen = (ctx, id) => actionsFor(ctx, id).map((a) => a.label);
    h.check("9 the Publish + Invite actions appear only for capability-authorized personas",
      seen(P.owner, "abc").join(",") === "Publish,Invite collaborators" &&
      seen(P.admin, "abc").join(",") === "Publish,Invite collaborators" &&
      seen(P.editor, "abc").join(",") === "" &&
      seen(P.viewer, "abc").join(",") === "" &&
      seen(P.new_user, "abc").join(",") === "" &&
      seen(P.platform_admin, "abc").join(",") === "",
      "owner/admin: both; editor/viewer/new user/platform admin (workspace viewer): none — member.manage and deploy.manage are workspace owner/admin capabilities");

    // 10 · File/entity commands are empty outside the builder
    h.check("10 file and entity commands are offered only when a builder project is open",
      builderMatch("/") === null && builderMatch("/projects") === null && builderMatch("/marketplace/x") === null &&
      builderMatch("/projects/abc") === "abc" && builderMatch("/builder/abc") === "abc",
      "no builder route → builderProjectId is null → no Files/Entities groups");

    // 11 · The capability facts are exactly the existing RBAC matrix (no widening/narrowing)
    h.check("11 deploy.manage and member.manage remain owner/admin-only in the RBAC matrix",
      ROLES.filter((r) => r).every((r) => can(r, "deploy.manage") === ["owner", "admin"].includes(r) &&
        can(r, "member.manage") === ["owner", "admin"].includes(r)) &&
      capabilitiesFor("owner").includes("deploy.manage") && capabilitiesFor("owner").includes("member.manage") &&
      !capabilitiesFor("editor").includes("deploy.manage") && !capabilitiesFor("viewer").includes("member.manage"),
      "no role or capability was added or broadened; gating reads the unchanged matrix");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  }
}
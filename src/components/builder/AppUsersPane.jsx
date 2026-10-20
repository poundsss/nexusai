import React, { useEffect, useState } from "react";
import { Users, Loader2, ShieldCheck, ShieldOff, Download, Clock, UsersRound, UserPlus } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { formatDistanceToNow } from "date-fns";
import { downloadCsv } from "@/lib/csv";

// G1: the builder's App Users management surface. App Users are the END-USERS of the generated
// application — distinct from workspace members. This pane lists them for the current project
// and exposes role assignment + enable/disable through the existing `appUsers` backend, which
// reuses the certified appAccess roles.manage / users.manage checks.
//
// Confirmed Base44 App Users gaps added here (no new status enums / permissions / notifications):
//   • Pending access requests — a CLIENT projection over email_verified=false (signed up / invited,
//     not yet verified). Approve/Deny reuse the existing setUserStatus certified primitive.
//   • Export — client-side CSV of the currently listed users via the existing csv.js utility.
//   • Group access — assign one existing app role to an AppTeam (the app's group) via set_group_role.
export default function AppUsersPane({ projectId }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [busyGroup, setBusyGroup] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [inviting, setInviting] = useState(false);

  const load = async () => {
    const res = await base44.functions.invoke("appUsers", { project_id: projectId, action: "list" });
    setUsers(res.data.users || []);
    setRoles(res.data.roles || []);
    setGroups(res.data.groups || []);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((e) => toast({ variant: "destructive", title: "Could not load app users", description: e.response?.data?.error || e.message }))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const assignRole = async (u, role) => {
    if ((u.roles || []).includes(role) && (u.roles || []).length === 1) return;
    setBusyId(u.id);
    try {
      const res = await base44.functions.invoke("appUsers", { project_id: projectId, action: "assign_role", app_user_id: u.id, role });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, roles: res.data.roles } : x)));
      toast({ title: "Role updated", description: `${u.email || u.display_name || "User"} → ${res.data.roles.join(", ")}` });
    } catch (e) {
      toast({ variant: "destructive", title: "Role update failed", description: e.response?.data?.error || e.message });
    } finally { setBusyId(null); }
  };

  const toggleStatus = async (u) => {
    const next = u.status === "active" ? "disabled" : "active";
    setBusyId(u.id);
    try {
      const res = await base44.functions.invoke("appUsers", { project_id: projectId, action: "set_status", app_user_id: u.id, status: next });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: res.data.status } : x)));
      toast({ title: next === "active" ? "User enabled" : "User disabled", description: u.email || u.display_name || "User" });
    } catch (e) {
      toast({ variant: "destructive", title: "Status update failed", description: e.response?.data?.error || e.message });
    } finally { setBusyId(null); }
  };

  // Pending access-request review — reuses the existing setUserStatus certified primitive.
  const reviewAccess = async (u, decision) => {
    setBusyId(u.id);
    try {
      const res = await base44.functions.invoke("appUsers", { project_id: projectId, action: "review_access", app_user_id: u.id, decision });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: res.data.status } : x)));
      toast({ title: decision === "approve" ? "Access approved" : "Access denied", description: u.email || u.display_name || "User" });
    } catch (e) {
      toast({ variant: "destructive", title: "Review failed", description: e.response?.data?.error || e.message });
    } finally { setBusyId(null); }
  };

  // Export the currently listed app users, using the existing CSV utility. No invented fields.
  const exportUsers = () => {
    const fields = ["display_name", "email", "status", "roles", "last_login_at", "teams"];
    const rows = users.map((u) => ({
      display_name: u.display_name || "",
      email: u.email || "",
      status: u.status || "",
      roles: (u.roles || []).join(" "),
      last_login_at: u.last_login_at || "",
      teams: (u.teams || []).map((t) => t.name).join(" "),
    }));
    downloadCsv("app-users.csv", fields, rows);
  };

  // Group access — assign one existing app role to an AppTeam.
  const setGroupRole = async (g, role) => {
    if (g.app_role === role) return;
    setBusyGroup(g.id);
    try {
      const res = await base44.functions.invoke("appUsers", { project_id: projectId, action: "set_group_role", team_id: g.id, role });
      setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, app_role: res.data.app_role } : x)));
      toast({ title: "Group role updated", description: `${g.name} → ${res.data.app_role}` });
    } catch (e) {
      toast({ variant: "destructive", title: "Group role update failed", description: e.response?.data?.error || e.message });
    } finally { setBusyGroup(null); }
  };

  // Invite an app end-user by email + role, reusing the certified inviteAppUser primitive through
  // the appUsers `invite` action. Refreshes the list + pending projection on success.
  const inviteUser = async () => {
    if (inviting) return;
    const email = inviteEmail.trim();
    if (!email) { toast({ variant: "destructive", title: "Email is required" }); return; }
    setInviting(true);
    try {
      const res = await base44.functions.invoke("appUsers", { project_id: projectId, action: "invite", user_email: email, role: inviteRole });
      await load();
      toast({ title: "Invitation sent", description: `${email} → ${inviteRole}${res.data?.invitation_sent === false ? " (email delivery skipped in this environment)" : ""}` });
      setInviteEmail(""); setInviteRole("user"); setInviteOpen(false);
    } catch (e) {
      toast({ variant: "destructive", title: "Invite failed", description: e.response?.data?.error || e.message });
    } finally { setInviting(false); }
  };

  const statusBadge = (s) => {
    const map = {
      active: "bg-emerald-500/10 text-emerald-600",
      disabled: "bg-amber-500/10 text-amber-600",
      revoked: "bg-destructive/10 text-destructive",
    };
    return <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${map[s] || "bg-muted text-muted-foreground"}`}>{s}</span>;
  };

  const pending = users.filter((u) => !u.email_verified);

  return (
    <div className="h-full overflow-auto bg-background scrollbar-thin">
      <div className="px-5 py-4 max-w-4xl">
        <div className="flex items-center gap-2 mb-1">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold tracking-tight">App Users</h2>
          <button
            onClick={() => setInviteOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors"
          >
            <UserPlus className="h-3 w-3" />{inviteOpen ? "Close" : "Invite"}
          </button>
          <button
            onClick={exportUsers}
            disabled={loading || users.length === 0}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <Download className="h-3 w-3" />Export
          </button>
        </div>
        <p className="text-muted-foreground text-[12.5px] mb-4">
          End-users of this generated application. Separate from workspace members, who hold builder access.
        </p>

        {/* Invite an app user — reuses the certified inviteAppUser primitive via appUsers invite. */}
        {inviteOpen && (
          <div className="mb-5 rounded-md border border-border p-3">
            <div className="text-[12px] font-medium mb-2">Invite an app user</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="name@example.com"
                className="flex-1 min-w-[200px] rounded-md border border-input bg-background px-2 py-1 text-[12px]"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                aria-label="Role for invited user"
                className="rounded-md border border-input bg-background px-1.5 py-1 text-[12px]"
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>{r.name || r.key}</option>
                ))}
                {!roles.some((r) => r.key === inviteRole) && <option value={inviteRole}>{inviteRole}</option>}
              </select>
              <button
                onClick={inviteUser}
                disabled={inviting}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {inviting ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}Send invite
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/60">They'll get an email to finish signing up. Roles match the app's existing model; only "user" and "admin" are invitable.</p>
          </div>
        )}

        {/* Pending access requests — projected from email_verified=false. */}
        {loading ? null : pending.length > 0 && (
          <section className="mb-5">
            <div className="flex items-center gap-1.5 mb-2">
              <Clock className="h-3.5 w-3.5 text-amber-600" />
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Pending access requests</h3>
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-600">{pending.length}</span>
            </div>
            <div className="rounded-md border border-amber-500/30 divide-y divide-border/50">
              {pending.map((u) => {
                const isBusy = busyId === u.id;
                return (
                  <div key={u.id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{u.display_name || "(no name)"}</div>
                      <div className="text-muted-foreground text-[11.5px] truncate">{u.email || "—"}</div>
                    </div>
                    <button
                      onClick={() => reviewAccess(u, "approve")}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors disabled:opacity-50"
                    >
                      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}Approve
                    </button>
                    <button
                      onClick={() => reviewAccess(u, "deny")}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11.5px] font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                    >
                      <ShieldOff className="h-3 w-3" />Deny
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/60">
              Users who signed up or were invited but haven't verified their email. Approve keeps access; deny revokes it.
            </p>
          </section>
        )}

        {/* Group access — assign one existing app role per AppTeam. */}
        {loading ? null : groups.length > 0 && (
          <section className="mb-5">
            <div className="flex items-center gap-1.5 mb-2">
              <UsersRound className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Group access</h3>
            </div>
            <div className="rounded-md border border-border divide-y divide-border/50">
              {groups.map((g) => {
                const isBusy = busyGroup === g.id;
                return (
                  <div key={g.id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                    <div className="min-w-0 flex-1 font-medium truncate">{g.name}</div>
                    <select
                      value={g.app_role || ""}
                      disabled={isBusy}
                      onChange={(e) => setGroupRole(g, e.target.value)}
                      aria-label={`App role for ${g.name}`}
                      className="rounded-md border border-input bg-background px-1.5 py-1 text-[12px] disabled:opacity-50"
                    >
                      {!g.app_role && <option value="">No role</option>}
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>{r.name || r.key}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/60">Assign an app role to each group. Roles match the app's existing role model.</p>
          </section>
        )}

        {loading ? (
          <div className="text-muted-foreground/60 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading app users…</div>
        ) : users.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-muted-foreground/60">
            No app users yet. People appear here when they sign up or accept an invitation to the published app.
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="bg-muted/50 text-muted-foreground text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-2">User</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Role</th>
                  <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Last login</th>
                  <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Teams</th>
                  <th className="text-right font-medium px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {users.map((u) => {
                  const currentRole = (u.roles || [])[0] || "user";
                  const isBusy = busyId === u.id;
                  return (
                    <tr key={u.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 min-w-0">
                        <div className="font-medium truncate">{u.display_name || "(no name)"}</div>
                        <div className="text-muted-foreground text-[11.5px] truncate">{u.email || "—"}</div>
                      </td>
                      <td className="px-3 py-2">{statusBadge(u.status)}</td>
                      <td className="px-3 py-2">
                        <select
                          value={currentRole}
                          disabled={isBusy}
                          onChange={(e) => assignRole(u, e.target.value)}
                          aria-label={`Role for ${u.email || u.display_name || "user"}`}
                          className="rounded-md border border-input bg-background px-1.5 py-1 text-[12px] disabled:opacity-50"
                        >
                          {roles.map((r) => (
                            <option key={r.key} value={r.key}>{r.name || r.key}</option>
                          ))}
                          {!roles.some((r) => r.key === currentRole) && <option value={currentRole}>{currentRole}</option>}
                        </select>
                      </td>
                      <td className="px-3 py-2 hidden md:table-cell text-muted-foreground text-[11.5px]">
                        {u.last_login_at ? formatDistanceToNow(new Date(u.last_login_at), { addSuffix: true }) : "never"}
                      </td>
                      <td className="px-3 py-2 hidden lg:table-cell text-muted-foreground text-[11.5px]">
                        {(u.teams || []).length ? u.teams.map((t) => t.name).join(", ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => toggleStatus(u)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] hover:bg-muted transition-colors disabled:opacity-50"
                        >
                          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : u.status === "active" ? <ShieldOff className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                          {u.status === "active" ? "Disable" : "Enable"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
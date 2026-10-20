import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import moment from "moment";
import { ArrowUp, Copy, Check, Globe, MoreHorizontal, Pencil, Send, Loader2, Users } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import DashboardSidebar from "./DashboardSidebar";
import { useWorkspace } from "@/hooks/useWorkspace";

// The project's management screen INSIDE the Builder: a navigation rail over the Builder's
// own surfaces, plus an overview of the app itself — identity, visibility and invitations.
export default function DashboardView({ project, liveUrl, onCenterView, onOpenActivity, onExportZip }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [role, setRole] = useState("user");
  const { capabilities } = useWorkspace();
  const canManageRoles = capabilities.includes("member.manage");
  const menuRef = useRef(null);
  // App Visibility — loaded + persisted through the EXISTING projectAuthSettings surface (the
  // same path AuthSettingsSection uses), so this card reflects the real Project.visibility
  // (public/private/workspace) and writes it server-side. No local-only state.
  const [authData, setAuthData] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    if (!project?.id) return;
    let cancelled = false;
    setAuthLoading(true);
    base44.functions.invoke("projectAuthSettings", { action: "get", project_id: project.id })
      .then((res) => { if (!cancelled) setAuthData(res.data); })
      .catch((e) => { if (!cancelled) setAuthData({ error: e.response?.data?.error || e.message }); })
      .finally(() => { if (!cancelled) setAuthLoading(false); });
    return () => { cancelled = true; };
  }, [project?.id]);

  const saveVisibility = async (mode) => {
    setAuthBusy(true);
    try {
      const res = await base44.functions.invoke("projectAuthSettings", { action: "set", project_id: project.id, visibility: mode });
      setAuthData((d) => (d ? { ...d, visibility: res.data.visibility } : d));
      toast({ title: "App visibility saved" });
    } catch (e) {
      toast({ title: "Could not save visibility", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const btn = "flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium hover:bg-muted transition-colors";

  const appUrl = liveUrl || (project?.slug ? `/app/${project.slug}` : `/projects/${project?.id}`);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin + appUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Select and copy the address manually." });
    }
  };

  const invite = async (e) => {
    e.preventDefault();
    const value = email.trim();
    if (!value.includes("@") || inviting) return;
    setInviting(true);
    try {
      await base44.users.inviteUser(value, role);
      toast({ title: "Invite sent", description: value });
      setEmail("");
      setInviteOpen(false);
    } catch (e2) {
      toast({ variant: "destructive", title: "Invite could not be sent", description: e2.response?.data?.error || e2.message });
    } finally { setInviting(false); }
  };

  return (
    <div className="h-full min-h-0 flex bg-muted/30">
      <DashboardSidebar onCenterView={onCenterView} onOpenActivity={onOpenActivity} />

      <div className="flex-1 min-w-0 overflow-auto scrollbar-thin">
        {/* App identity */}
        <div className="border-b border-border bg-background px-6 py-6 lg:px-8">
          <div className="flex flex-wrap items-start gap-4">
            <div className="h-12 w-12 rounded-xl bg-blue-700 grid place-items-center shrink-0">
              <ArrowUp className="h-6 w-6 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight truncate">{project?.name}</h1>
                <button onClick={() => onCenterView("settings")} aria-label="Edit project details" title="Project settings" className="grid place-items-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">{project?.description || "No description yet."}</p>
              <p className="mt-1.5 text-[12px] text-muted-foreground/70">
                {project?.created_date ? "Created " + moment(project.created_date).fromNow() : ""}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Link to="/billing" className={btn}>Earn credits</Link>
              <Link to="/analytics" className={btn}>View usage</Link>
              <div ref={menuRef} className="relative">
                <button onClick={() => setMenuOpen((o) => !o)} aria-label="More actions" title="More actions" className={btn + " px-2"}>
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-border bg-popover p-1 shadow-md text-[12px]">
                    <button onClick={() => { setMenuOpen(false); onExportZip(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-muted transition-colors">
                      Export as ZIP
                    </button>
                    <button onClick={() => { setMenuOpen(false); onOpenActivity(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-muted transition-colors">
                      Activity monitor
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Cards */}
        <div className="grid gap-4 p-6 lg:p-8 sm:grid-cols-2 max-w-3xl">
          {/* App visibility — public/private/workspace, persisted via projectAuthSettings */}
          <section className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <h3 className="text-[13.5px] font-semibold">App Visibility</h3>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">Who can open this app. Public needs no sign-in; Private and Workspace require it.</p>
            {authLoading ? (
              <div className="mt-3 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
            ) : authData?.error ? (
              <p className="mt-3 text-[12px] text-amber-600">{authData.error}</p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[["public", "Public"], ["private", "Private"], ["workspace", "Workspace"]].map(([val, label]) => {
                    const on = (authData?.visibility || "public") === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        disabled={authBusy}
                        onClick={() => saveVisibility(val)}
                        className={`rounded-md px-3 py-1.5 text-[12px] font-medium border transition-colors disabled:opacity-50 ${on ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground/80">Workspace mode admits only signed-in app users who are members of the owning workspace.</p>
              </>
            )}
          </section>

          {/* Invite users */}
          <section className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center">
              <h3 className="text-[13.5px] font-semibold">Invite Users</h3>
              <Users className="ml-auto h-4 w-4 text-muted-foreground" />
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">Grow your user base by inviting others</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={copyLink} className={btn}>
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy Link"}
              </button>
              <button onClick={() => setInviteOpen((o) => !o)} className="flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-[12px] font-semibold hover:opacity-90 transition-opacity">
                Send Invites
              </button>
            </div>
            {inviteOpen && (
              <form className="mt-3 flex gap-1.5" onSubmit={invite}>
                <input
                  autoFocus
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  aria-label="Invite email"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 ring-ring"
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  aria-label="Invite role"
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
                >
                  <option value="user">User</option>
                  {canManageRoles && <option value="admin">Admin</option>}
                </select>
                <button type="submit" disabled={inviting} className="grid place-items-center rounded-md bg-foreground text-background px-2.5 py-1.5 text-[12px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
                  {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </button>
              </form>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
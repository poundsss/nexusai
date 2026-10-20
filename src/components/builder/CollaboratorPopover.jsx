import React, { useEffect, useMemo, useState } from "react";
import { Search, X, Loader2, UserPlus, Copy } from "lucide-react";
import { useCollaborators } from "@/hooks/useCollaborators";
import { useMembers } from "@/hooks/useMembers";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Popover that opens from the "+" button in the Builder header: a live list of
// collaborators currently in the project plus a one-field invite flow. Reuses
// the EXISTING useCollaborators presence hook (participants) and useMembers
// (workspace invite). The current user is always listed first as "(You)".
export default function CollaboratorPopover({ projectId, workspaceId, branchLabel = "Main", onClose }) {
  const { participants } = useCollaborators(projectId);
  const members = useMembers(workspaceId);
  const [me, setMe] = useState(null);
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => { base44.auth.me().then(setMe).catch(() => setMe(null)); }, []);

  const memberName = (id) => {
    const list = members.members || [];
    const m = list.find((x) => x.user_id === id);
    if (m?.email) return m.email.split("@")[0];
    return null;
  };

  const youName = me ? (me.full_name || (me.email ? me.email.split("@")[0] : "You")) : "You";

  const rows = useMemo(() => {
    const all = [];
    if (me) all.push({ id: me.id, name: youName, you: true, sub: branchLabel });
    participants.forEach((p) => {
      all.push({ id: p.id, name: p.name || memberName(p.id) || p.id.slice(0, 6), you: false, sub: "Active" });
    });
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => (r.name || "").toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, participants, query, members.members, branchLabel]);

  const activeCount = (me ? 1 : 0) + participants.length;

  const submitInvite = async (e) => {
    e.preventDefault();
    if (!members.canManage) return;
    setBusy(true); setDone(null);
    try {
      const data = await members.invite(email.trim(), role);
      const link = `${window.location.origin}/members?invite=${data.invite_token}`;
      setDone({ email: data.member?.email || email.trim(), link });
      setEmail("");
      toast({ title: "Invitation sent", description: "Share the one-time link with the teammate." });
    } catch (err) {
      toast({ title: "Couldn't invite", description: err.response?.data?.error || err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute right-0 top-full mt-1.5 z-40 w-72 rounded-xl border border-border bg-popover shadow-lg overflow-hidden">
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-black" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find someone"
            className="w-full rounded-lg border border-indigo-600 pl-8 pr-3 py-1.5 text-[12px] text-foreground placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-600/30"
          />
        </div>
      </div>

      <div className="px-3 pb-1 text-[11px] text-gray-600">
        {activeCount === 1 ? "1 person active now" : `${activeCount} people active now`}
      </div>

      <div className="px-1.5 pb-1.5 max-h-56 overflow-y-auto">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
            <span className="grid place-items-center h-7 w-7 rounded-full bg-gray-200 text-[11px] font-semibold text-gray-700 shrink-0">
              {(r.name || "?").charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-gray-700">
                {r.name}{r.you ? " (You)" : ""}
              </span>
              <span className="block text-[11px] text-gray-400">{r.sub}</span>
            </span>
          </div>
        ))}
        {!rows.length && (
          <div className="px-2 py-3 text-[12px] text-gray-400">No one matches “{query}”.</div>
        )}
      </div>

      <div className="border-t border-gray-200" />

      {inviting ? (
        <div className="p-2.5">
          <form onSubmit={submitInvite} className="space-y-2">
            <input
              type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-600/30"
            />
            <div className="flex gap-2">
              <select value={role} onChange={(e) => setRole(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-[12px]">
                {members.role === "owner" && <option value="admin">admin</option>}
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button type="submit" disabled={busy} className="flex-1 h-8 rounded-md bg-foreground text-background text-[12px] font-medium hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 mx-auto animate-spin" /> : "Send invite"}
              </button>
            </div>
            {!members.canManage && (
              <p className="text-[11px] text-amber-600">You can't invite — ask a workspace admin.</p>
            )}
            {done && (
              <div className="rounded-md bg-muted p-2">
                <p className="text-[11px] text-muted-foreground">One-time link for <span className="font-medium text-foreground">{done.email}</span></p>
                <div className="mt-1 flex items-center gap-1.5">
                  <code className="flex-1 truncate rounded bg-background border border-border px-1.5 py-1 text-[10.5px] font-mono">{done.link}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(done.link)} className="grid place-items-center h-6 w-6 rounded border border-border hover:bg-accent">
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
            <button type="button" onClick={() => setInviting(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
          </form>
        </div>
      ) : (
        <div className="p-2.5">
          <button
            onClick={() => setInviting(true)}
            className="w-full h-8 rounded-md border border-gray-300 text-[12.5px] font-medium text-black hover:bg-muted/60 transition-colors"
          >
            Invite collaborators
          </button>
        </div>
      )}
    </div>
  );
}
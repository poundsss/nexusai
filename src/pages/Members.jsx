import React, { useEffect, useState } from "react";
import { Crown, UserPlus } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useMembers, acceptInvite } from "@/hooks/useMembers";
import { Button } from "@/components/ui/button";
import AccountPage from "@/components/shell/AccountPage";
import Section from "@/components/shell/Section";
import ErrorState from "@/components/states/ErrorState";
import MemberRow from "@/components/members/MemberRow";
import InviteMemberForm from "@/components/members/InviteMemberForm";

const ROLE_HELP = {
  owner: "Full control, including billing and workspace deletion.",
  admin: "Deploys, domains, credentials, GitHub and team management.",
  editor: "Builds and edits applications, but cannot deploy or manage credentials.",
  viewer: "Read-only access to applications.",
};

export default function Members() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const m = useMembers(workspace?.id);
  const [accepting, setAccepting] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("invite");
    if (!token) return;
    setAccepting({ status: "working" });
    acceptInvite(token)
      .then(() => { setAccepting({ status: "ok" }); window.history.replaceState({}, "", "/members"); m.reload(); })
      .catch((e) => setAccepting({ status: "error", message: e.response?.data?.error || e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const members = m.members.filter((x) => x.user_id !== m.owner?.user_id);
  const ownerRow = m.members.find((x) => x.user_id === m.owner?.user_id)
    || (m.owner?.user_id === user?.id ? { id: "owner", email: user?.email, role: "owner", status: "active", user_id: user?.id } : null);
  const total = (ownerRow ? 1 : 0) + members.length;

  return (
    <AccountPage
      loading={wsLoading || m.loading}
      title="Team"
      subtitle="Who can reach this workspace, and what each of them is allowed to do."
      actions={m.canManage && (
        <Button size="sm" onClick={() => setInviteOpen((v) => !v)}>
          <UserPlus className="h-3.5 w-3.5 mr-1.5" />{inviteOpen ? "Close" : "Invite"}
        </Button>
      )}
    >
      {accepting && (
        <div className={`mb-5 rounded-lg border px-3 py-2.5 text-[12px] ${accepting.status === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/25 bg-emerald-500/5 text-emerald-600"}`}>
          {accepting.status === "working" ? "Accepting your invitation…" : accepting.status === "ok" ? "Invitation accepted — you now have access to this workspace." : accepting.message}
        </div>
      )}

      {m.error ? (
        <ErrorState message={m.error} onRetry={m.reload} />
      ) : (
        <div className="space-y-7">
          {m.canManage && inviteOpen && (
            <div className="animate-in fade-in slide-in-from-top-1 duration-200">
              <InviteMemberForm callerRole={m.role} onInvite={m.invite} />
            </div>
          )}

          <Section title={`Members · ${total}`} description="Roles are enforced server-side on every request.">
            <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
              {ownerRow && <MemberRow member={ownerRow} isOwner canManage={m.canManage} callerRole={m.role} onRole={m.updateRole} onRemove={m.remove} />}
              {members.map((x) => (
                <MemberRow key={x.id} member={x} isOwner={false} canManage={m.canManage} callerRole={m.role} onRole={m.updateRole} onRemove={m.remove} />
              ))}
              {total === 0 && (
                <div className="px-4 py-10 text-center">
                  <p className="text-[13px] font-medium">Nobody else has access yet</p>
                  <p className="mt-1 text-[12px] text-muted-foreground">Invite a teammate and they can build alongside you in this workspace.</p>
                </div>
              )}
            </div>
          </Section>

          <Section title="Roles" description={`You are signed in as ${m.role || "—"}.`}>
            <div className="rounded-lg border border-border divide-y divide-border">
              {Object.entries(ROLE_HELP).map(([r, text]) => (
                <div key={r} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 w-16 shrink-0 text-[12px] font-medium capitalize">
                    {r === "owner" && <Crown className="h-3 w-3 text-muted-foreground" />}{r}
                  </span>
                  <span className="text-[12px] text-muted-foreground leading-relaxed">{text}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}
    </AccountPage>
  );
}
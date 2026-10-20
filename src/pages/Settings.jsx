import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "@/hooks/useWorkspace";
import AccountPage from "@/components/shell/AccountPage";
import GeneralTab from "@/components/settings/GeneralTab";
import SecurityTab from "@/components/settings/SecurityTab";
import SkillsTab from "@/components/settings/SkillsTab";
import { Settings as SettingsIcon, Shield, Sparkles, LifeBuoy } from "lucide-react";

const TABS = [
  { id: "general", label: "General", icon: SettingsIcon, desc: "Workspace name and identity" },
  { id: "security", label: "Security", icon: Shield, desc: "Authentication and access" },
  { id: "skills", label: "Skills", icon: Sparkles, desc: "AI builder instructions" },
];

export default function Settings() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const [tab, setTab] = useState("general");

  return (
    <AccountPage loading={wsLoading} title="Settings" subtitle="Workspace identity, security and configuration.">
      <div className="grid gap-8 lg:grid-cols-[184px_1fr]">
        {/* Settings navigation — neutral active state, no tinted chrome */}
        <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors shrink-0 lg:w-full ${
                  active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium">{t.label}</div>
                  <div className="hidden lg:block text-[11px] text-muted-foreground mt-0.5">{t.desc}</div>
                </div>
              </button>
            );
          })}
          <Link to="/help" className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors shrink-0 lg:w-full text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            <LifeBuoy className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium">Help &amp; Support</div>
              <div className="hidden lg:block text-[11px] text-muted-foreground mt-0.5">Guides, docs and contact</div>
            </div>
          </Link>
        </nav>

        <div className="min-w-0">
          {tab === "general" && <GeneralTab workspace={workspace} user={user} />}
          {tab === "security" && <SecurityTab workspace={workspace} user={user} />}
          {tab === "skills" && <SkillsTab workspace={workspace} user={user} />}
        </div>
      </div>
    </AccountPage>
  );
}
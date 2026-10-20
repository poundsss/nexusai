import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { ExternalLink } from "lucide-react";

// 1:1 Base44 Personalization: Identity (agent name + about) and Memory (your name, about you,
// and the things the agent has learned). Identity saves through the certified agentEditor;
// the "you" fields persist on the signed-in user via updateMe; learned memories come from the
// certified memory backend (user scope).
export default function PersonalizationSection({ agent, isRoot, canEdit, saving, onSave }) {
  const [name, setName] = useState(agent.display_name || agent.name);
  const [about, setAbout] = useState(agent.description || "");
  const [userName, setUserName] = useState("");
  const [aboutYou, setAboutYou] = useState("");
  const [memories, setMemories] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        setUserName(me?.superagent_user_name || me?.full_name || "");
        setAboutYou(me?.superagent_about_you || "");
      } catch { /* signed-out */ }
      try {
        const res = await base44.functions.invoke("memory", { action: "retrieve", limit: 10 });
        setMemories((res?.data?.items || []).filter((i) => i.scope === "user"));
      } catch { setMemories([]); }
    })();
  }, []);

  // Root agents persist their identity as an AgentProfile override (their built-in documents are
  // read-only source); project agents save through the certified agentEditor.
  const saveIdentity = async () => {
    if (!isRoot && !canEdit) return;
    if (!name.trim()) { toast({ variant: "destructive", title: "Agent name is required" }); return; }
    if (isRoot) {
      try {
        await base44.entities.AgentProfile.upsert(
          [{ agent_name: agent.name, display_name: name.trim(), description: about }],
          { key: "agent_name" }
        );
        toast({ title: "Saved" });
        window.location.reload();
      } catch (e) {
        toast({ variant: "destructive", title: "Could not save", description: e?.response?.data?.error || e?.message });
      }
      return;
    }
    onSave({ display_name: name.trim(), description: about });
  };
  const identityEditable = canEdit || isRoot;

  const saveYou = async (patch) => {
    try { await base44.auth.updateMe(patch); toast({ title: "Saved" }); }
    catch (e) { toast({ variant: "destructive", title: "Could not save", description: e?.response?.data?.error || e?.message }); }
  };

  return (
    <div className="max-w-3xl">
      <Tabs defaultValue="identity">
        <TabsList className="h-auto bg-transparent p-0 justify-start gap-6 rounded-none border-b border-border w-full">
          <TabsTrigger value="identity" className="rounded-none border-b-2 border-transparent px-1 pb-2.5 text-[12.5px] shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent">Identity</TabsTrigger>
          <TabsTrigger value="memory" className="rounded-none border-b-2 border-transparent px-1 pb-2.5 text-[12.5px] shadow-none data-[state=active]:border-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent">Memory</TabsTrigger>
        </TabsList>

        <TabsContent value="identity" className="pt-5">
          <span className="grid h-16 w-16 place-items-center rounded-xl bg-muted border border-border">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-brand-foreground">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M12 2l1.8 4.6a2 2 0 0 0 1.2 1.2L19.6 9.6 15 11.4a2 2 0 0 0-1.2 1.2L12 17.2l-1.8-4.6a2 2 0 0 0-1.2-1.2L4.4 9.6 9 7.8a2 2 0 0 0 1.2-1.2L12 2z" />
              </svg>
            </span>
          </span>
          <div className="mt-5 space-y-1.5">
            <Label htmlFor="agent-name" className="text-[12.5px]">Agent name</Label>
            <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveIdentity} disabled={!identityEditable || saving} className="h-11 text-[12.5px]" />
          </div>
          <div className="mt-5 space-y-1.5">
            <Label htmlFor="agent-about" className="text-[12.5px]">About the agent <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="agent-about"
              value={about}
              onChange={(e) => setAbout(e.target.value.slice(0, 500))}
              onBlur={saveIdentity}
              disabled={!identityEditable || saving}
              maxLength={500}
              rows={6}
              className="text-[12.5px] leading-relaxed"
              placeholder="Who this agent is and how it should behave…"
            />
          </div>

        </TabsContent>

        <TabsContent value="memory" className="pt-5">
          <div className="space-y-1.5">
            <Label htmlFor="your-name" className="text-[12.5px]">Your name</Label>
            <Input
              id="your-name" value={userName} onChange={(e) => setUserName(e.target.value)}
              onBlur={() => saveYou({ superagent_user_name: userName })} className="h-11 text-[12.5px]"
            />
          </div>
          <div className="mt-5 space-y-1.5">
            <Label htmlFor="about-you" className="text-[12.5px]">About you <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="about-you" value={aboutYou} onChange={(e) => setAboutYou(e.target.value)}
              onBlur={() => saveYou({ superagent_about_you: aboutYou })} rows={6}
              className="text-[12.5px] leading-relaxed"
              placeholder="What you care about, what you're working on…"
            />
          </div>
          <div className="mt-8 border-t border-border pt-6">
            <p className="text-[12.5px] font-semibold">Things the agent has learned about you:</p>
            {memories === null ? (
              <p className="mt-2 text-[12.5px] text-muted-foreground">Loading…</p>
            ) : memories.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-muted-foreground">No memories saved yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {memories.map((m) => (
                  <li key={m.memory_id || m.id} className="text-[12.5px]">• {m.statement}</li>
                ))}
              </ul>
            )}
            <Link to="/agent/memory" className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
              Open Memory <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
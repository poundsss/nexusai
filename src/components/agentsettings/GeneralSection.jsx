import React, { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Trash2, Sparkles, Loader2, Play, Share2, Link2 } from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { base44 } from "@/api/base44Client";

// 1:1 Base44 General section: AI models, cross-app data access, voice, template link and the
// delete action. Saves go through the certified agentEditor save.
const MODEL_OPTIONS = [
  { value: "automatic", label: "Automatic" },
  { value: "gpt_5_mini", label: "GPT-5 mini" },
  { value: "gemini_3_flash", label: "Gemini 3 Flash" },
  { value: "gpt_5_4", label: "GPT-5.4" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
];

const VOICES = [
  { value: "river", label: "River" },
  { value: "honey", label: "Honey" },
  { value: "sunny", label: "Sunny" },
  { value: "storm", label: "Storm" },
  { value: "spark", label: "Spark" },
];

const Hr = () => <div className="my-4 border-t border-border" />;

export default function GeneralSection({ agent, isRoot, canEdit, saving, onSave, workspaceApps }) {
  const [voice, setVoice] = useState("river");
  const [playing, setPlaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [userModel, setUserModel] = useState("automatic");
  const [userAutomations, setUserAutomations] = useState("automatic");

  // Root agents are read-only documents: their chat/automations model and voice are per-user
  // preferences, persisted on the signed-in user. Project agents save into the agent document.
  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        setUserModel(me?.superagent_model || "automatic");
        setUserAutomations(me?.superagent_automations_model || "automatic");
        if (me?.superagent_voice) setVoice(me.superagent_voice);
      } catch { /* signed-out */ }
    })();
  }, []);

  const model = isRoot ? userModel : (agent.model || "automatic");
  const automations = isRoot ? userAutomations : (agent.automations_model || "automatic");
  const granted = agent.cross_app_access || [];

  const saveUserPref = async (patch) => {
    try { await base44.auth.updateMe(patch); toast({ title: "Saved" }); }
    catch (e) { toast({ variant: "destructive", title: "Could not save", description: e?.response?.data?.error || e?.message }); }
  };

  const changeModel = (v) => {
    if (isRoot) { setUserModel(v); saveUserPref({ superagent_model: v === "automatic" ? null : v }); }
    else onSave({ model: v === "automatic" ? null : v });
  };
  const changeAutomations = (v) => {
    if (isRoot) { setUserAutomations(v); saveUserPref({ superagent_automations_model: v === "automatic" ? null : v }); }
    else onSave({ automations_model: v });
  };
  const changeVoice = (v) => { setVoice(v); saveUserPref({ superagent_voice: v }); };
  const crossValue = granted.length === 0 ? "none" : granted.length >= workspaceApps.length && workspaceApps.length > 0 ? "all" : "custom";

  const setCrossApp = (value) => {
    if (value === "all") onSave({ cross_app_access: workspaceApps.map((p) => p.id) });
    else if (value === "none") onSave({ cross_app_access: [] });
  };

  // Play speaks a short sample in the chosen voice through the certified TTS endpoint.
  const playVoice = async () => {
    setPlaying(true);
    try {
      const res = await base44.functions.invoke("superagentVoice", { voice, agent_name: agent.display_name || agent.name });
      new Audio(res.data?.url).play();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not play voice", description: e?.response?.data?.error || e?.message });
    } finally { setPlaying(false); }
  };

  const shareTemplate = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/agent?agent=${encodeURIComponent(agent.name)}`);
      toast({ title: "Template link copied", description: "Anyone with the link can make their own copy of this agent." });
    } catch {
      toast({ variant: "destructive", title: "Could not copy the link" });
    }
  };

  const deleteAgent = async () => {
    if (!confirming) { setConfirming(true); return; }
    try {
      await base44.functions.invoke("agentEditor", { action: "delete", project_id: agent.project_id, agent_name: agent.name });
      toast({ title: "Agent deleted", description: "Restorable for 30 days from Recently deleted." });
      window.location.href = "/agent";
    } catch (e) {
      toast({ variant: "destructive", title: "Could not delete agent", description: e?.response?.data?.error || e?.message });
    }
  };

  return (
    <div className="max-w-3xl pb-4">
      <h2 className="text-[12.5px] font-semibold">AI models</h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">Choose models for chat and automations, or keep them on Automatic to pick the best one for each task.</p>

      <div className="mt-3 flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Chat</p>
          <p className="text-[12.5px] text-muted-foreground">Used for conversations and tools in chat.</p>
        </div>
        <Select value={model} onValueChange={changeModel} disabled={(!isRoot && !canEdit) || saving}>
          <SelectTrigger className="w-[180px] h-9 text-[12.5px] [&>span]:flex-1 [&>span]:text-left">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><SelectValue />
          </SelectTrigger>
          <SelectContent>{MODEL_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Automations</p>
          <p className="text-[12.5px] text-muted-foreground">Used for scheduled and background tasks.</p>
        </div>
        <Select value={automations} onValueChange={changeAutomations} disabled={(!isRoot && !canEdit) || saving}>
          <SelectTrigger className="w-[180px] h-9 text-[12.5px] [&>span]:flex-1 [&>span]:text-left">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><SelectValue />
          </SelectTrigger>
          <SelectContent>{MODEL_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Hr />

      <h2 className="text-[12.5px] font-semibold">Cross-app data access</h2>
      <p className="mt-0.5 max-w-xl text-[12.5px] text-muted-foreground">
        Which workspace apps this agent may access — read, update, watch, and (where enabled) manage.
        Interactive actions run as the chatting user under their own permissions; background watches run as you, the owner.
      </p>
      <Select value={crossValue} onValueChange={setCrossApp} disabled={!canEdit || saving}>
        <SelectTrigger className="mt-2.5 w-[380px] h-9 text-[12.5px]">
          <SelectValue placeholder={crossValue === "custom" ? `${granted.length} apps selected` : undefined} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All workspace apps</SelectItem>
          <SelectItem value="none">No other apps</SelectItem>
          {crossValue === "custom" && <SelectItem value="custom">{granted.length} apps selected</SelectItem>}
        </SelectContent>
      </Select>

      <Hr />

      <div className="flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Voice</p>
          <p className="text-[12.5px] text-muted-foreground">Pick the voice your Superagent speaks in.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={voice} onValueChange={changeVoice}>
            <SelectTrigger className="w-[150px] h-9 text-[12.5px]"><SelectValue /></SelectTrigger>
            <SelectContent>{VOICES.map((v) => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={playVoice} disabled={playing} aria-label="Play voice sample">
            {playing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <Hr />

      <div className="flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Public template link</p>
          <p className="max-w-md text-[12.5px] text-muted-foreground">Create a public template link anyone can use to make their own copy of this agent. Connectors are not included.</p>
        </div>
        <Button variant="outline" className="h-9 gap-2 shrink-0" onClick={shareTemplate}>
          <Link2 className="h-4 w-4" /> Share
        </Button>
      </div>

      <Hr />
      <div className="flex items-center justify-between gap-6">
        <div>
          <p className="text-[12.5px] font-semibold">Delete this agent</p>
          <p className="max-w-sm text-[12.5px] text-muted-foreground">
            {isRoot
              ? "Built-in agents can't be deleted — they ship with the workspace."
              : "Move this agent to Recently deleted. You can restore it for 30 days, but its integrations are disconnected now and restoring does not bring them back."}
          </p>
        </div>
        <Button variant="outline" className="h-9 shrink-0 gap-2 border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive" onClick={deleteAgent} disabled={isRoot || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {confirming ? "Click again to confirm" : "Delete this agent"}
        </Button>
      </div>
    </div>
  );
}
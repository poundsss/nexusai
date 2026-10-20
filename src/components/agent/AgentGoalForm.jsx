import React, { useState } from "react";
import { Bot, Loader2, ArrowUp, Paperclip } from "lucide-react";
import useAttachments from "@/hooks/useAttachments";
import AttachmentStrip from "@/components/attachments/AttachmentStrip";
import AttachButton from "@/components/attachments/AttachButton";

// Start an agent on one of the workspace's existing projects. The agent runtime is project-scoped,
// so the project is a required choice rather than an invented "global" agent. Reference images go
// through the SAME shared attachment pipeline every other composer uses.
export default function AgentGoalForm({ projects, busy, onStart }) {
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const attachments = useAttachments();
  const ready = projectId && goal.trim().length > 0 && !busy && !attachments.uploading;

  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    onStart(projectId, goal.trim(), attachments.urls);
    setGoal("");
    attachments.clear();
  };

  return (
    <form
      onSubmit={submit}
      {...attachments.dropZoneProps}
      className={`relative rounded-xl border bg-card p-3 shadow-sm transition-colors ${attachments.dragging ? "border-foreground/40 bg-accent/40" : "border-border"}`}
    >
      {attachments.dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border border-dashed border-foreground/30 bg-background/70 text-[12.5px] font-medium text-foreground/70">
          <span className="flex items-center gap-2"><Paperclip className="h-3.5 w-3.5" />Drop an image to attach</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Bot className="h-3.5 w-3.5" />
        <span>Give the agent a goal — it plans, edits, builds and verifies on its own.</span>
      </div>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onPaste={attachments.onPaste}
        rows={3}
        placeholder="e.g. Add a customer feedback page and store submissions"
        className="mt-2.5 w-full resize-none bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none"
      />
      <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
      <div className="mt-2 flex items-center gap-2">
        <AttachButton onFiles={attachments.add} className="border-border text-muted-foreground hover:text-foreground hover:border-foreground/30" size="h-8 w-8" iconSize="h-4 w-4" />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="flex-1 min-w-0 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground outline-none"
        >
          <option value="">Select an app…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button
          type="submit"
          disabled={!ready}
          className="grid place-items-center h-8 w-8 shrink-0 rounded-lg bg-primary text-primary-foreground disabled:opacity-35 transition-opacity"
          aria-label="Start agent"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </form>
  );
}
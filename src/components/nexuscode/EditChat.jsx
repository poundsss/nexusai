import React, { useEffect, useState } from "react";
import { Send, Loader2 } from "lucide-react";

// Branch-scoped AI edit chat. A send runs server-side: bounded repo context → LLM edit →
// commit + push to the working branch → chat entries recorded on the session.
export default function EditChat({ session, onSend, sending, draft, onDraftConsumed }) {
  const [text, setText] = useState("");

  // An "Address in chat" action pre-fills the composer from a review comment.
  useEffect(() => {
    if (draft) {
      setText(draft);
      if (onDraftConsumed) onDraftConsumed();
    }
  }, [draft]);

  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setText("");
    onSend(t);
  };

  const chat = session.chat || [];

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 space-y-3">
        {chat.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            Describe a change — Nexus Code edits the files and commits them to{" "}
            <span className="font-mono">{session.working_branch || "a new working branch"}</span>.
          </p>
        )}
        {chat.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap ${m.role === "user" ? "bg-foreground text-background" : "bg-muted"}`}>
              {m.text}
              {m.sha && (
                <div className="mt-1 font-mono text-[11px] opacity-60">
                  {String(m.sha).slice(0, 7)}{m.files?.length ? ` · ${m.files.join(", ")}` : ""}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-border p-3 flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={session.working_branch ? `Describe a change for ${session.working_branch}` : "Describe a change — a working branch will be created from the base branch"}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px]"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="self-end rounded-md bg-foreground text-background px-3 py-2 text-[13px] font-semibold disabled:opacity-50"
          title="Apply edit"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </div>
  );
}
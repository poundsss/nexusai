import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import { RotateCcw, Loader2 } from "lucide-react";
import MessageMeta from "./MessageMeta";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const MARK = { added: ["+", "text-emerald-600"], modified: ["~", "text-amber-600"], deleted: ["-", "text-destructive"] };

export default function ChatMessage({ message, run, onOpenFile, onRevertRun, revertingId }) {
  // Per-change Revert is exposed only for a completed, file-producing (non-discuss) AI run that
  // committed a version with a known base. Discuss, incomplete or failed runs expose no Revert.
  const canRevert = !!onRevertRun && !!run && run.status === "COMPLETED" && run.mode !== "discuss" &&
    !!run.version_id && run.base_version_number != null;
  const [confirm, setConfirm] = useState(false);
  const reverting = revertingId && run ? revertingId === run.id : false;
  if (message.role === "user") {
    return (
      // The reference presents the user's own prompt as a full-width bordered card, not a
      // chat bubble — the assistant's reply is the plain prose that follows it.
      <div className="rounded-xl border border-border bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground whitespace-pre-wrap shadow-sm">
        {message.content}
      </div>
    );
  }
  const files = run?.changed_files || [];
  return (
    <div className="min-w-0 space-y-2">
      <div className="prose prose-sm max-w-none text-[13px] leading-[1.65] dark:prose-invert [&_pre]:bg-primary [&_pre]:text-primary-foreground [&_pre]:text-[11px] [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-[12px] [&_p]:my-2 [&_ul]:my-2">
        <ReactMarkdown>{message.content}</ReactMarkdown>
      </div>
      {run && (run.status === "COMPLETED" || run.status === "FAILED") && run.mode !== "discuss" && (
        <div className="rounded-xl border border-border bg-card p-3 text-[12px]">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${run.status === "COMPLETED" ? "bg-emerald-500" : "bg-destructive"}`} />
            {run.status === "COMPLETED" ? `Build passed · Version ${run.version_number ?? ""}` : "Build failed · changes rolled back"}
            {run.repair_attempts > 0 && <span className="text-muted-foreground/60">· {run.repair_attempts} repair{run.repair_attempts > 1 ? "s" : ""}</span>}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{run.model} · {Math.round((run.duration_ms || 0) / 1000)}s</span>
          </div>
          {files.length > 0 && (
            <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
              {files.map((f) => (
                <li key={f.path}><button onClick={() => onOpenFile(f.path)} className="flex items-center gap-2 hover:underline text-foreground"><span className={`w-2 ${MARK[f.change]?.[1]}`}>{MARK[f.change]?.[0]}</span>{f.path}</button></li>
              ))}
            </ul>
          )}
          {canRevert && (
            <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2">
              <button
                onClick={() => setConfirm(true)}
                disabled={!!revertingId}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {reverting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}Revert
              </button>
              <span className="text-[10.5px] text-muted-foreground/70">Restores the app to just before this change; later changes are undone too.</span>
            </div>
          )}
        </div>
      )}
      <MessageMeta createdDate={message.created_date} content={message.content} />
      {canRevert && (
        <AlertDialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revert this change?</AlertDialogTitle>
              <AlertDialogDescription>
                The app will be restored to the state immediately before this change. Any changes made after it are undone too. A new version is created; history is never rewritten.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={reverting}
                onClick={(e) => { e.preventDefault(); onRevertRun(run); setConfirm(false); }}
              >
                {reverting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Revert
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
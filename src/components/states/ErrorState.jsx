import React from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

// User-facing error: what happened, whether it's safe, and what the user can do. Never shows
// a stack trace or sensitive detail — just a clear message and a retry path.
export default function ErrorState({ message = "Something went wrong.", onRetry, retryLabel = "Retry", safe = true }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-[13px]">
      <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-foreground">{message}</p>
        {safe && <p className="mt-1 text-muted-foreground text-[12px]">Your data is safe — this was a temporary failure. You can retry without losing anything.</p>}
        {onRetry && (
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>{retryLabel}</Button>
        )}
      </div>
    </div>
  );
}
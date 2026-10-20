import React, { useState } from "react";
import { Star, CheckCircle2, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Reviews section for a marketplace listing. Lists existing reviews and lets the
// user submit their own. The backend marks a review as "verified_install" when the
// reviewer's workspace has an active install of the listing — the UI never claims
// verification the backend hasn't confirmed.
export default function Reviews({ listingId, workspaceId, reviews, onSubmitted }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (rating < 1 || rating > 5) { toast({ variant: "destructive", title: "Please select a rating" }); return; }
    setSubmitting(true);
    try {
      const res = await base44.functions.invoke("marketplace", {
        action: "review", workspace_id: workspaceId, listing_id: listingId,
        rating, title: title.trim(), body: body.trim(),
      });
      toast({ title: "Review submitted", description: res.data?.review?.verified_install ? "Verified install" : "Posted" });
      setRating(0); setTitle(""); setBody("");
      onSubmitted?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not post review", description: e.response?.data?.error || e.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Submit form */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Write a review</h3>
        <div className="mt-3 flex items-center gap-1">
          {[1,2,3,4,5].map((n) => (
            <button
              key={n}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(n)}
              className="p-0.5"
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
            >
              <Star className={`h-5 w-5 transition-colors ${(hover || rating) >= n ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"}`} />
            </button>
          ))}
        </div>
        <Input
          className="mt-3" placeholder="Review title (optional)" value={title}
          onChange={(e) => setTitle(e.target.value)} maxLength={120}
        />
        <Textarea
          className="mt-2" placeholder="Share your experience…" value={body}
          onChange={(e) => setBody(e.target.value)} rows={3} maxLength={1000}
        />
        <Button className="mt-3" size="sm" onClick={submit} disabled={submitting || rating < 1}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
          {submitting ? "Submitting…" : "Submit review"}
        </Button>
      </div>

      {/* Reviews list */}
      <div className="space-y-3">
        {reviews.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-[13px] text-muted-foreground">
            No reviews yet. Be the first to review.
          </div>
        ) : (
          reviews.map((r) => (
            <div key={r.id} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5">
                  {[1,2,3,4,5].map((n) => (
                    <Star key={n} className={`h-3.5 w-3.5 ${n <= r.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`} />
                  ))}
                </div>
                {r.verified_install && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
                    <CheckCircle2 className="h-3 w-3" />Verified install
                  </span>
                )}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {new Date(r.created_date).toLocaleDateString()}
                </span>
              </div>
              {r.title && <p className="mt-2 text-[13px] font-medium">{r.title}</p>}
              {r.body && <p className="mt-1 text-[13px] text-muted-foreground whitespace-pre-wrap">{r.body}</p>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
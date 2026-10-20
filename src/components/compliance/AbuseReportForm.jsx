import React, { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";

const TARGET_TYPES = [
  { value: "workspace", label: "A workspace" },
  { value: "user", label: "A user" },
  { value: "content", label: "Content" },
  { value: "app", label: "An app" },
  { value: "marketplace_listing", label: "A marketplace listing" },
  { value: "deployment", label: "A deployment" },
  { value: "other", label: "Other" },
];

const CATEGORIES = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "malware", label: "Malware" },
  { value: "data_theft", label: "Data theft" },
  { value: "ip_infringement", label: "IP infringement" },
  { value: "tos_violation", label: "Terms of Service violation" },
  { value: "other", label: "Other" },
];

export default function AbuseReportForm({ onFile, working }) {
  const [targetType, setTargetType] = useState("workspace");
  const [targetId, setTargetId] = useState("");
  const [category, setCategory] = useState("spam");
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!targetId.trim()) {
      toast({ variant: "destructive", title: "Target ID is required" });
      return;
    }
    try {
      await onFile({ target_type: targetType, target_id: targetId.trim(), category, description: description.trim() });
      setSubmitted(true);
      setTargetId(""); setDescription(""); setCategory("spam");
      toast({ title: "Report submitted", description: "Our team will review it. You can track the status below." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not submit report", description: e.response?.data?.error || e.message });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-card p-4">
      <h3 className="font-medium text-[14px] mb-3 flex items-center gap-2"><Flag className="h-4 w-4" />Report a violation</h3>
      {submitted && (
        <div className="mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2.5 text-[12px] text-emerald-700 dark:text-emerald-400">
          Your report has been submitted. Thank you for helping keep the platform safe.
        </div>
      )}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-[12px]">What are you reporting?</Label>
            <select value={targetType} onChange={(e) => setTargetType(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]">
              {TARGET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="target-id" className="text-[12px]">Target identifier</Label>
            <Input id="target-id" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="e.g. workspace name or URL" className="mt-1 h-9" required />
          </div>
        </div>
        <div>
          <Label className="text-[12px]">Category</Label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]">
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <Label htmlFor="abuse-desc" className="text-[12px]">Description</Label>
          <Textarea id="abuse-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            placeholder="Describe what happened. Be specific and factual." className="mt-1" />
        </div>
        <Button type="submit" disabled={working || !targetId.trim()} size="sm">
          {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          Submit report
        </Button>
      </div>
    </form>
  );
}
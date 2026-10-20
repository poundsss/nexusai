import React, { useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2, ImageIcon } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Image } from "@/components/ui/image";

// Project logo upload — the documented Base44 "Dashboard → Overview → Edit logo" surface.
// PNG/JPEG, ≤5 MB, ≤1024×1024 px. The logo is stored as a public file and used by the published
// runtime as the browser favicon and home-screen icon. Client-side checks give immediate
// feedback; the server re-validates every limit through the projectLogo function.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DIM = 1024;
const ACCEPT = ["image/png", "image/jpeg"];

function readDims(file) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = URL.createObjectURL(file);
  });
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function ProjectLogoSection({ project, onReload }) {
  const [busy, setBusy] = useState(false);
  const [logoUrl, setLogoUrl] = useState(project?.logo_url || null);
  const fileRef = useRef(null);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const type = file.type;
    if (!ACCEPT.includes(type)) {
      toast({ variant: "destructive", title: "Unsupported format", description: "Use a PNG or JPEG image." });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast({ variant: "destructive", title: "File too large", description: "Logo must be 5 MB or less." });
      return;
    }
    let dims;
    try { dims = await readDims(file); } catch {
      toast({ variant: "destructive", title: "Invalid image", description: "Could not read the image." });
      return;
    }
    if (dims.width > MAX_DIM || dims.height > MAX_DIM) {
      toast({ variant: "destructive", title: "Image too large", description: `Logo must be ${MAX_DIM}×${MAX_DIM} px or smaller (yours is ${dims.width}×${dims.height}).` });
      return;
    }
    setBusy(true);
    try {
      const content_base64 = await toBase64(file);
      const res = await base44.functions.invoke("projectLogo", {
        action: "set", project_id: project.id, content_base64, content_type: type, filename: file.name,
      });
      setLogoUrl(res.data.logo_url);
      toast({ title: "Logo updated", description: "Used as the favicon and home-screen icon." });
      onReload?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Upload failed", description: err.response?.data?.error || err.message });
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await base44.functions.invoke("projectLogo", { action: "remove", project_id: project.id });
      setLogoUrl(null);
      toast({ title: "Logo removed" });
      onReload?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Could not remove", description: err.response?.data?.error || err.message });
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-md border border-border p-4 md:col-span-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
        <ImageIcon className="h-3.5 w-3.5" />App logo
      </h3>
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 rounded-md border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0">
          {logoUrl ? <Image src={logoUrl} alt="App logo" fittingType="fit" className="h-full w-full" /> : <ImageIcon className="h-6 w-6 text-muted-foreground/40" />}
        </div>
        <div className="min-w-0">
          <p className="text-[12px] text-muted-foreground">PNG or JPEG, up to 5 MB and 1024×1024 px. Used as the published app's browser favicon and home-screen icon.</p>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors disabled:opacity-50">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
              {logoUrl ? "Replace" : "Upload logo"}
            </button>
            {logoUrl && (
              <button onClick={remove} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] text-destructive hover:bg-muted transition-colors disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" />Remove
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={onFile} className="hidden" />
        </div>
      </div>
    </section>
  );
}
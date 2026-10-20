import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Download } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Image } from "@/components/ui/image";

// In-place file viewer (the reference surface's "View file"). Supported: images, text-like
// files and PDFs, read through a signed URL for the file's EXISTING private storage URI —
// no second storage path. Anything else shows only a download action; no behavior is
// invented for unsupported types.
const TEXT_RE = /\.(txt|md|csv|json)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

export function supportedPreviewKind(file) {
  const name = String(file?.name || "");
  const mime = String(file?.mime_type || "");
  if (mime.startsWith("image/") || IMAGE_RE.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("text/") || TEXT_RE.test(name)) return "text";
  return null;
}

export default function FileViewerDialog({ file, onClose }) {
  const [loaded, setLoaded] = useState(null); // { url, text }
  const [error, setError] = useState(null);
  const kind = file ? supportedPreviewKind(file) : null;

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!file || !kind) return;
    let alive = true;
    (async () => {
      try {
        const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: file.file_uri });
        if (!alive) return;
        if (kind === "text") {
          const res = await fetch(signed_url);
          if (!alive) return;
          setLoaded({ url: signed_url, text: await res.text() });
        } else {
          setLoaded({ url: signed_url, text: null });
        }
      } catch (e) {
        if (alive) setError(e.message || "Could not open the file");
      }
    })();
    return () => { alive = false; };
  }, [file, kind]);

  return (
    <Dialog open={!!file} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate text-[15px]">{file?.name}</DialogTitle>
        </DialogHeader>
        {!kind ? (
          <div className="rounded-md border border-border p-4 text-[12.5px] text-muted-foreground">
            This file type has no preview here. Use Download to open it.
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>
        ) : !loaded ? (
          <div className="grid place-items-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : kind === "image" ? (
          <Image src={loaded.url} fittingType="fill" className="max-h-[60vh] w-full rounded-md border border-border bg-muted" />
        ) : kind === "pdf" ? (
          <iframe title={file?.name || "File preview"} src={loaded.url} className="h-[60vh] w-full rounded-md border border-border" />
        ) : (
          <pre className="scrollbar-thin max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 text-[12.5px]">{loaded.text}</pre>
        )}
        {loaded?.url && (
          <div className="flex justify-end">
            <a
              href={loaded.url}
              download={file?.name}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] hover:bg-accent transition-colors"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
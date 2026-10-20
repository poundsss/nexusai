import { useCallback, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

export const MAX_ATTACHMENTS = 4;

// ONE pasted image is often offered by the OS in several equivalent forms at once (png, tiff,
// jpeg, …) across clipboardData.items AND clipboardData.files, and those are distinct File objects
// describing the SAME picture. So exactly the first valid image is taken per paste — never the
// whole list — and a blob with no real filename is wrapped into a File for the upload path.
function firstImageFromClipboard(clipboardData) {
  if (!clipboardData) return null;
  let found = null;
  for (const item of Array.from(clipboardData.items || [])) {
    if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
      const f = item.getAsFile();
      if (f) { found = f; break; }
    }
  }
  if (!found) found = Array.from(clipboardData.files || []).find((f) => String(f.type || "").startsWith("image/")) || null;
  if (!found) return null;
  return found.name && found.name !== "image.png"
    ? found
    : new File([found], `pasted-image-${Date.now()}.${(found.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: found.type });
}

// THE attachment pipeline for every AI composer in the product (Home, Builder Chat, Agent).
// Picker, clipboard paste and drag-and-drop all land in `add`, each image is uploaded through the
// platform's existing file upload as soon as it is attached, and `urls` is the ONE contract a
// surface hands to an AI request — so no surface carries an attachment implementation of its own.
export default function useAttachments() {
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // The last paste event already consumed, so one clipboard image can never be added twice.
  const lastPaste = useRef(null);

  const add = useCallback(async (incoming) => {
    const images = Array.from(incoming || []).filter((f) => String(f.type || "").startsWith("image/"));
    if (!images.length) return;
    const staged = images.slice(0, MAX_ATTACHMENTS).map((file) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || "image.png",
      preview: URL.createObjectURL(file),
      url: null,
      error: null,
      file,
    }));
    setItems((prev) => [...prev, ...staged].slice(0, MAX_ATTACHMENTS));
    for (const item of staged) {
      try {
        const { file_url } = await base44.integrations.Core.UploadPublicFile({ file: item.file });
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, url: file_url } : i)));
      } catch (e) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, error: e.message || "Upload failed" } : i)));
      }
    }
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => {
      const gone = prev.find((i) => i.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((prev) => { prev.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)); return []; });
  }, []);

  // A paste carrying no image is left completely alone — ordinary text paste keeps its default
  // behaviour, including inside a textarea.
  const onPaste = useCallback((e) => {
    // One paste = one attachment. The guard also makes a handler that sees the same event twice
    // (nested composer elements, bubbling) a no-op the second time.
    const native = e.nativeEvent || e;
    if (lastPaste.current === native) return;
    const file = firstImageFromClipboard(e.clipboardData);
    if (!file) return;
    lastPaste.current = native;
    e.preventDefault();
    add([file]);
  }, [add]);

  // The browser's default for a dropped file is to OPEN it, which navigates away from the
  // composer — so every drag event over the drop zone is prevented.
  const dropZoneProps = {
    onDragEnter: (e) => {
      e.preventDefault(); e.stopPropagation();
      dragDepth.current += 1;
      if (e.dataTransfer?.types?.includes("Files")) setDragging(true);
    },
    onDragOver: (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e) => {
      e.preventDefault(); e.stopPropagation();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      add(e.dataTransfer?.files);
    },
  };

  return {
    items,
    add,
    remove,
    clear,
    onPaste,
    dragging,
    dropZoneProps,
    uploading: items.some((i) => !i.url && !i.error),
    urls: items.map((i) => i.url).filter(Boolean),
  };
}
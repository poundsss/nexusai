import React, { useRef } from "react";
import { Paperclip, Plus } from "lucide-react";

// The shared image picker control. It owns nothing but the file input — the files go straight into
// the shared attachment pipeline, exactly like a paste or a drop.
export default function AttachButton({ onFiles, className = "", size = "h-7 w-7", iconSize = "h-3.5 w-3.5", bare = false, icon: Icon = Paperclip }) {
  const ref = useRef(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        title="Attach an image"
        aria-label="Attach an image"
        className={`grid place-items-center ${size} transition-colors ${bare ? "" : "rounded-lg border"} ${className}`}
      >
        <Icon className={iconSize} />
      </button>
    </>
  );
}
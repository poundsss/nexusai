import React from "react";
import { Image } from "@/components/ui/image";

// Image previews only. Briefs have no image field, so images are never saved as a selection and
// are NOT on any campaign — attaching them needs a connected Google Ads account.
export default function ImageVariants({ images, backgroundCount }) {
  if (!images.length) {
    return <p className="text-[11px] text-muted-foreground">{backgroundCount ? `${backgroundCount} image(s) could not be generated.` : "No images were generated."}</p>;
  }
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {images.map((im) => (
          <a key={im.session_asset_id} href={im.url} target="_blank" rel="noreferrer" className="group block">
            <Image src={im.url} alt={im.asset_field_type} className="aspect-square w-full rounded border border-border" />
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{im.asset_field_type.replaceAll("_", " ").toLowerCase()}</span>
          </a>
        ))}
      </div>
      <p className="mt-1 text-[10.5px] text-muted-foreground">Preview only — not saved to the brief and not on any campaign.</p>
    </div>
  );
}
import React from "react";

// A miniature application window used as a listing's preview surface, so the thing being
// installed reads as an app/template rather than a database row. Uses the listing's own
// artwork when it has one and falls back to a schematic app frame otherwise.
export default function ListingPreview({ listing, Icon }) {
  const art = listing.preview_image_url || listing.icon_url;
  if (art) {
    return (
      <div className="h-28 overflow-hidden rounded-t-lg border-b border-border bg-muted/40">
        <img src={art} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="relative h-28 overflow-hidden rounded-t-lg border-b border-border bg-muted/40">
      <div className="absolute inset-x-0 top-0 h-4 flex items-center gap-1 px-2 bg-background/80 border-b border-border">
        <span className="h-1 w-1 rounded-full bg-border" />
        <span className="h-1 w-1 rounded-full bg-border" />
        <span className="h-1 w-1 rounded-full bg-border" />
      </div>
      <div className="absolute inset-x-0 top-4 bottom-0 p-2.5 flex gap-2">
        <div className="w-7 space-y-1.5">
          <div className="h-1 rounded bg-border" />
          <div className="h-1 rounded bg-border/70" />
          <div className="h-1 rounded bg-border/70" />
        </div>
        <div className="flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
            <div className="h-1.5 w-14 rounded bg-border" />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="h-5 rounded bg-background border border-border/70" />
            <div className="h-5 rounded bg-background border border-border/70" />
          </div>
          <div className="h-6 rounded bg-background border border-border/70" />
        </div>
      </div>
    </div>
  );
}
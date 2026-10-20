import React from "react";

export default function TikTokConsent({ confirmed, onChange, branded }) {
  return <label className="flex items-start gap-2 text-xs text-muted-foreground">
    <input type="checkbox" checked={confirmed} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
    <span>I have reviewed this video, caption, account and settings and authorize this post.
      {" "}By posting, you agree to <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer" className="underline">TikTok's Music Usage Confirmation</a>.
      {branded && <> You also agree to <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer" className="underline">TikTok's Branded Content Policy</a>.</>}
    </span>
  </label>;
}
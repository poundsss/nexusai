import React from "react";

export default function TikTokPostSettings({ creator, settings, onChange }) {
  const set = (key, value) => onChange({ ...settings, [key]: value });
  return <div className="space-y-3 text-sm">
    <label className="block">Privacy
      <select required value={settings.privacy_level || ""} onChange={(e) => set("privacy_level", e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2">
        <option value="" disabled>Select privacy</option>
        {(creator.privacy_level_options || []).map((level) => <option key={level} value={level}>{level.replaceAll("_", " ")}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap gap-4">
      {[['comment', 'Allow comments'], ['duet', 'Allow Duet'], ['stitch', 'Allow Stitch']].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-muted-foreground">
        <input type="checkbox" checked={settings[`allow_${key}`] === true && !creator[`${key}_disabled`]} disabled={creator[`${key}_disabled`] === true} onChange={(e) => set(`allow_${key}`, e.target.checked)} />{label}
      </label>)}
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={settings.disclosure === true} onChange={(e) => onChange({ ...settings, disclosure: e.target.checked, brand_organic_toggle: false, brand_content_toggle: false })} />Disclose commercial content</label>
    {settings.disclosure && <div className="space-y-2 pl-4">
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.brand_organic_toggle === true} onChange={(e) => set("brand_organic_toggle", e.target.checked)} />Your brand</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.brand_content_toggle === true} disabled={settings.privacy_level === "SELF_ONLY"} onChange={(e) => set("brand_content_toggle", e.target.checked)} />Branded content (not available for Only me)</label>
      <p className="text-xs text-muted-foreground">{settings.brand_content_toggle ? "Your video will be labeled as 'Paid partnership'" : settings.brand_organic_toggle ? "Your video will be labeled as 'Promotional content'" : "Select your brand, branded content, or both."}</p>
    </div>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={settings.is_aigc === true} onChange={(e) => set("is_aigc", e.target.checked)} />AI-generated content</label>
  </div>;
}
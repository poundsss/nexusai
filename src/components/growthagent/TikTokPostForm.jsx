import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import TikTokPostSettings from "@/components/growthagent/TikTokPostSettings";
import TikTokConsent from "@/components/growthagent/TikTokConsent";

export default function TikTokPostForm({ creator, busy, onSubmit }) {
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [duration, setDuration] = useState(null);
  const [settings, setSettings] = useState({});
  const [consent, setConsent] = useState(false);
  const changeSettings = (value) => { setSettings(value); setConsent(false); };
  const valid = duration > 0 && duration <= creator.max_video_post_duration_sec && caption.trim() && settings.privacy_level && consent && (!settings.disclosure || settings.brand_organic_toggle || settings.brand_content_toggle) && !(settings.brand_content_toggle && settings.privacy_level === "SELF_ONLY");
  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ body: caption, video_url: url, video_duration_sec: duration, tiktok_settings: settings, consent: true, music_usage_confirmed: true }); }}>
    <p className="text-sm">Posting to <strong>{creator.creator_nickname}</strong> (@{creator.creator_username})</p>
    <label className="block text-sm">Video URL<Input required type="url" value={url} placeholder="HTTPS video on your TikTok-verified domain" onChange={(e) => { setUrl(e.target.value); setDuration(null); setConsent(false); }} /></label>
    {url.startsWith("https://") && <video key={url} src={url} controls preload="metadata" className="max-h-52 w-full rounded-md bg-muted" aria-label="Review the TikTok video" onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} onError={() => setDuration(null)} />}
    <p className="text-xs text-muted-foreground">{duration ? `${Math.round(duration)} seconds` : "Review the video to load its duration"}. Maximum: {creator.max_video_post_duration_sec} seconds. TikTok must verify your video's domain or URL prefix.</p>
    <label className="block text-sm">Caption<Textarea required maxLength={2200} value={caption} onChange={(e) => { setCaption(e.target.value); setConsent(false); }} /></label>
    <TikTokPostSettings creator={creator} settings={settings} onChange={changeSettings} />
    <TikTokConsent confirmed={consent} onChange={setConsent} branded={settings.brand_content_toggle} />
    <Button type="submit" disabled={busy || !valid}>{busy ? "Adding to queue…" : "Approve and queue TikTok video"}</Button>
    <p className="text-xs text-muted-foreground">Approval, granted video.publish and TikTok's posting limits are enforced by TikTok. Unaudited clients can post only to private accounts with Only me privacy.</p>
  </form>;
}
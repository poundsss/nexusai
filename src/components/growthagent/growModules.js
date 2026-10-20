import { Store, Megaphone, Share2, Send, Radar, Sprout, Globe, Mail, Phone, Sparkles, PhoneCall, Crosshair, UserPlus, Building2, Search, ScanEye, LifeBuoy } from "lucide-react";

// Grow module catalog — the six Runable Grow modules with every subcategory visible at once.
// Each subcategory opens its parameter form in place; completing it builds the request text
// that is inserted into the Chat composer (NEVER auto-sent). The request text names the
// EXISTING certified backend surface the Growth Agent then runs — no fake controls here.
// Preset ad/listening prompts are Runable's own documented growOption prompts.
const P = (p) => (p ? ` for project "${p.name}"` : "");

const adsSub = (id, label, icon, base, channel) => ({
  id, label, icon,
  blurb: "Audiences, creatives and budget pacing are handled through the certified ads surface; spend is never opened without an explicit instruction.",
  fields: [
    { key: "objective", label: "Objective", placeholder: base },
    { key: "budget", label: "Daily budget (USD)", placeholder: "50" },
  ],
  prompt: (v, p) =>
    `${base}${P(p)}. Objective: ${v.objective || base}.${v.budget ? ` Daily budget: $${v.budget}.` : ""} (googleAds surface, channel ${channel})`,
});

const socialSub = (id, label, icon, platform) => ({
  id, label, icon,
  blurb: "The agent plans, creates and schedules posts through the certified virality surface.",
  fields: [
    { key: "topic", label: "What to post about", placeholder: `Weekly tips for ${platform}`, required: true },
    { key: "cadence", label: "Posts per week", placeholder: "5" },
  ],
  prompt: (v, p) =>
    `Plan and schedule ${v.cadence || "several"} posts about "${v.topic}" on ${platform}${P(p)} (virality surface: strategy, post plan, publish calendar)`,
});

const listenSub = (id, label, icon, blurb, build) => ({
  id, label, icon, blurb,
  fields: [{ key: "term", label: "Term to track", placeholder: "e.g. our product category", required: true }],
  prompt: (v, p) => build(v, p),
});

export const GROW_MODULES = [
  {
    id: "my_business", label: "My Business", icon: Store,
    subs: [
      {
        id: "set_website", label: "Set Default Website", icon: Globe,
        blurb: "Promote ONE verified custom domain to the project's primary website (projectDomains set_primary); the built-in URL stays the fallback.",
        fields: [{ key: "domain", label: "Verified domain", placeholder: "www.example.com", required: true }],
        prompt: (v, p) => `Promote the verified custom domain ${v.domain} to the project's primary website${P(p)} (projectDomains set_primary)`,
      },
      {
        id: "set_email", label: "Set Up Email", icon: Mail,
        blurb: "Manage the project's custom SENDING domain (emailDomain surface) — not a mailbox provider; fails closed until management credentials are configured.",
        fields: [
          { key: "domain", label: "Email domain", placeholder: "mail.example.com" },
          { key: "sender_name", label: "Sender name", placeholder: "Acme Team" },
        ],
        prompt: (v, p) => `Set up the custom email domain ${v.domain || "(domain to confirm)"}${v.sender_name ? ` with sender name "${v.sender_name}"` : ""}${P(p)} (emailDomain surface)`,
      },
      {
        id: "phone_numbers", label: "Get Phone Numbers", icon: Phone,
        blurb: "Claim and set up the Google Business Profile listing. UNAVAILABLE in this runtime (no GBP connector) — the agent reports the certified refusal as data.",
        fields: [],
        prompt: (v, p) => `Claim and set up the Google Business Profile (My Business) listing${P(p)} (myBusiness surface)`,
      },
    ],
  },
  {
    id: "running_ads", label: "Running Ads", icon: Megaphone,
    subs: [
      {
        id: "runable_managed", label: "Runable Managed", icon: Sparkles,
        blurb: "The managed-ads monitor derives budget recommendations from the weekly report's synced metrics; every change is approval-gated and guardrail-checked.",
        fields: [{ key: "channel", label: "Channel", placeholder: "google, zernio:openai, zernio:meta, zernio:linkedin or zernio:tiktok", required: true }],
        prompt: (v, p) => `Run the managed ads weekly monitor and derive budget recommendations for the ${v.channel} channel${P(p)} (managedAds recommend_generate; approval-gated)`,
      },
      adsSub("chatgpt_ads", "ChatGPT Ads", "openai", "Run ads on ChatGPT to reach people asking for products like mine", "zernio:openai"),
      adsSub("meta_ads", "Meta Ads", "meta", "Run Meta Ads to reach customers on Facebook and Instagram", "zernio:meta"),
      adsSub("google_ads", "Google Ads", "googleads", "Set up and run Google Ads for my business", "google"),
      adsSub("linkedin_ads", "LinkedIn Ads", "linkedin", "Run LinkedIn ads to reach my ideal customers", "zernio:linkedin"),
      adsSub("tiktok_ads", "TikTok Ads", "tiktok", "Run TikTok Ads to get my product noticed", "zernio:tiktok"),
    ],
  },
  {
    id: "social_media", label: "Social Media", icon: Share2,
    subs: [
      socialSub("instagram", "Instagram", "instagram", "Instagram"),
      socialSub("linkedin", "LinkedIn", "linkedin", "LinkedIn"),
      socialSub("x_twitter", "X / Twitter", "x", "X"),
      socialSub("tiktok", "TikTok", "tiktok", "TikTok"),
    ],
  },
  {
    id: "cold_outreach", label: "Cold Outreach", icon: Send,
    subs: [
      {
        id: "cold_calling", label: "Cold Calling", icon: PhoneCall,
        blurb: "Scripts, one scheduled call per lead and the persisted call lifecycle. Every dial fails closed at the transport (PHONE_TRANSPORT_UNAVAILABLE) and is recorded with the blocker.",
        fields: [
          { key: "lead", label: "Lead name", placeholder: "A contact in this project", required: true },
          { key: "angle", label: "Angle to emphasize", placeholder: "Pain point, feature demo…" },
        ],
        prompt: (v, p) => `Draft a cold-call script for lead "${v.lead}"${v.angle ? ` emphasizing ${v.angle}` : ""}${P(p)} (coldCalling surface: script, then schedule ONE call)`,
      },
      {
        id: "cold_emailing", label: "Cold Emailing", icon: Mail,
        blurb: "Sequences, personalization and scheduled steps through the certified outreach surface; at most 3 follow-ups.",
        fields: [
          { key: "recipient", label: "Recipient (project contact)", placeholder: "jane@prospect.com", required: true },
          { key: "subject", label: "Subject", placeholder: "Quick intro" },
          { key: "message", label: "First message", placeholder: "Why I'm reaching out…", multiline: true },
        ],
        prompt: (v, p) => `Schedule a cold-email sequence to ${v.recipient} with subject "${v.subject || "(subject to confirm)"}"${v.message ? ` and first message: ${v.message}` : ""}${P(p)} (outreach surface)`,
      },
    ],
  },
  {
    id: "social_listening", label: "Social Listening", icon: Radar,
    subs: [
      listenSub("competitors", "Competitors", Crosshair,
        "Track what people say about competitors on Reddit and X, summarized into signals.",
        (v, p) => `Track what people say about my competitors on Reddit and X — add listening term "${v.term}"${P(p)} (listen surface)`),
      listenSub("leads", "Leads", UserPlus,
        "Monitor Reddit, X and forums for buying intent and get a qualified list.",
        (v, p) => `Find leads by monitoring Reddit, X, and forums for buying intent. Ideal customer: ${v.term}${P(p)} (leadGen surface)`),
      listenSub("your_company", "Your Company", Building2,
        "Monitor mentions of your company across Reddit, X and review sites.",
        (v, p) => `Monitor mentions of my company across Reddit, X, and review sites — add listening term "${v.term}"${P(p)} (listen surface)`),
    ],
  },
  {
    id: "organic_growth", label: "Organic Growth", icon: Sprout,
    subs: [
      {
        id: "seo_audit", label: "SEO Audit", icon: Search,
        blurb: "A full audit of the project's PUBLISHED production version (seoScan surface); refuses with NOT_PUBLISHED until a production deployment exists.",
        fields: [],
        prompt: (v, p) => `Run a full SEO audit of the published production website${P(p)} (seoScan surface)`,
      },
      {
        id: "aeo", label: "AI Visibility – AEO", icon: ScanEye,
        blurb: "Audit how visible the brand is in AI answers, then improve what they say (aeo surface).",
        fields: [{ key: "probe", label: "Question buyers ask AI", placeholder: "What is the best tool for…", required: true }],
        prompt: (v, p) => `Audit and improve how visible my brand is in AI answers like ChatGPT — add probe "${v.probe}"${P(p)} (aeo surface)`,
      },
      {
        id: "support_mail", label: "Support Mail", icon: LifeBuoy,
        blurb: "Outbound-only support messaging to an EXISTING project contact (support surface); inbound replies are not implemented and delivery is never promised.",
        fields: [
          { key: "customer", label: "Customer (project contact)", placeholder: "jane@customer.com", required: true },
          { key: "subject", label: "Subject", placeholder: "Your recent ticket" },
          { key: "message", label: "Message", placeholder: "Here's what we found…", multiline: true, required: true },
        ],
        prompt: (v, p) => `Schedule ONE outbound support message to ${v.customer} with subject "${v.subject || "(subject to confirm)"}" and body: ${v.message}${P(p)} (support surface)`,
      },
    ],
  },
];
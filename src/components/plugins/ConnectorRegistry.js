import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { parseJsonc } from "@/lib/agentConnectors";

// The connector registry is ALWAYS the selected app's own `base44/connectors/*.jsonc`
// declarations — the exact source the certified delegatedOAuth contract validates provider_id
// against on `begin`. This module only loads those declarations and adds display metadata for
// the known ones; nothing here invents a connector that is not declared. The connection itself
// runs through the existing flow: delegatedOAuth `begin` → the provider's consent screen → the
// existing `/oauth/callback` return, persisted by the certified contract.
const DISPLAY = {
  gmail: { label: "Gmail", description: "Send and manage email from your app." },
  googlecalendar: { label: "Google Calendar", description: "Manage schedules and events from your app." },
  googleslides: { label: "Google Slides", description: "Generate and manage presentations from your app." },
  googledocs: { label: "Google Docs", description: "Create and edit documents from your app." },
  intercom: { label: "Intercom", description: "Support customers and manage tickets from your app." },
  googlesheets: { label: "Google Sheets", description: "Read and write spreadsheet data from your app." },
  googledrive: { label: "Google Drive", description: "Back up and store your app's files in the cloud." },
  instagram: { label: "Instagram Business", description: "Publish and manage Instagram content from your app." },
  github: { label: "GitHub", description: "Track code activity, issues and pull requests." },
  microsoft: { label: "Microsoft", description: "Outlook mail, calendar and profile." },
  googlecontacts: { label: "Google Contacts" },
  googlephotos: { label: "Google Photos" },
  googleforms: { label: "Google Forms" },
  googleworkspace: { label: "Google Workspace" },
  googlemeet: { label: "Google Meet" },
  googletasks: { label: "Google Tasks" },
  googleanalytics: { label: "Google Analytics" },
  googlesearchconsole: { label: "Google Search Console" },
  googlebigquery: { label: "Google BigQuery" },
  googleclassroom: { label: "Google Classroom" },
  outlook: { label: "Outlook" },
  microsoft_teams: { label: "Microsoft Teams" },
  share_point: { label: "SharePoint" },
  one_drive: { label: "OneDrive" },
  microsoft_graph: { label: "Microsoft Graph" },
  excel: { label: "Microsoft Excel" },
  microsoft_powerpoint: { label: "Microsoft PowerPoint" },
  microsoft_word: { label: "Microsoft Word" },
  one_note: { label: "Microsoft OneNote" },
  slack: { label: "Slack" },
  slackbot: { label: "Slack Bot" },
  notion: { label: "Notion" },
  salesforce: { label: "Salesforce" },
  hubspot: { label: "HubSpot" },
  linkedin: { label: "LinkedIn" },
  tiktok: { label: "TikTok" },
  discord: { label: "Discord" },
  wix: { label: "Wix" },
  gitlab: { label: "GitLab" },
  clickup: { label: "ClickUp" },
  wrike: { label: "Wrike" },
  box: { label: "Box" },
  linear: { label: "Linear" },
  dropbox: { label: "Dropbox" },
  airtable: { label: "Airtable" },
  typeform: { label: "Typeform" },
  splitwise: { label: "Splitwise" },
  hugging_face: { label: "Hugging Face" },
  calendly: { label: "Calendly" },
  quickbooks: { label: "QuickBooks" },
  square: { label: "Square" },
  asana: { label: "Asana" },
  attio: { label: "Attio" },
  basecamp: { label: "Basecamp" },
  docusign: { label: "Docusign" },
  eventbrite: { label: "Eventbrite" },
  facebook_pages: { label: "Facebook Pages" },
  freshbooks: { label: "FreshBooks" },
  harvest: { label: "Harvest" },
  mailchimp: { label: "Mailchimp" },
  miro: { label: "Miro" },
  moneybird: { label: "Moneybird" },
  pagerduty: { label: "PagerDuty" },
  sentry: { label: "Sentry" },
  todoist: { label: "Todoist" },
  twitch: { label: "Twitch" },
  wave: { label: "Wave" },
  wordpress_com: { label: "WordPress.com" },
  x: { label: "X" },
  zohocrm: { label: "Zoho CRM" },
  klaviyo: { label: "Klaviyo" },
  contentful: { label: "Contentful" },
  gorgias: { label: "Gorgias" },
  gumroad: { label: "Gumroad" },
  polar: { label: "Polar" },
  bamboohr: { label: "BambooHR" },
};

// Display ordering of the "Most popular" row (unknown declarations keep their own order after).
export const POPULAR_ORDER = [
  "gmail", "googlecalendar", "googleslides", "googledocs",
  "intercom", "googlesheets", "googledrive", "instagram",
  "github", "microsoft", "slack", "notion", "salesforce", "hubspot",
  "linkedin", "tiktok", "discord", "wix", "airtable", "outlook",
  "linear", "dropbox", "googleanalytics", "googletasks", "calendly",
  "quickbooks", "square", "asana", "todoist", "clickup",
];

export function useConnectorRegistry(projectId) {
  const [connectors, setConnectors] = useState(null); // null = loading
  useEffect(() => {
    if (!projectId) { setConnectors([]); return; }
    let alive = true;
    base44.functions.invoke("builderProjectRead", { project_id: projectId, path_prefix: "base44/connectors/" })
      .then((r) => (r.data?.files || []).slice(0, 200))
      .then((files) => {
        if (!alive) return;
        setConnectors((files || []).map((f) => {
          const name = f.path.replace(/^base44\/connectors\//, "").replace(/\.jsonc$/, "");
          const meta = DISPLAY[name] || {};
          let doc = null;
          try { doc = parseJsonc(f.content); } catch { /* registry row survives a bad doc */ }
          return {
            name,
            label: meta.label || name,
            description: meta.description || doc?.description || "",
          };
        }));
      }).catch(() => { if (alive) setConnectors([]); });
    return () => { alive = false; };
  }, [projectId]);
  return connectors;
}

// The real existing connection flow (delegatedOAuth begin). Resolves true when the browser was
// redirected to the provider's consent screen; the certified contract persists the connection.
export async function beginConnectorConnect(projectId, providerId) {
  // The redirect is server-controlled: the browser never supplies a redirect origin.
  const res = await base44.functions.invoke("delegatedOAuth", { action: "begin", project_id: projectId, provider_id: providerId });
  const url = res.data?.authorization_url;
  if (!url) return false;
  window.location.href = url;
  return true;
}
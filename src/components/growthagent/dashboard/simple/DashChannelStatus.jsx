import React from "react";
import ZernioAccountLink from "./ZernioAccountLink";

const STATUS_TEXT = { pending_setup: "Setup pending", awaiting_payment: "Awaiting payment", suspended: "Suspended", disconnected: "Disconnected" };

// Per-channel account state for the selected project, from the dashboard's existing account_get load.
function errorText(err) {
  return /ZERNIO_API_KEY|not configured/i.test(err)
    ? "Zernio isn't configured yet — add the ZERNIO_API_KEY secret to enable this channel."
    : err;
}

export default function DashChannelStatus({ channels, projectId, onChanged }) {
  if (!channels?.length) return <p className="py-2 text-[12.5px] text-muted-foreground">No ad channels available.</p>;
  return (
    <div className="mb-2 divide-y divide-border border-t border-border">
      {channels.map((c) => {
        const connected = c.status === "active";
        const zernio = c.id.startsWith("zernio:");
        return (
          <div key={c.id} className="py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] text-foreground">{c.label}</span>
              <span className="flex items-center gap-2">
                <span className={`text-[11.5px] ${connected ? "text-brand" : "text-muted-foreground"}`}>
                  {connected ? "Connected" : STATUS_TEXT[c.status] || "Not connected"}
                </span>
                {zernio && !connected && <ZernioAccountLink projectId={projectId} channel={c.id} label={c.label} onLinked={onChanged} />}
              </span>
            </div>
            {c.accountError && <p className="pt-0.5 text-[11.5px] text-destructive">{errorText(c.accountError)}</p>}
          </div>
        );
      })}
    </div>
  );
}
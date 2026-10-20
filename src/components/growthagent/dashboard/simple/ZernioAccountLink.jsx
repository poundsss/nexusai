import React, { useEffect, useState } from "react";
import ZernioMetaConnectButton from "./ZernioMetaConnectButton";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const call = (body) => base44.functions.invoke("googleAds", body).then((r) => r.data);
const errText = (e) => e?.response?.data?.error || e?.message || "Request failed";

// Link an ad account already connected in Zernio to this project's channel (read-only at Zernio).
export default function ZernioAccountLink({ projectId, channel, label, onLinked }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, accounts: null, error: null, busy: null });

  const openDialog = async () => {
    setOpen(true);
    setState({ loading: true, accounts: null, error: null, busy: null });
    try {
      const d = await call({ action: "account_options", project_id: projectId, channel });
      setState({ loading: false, accounts: d.accounts || [], error: null, busy: null });
    } catch (e) { setState({ loading: false, accounts: [], error: errText(e), busy: null }); }
  };

  // Back from Zernio's Meta connect flow: reopen the picker so the new account can be linked.
  useEffect(() => {
    if (channel === "zernio:meta" && new URLSearchParams(window.location.search).get("zernio_connected") === "meta") openDialog();
  }, [channel, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = async (ref) => {
    setState((s) => ({ ...s, busy: ref, error: null }));
    try {
      await call({ action: "account_link", project_id: projectId, channel, provider_account_ref: ref });
      setOpen(false); onLinked?.();
    } catch (e) { setState((s) => ({ ...s, busy: null, error: errText(e) })); }
  };

  return (
    <>
      <button type="button" onClick={openDialog} className="rounded-md border border-border px-2 py-0.5 text-[11.5px] text-foreground hover:bg-accent">Link account</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Link {label} account</DialogTitle></DialogHeader>
          {state.loading ? <div className="grid place-items-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : null}
          {state.error ? <p className="text-[12.5px] text-destructive">{state.error}</p> : null}
          {state.accounts && !state.accounts.length && !state.error ? <p className="text-[12.5px] text-muted-foreground">No {label} accounts are connected in Zernio yet.</p> : null}
          {state.accounts && !state.accounts.some((a) => a.is_active && !a.linked_elsewhere) && channel === "zernio:meta" ? <ZernioMetaConnectButton projectId={projectId} /> : null}
          <div className="divide-y divide-border">
            {(state.accounts || []).map((a) => (
              <div key={a.provider_account_ref} className="flex items-center justify-between py-2">
                <span className="text-[13px] text-foreground">{a.name}</span>
                {a.linked_here ? <span className="text-[12px] text-brand">Linked</span>
                  : a.linked_elsewhere ? <span className="text-[12px] text-muted-foreground">Used by another project</span>
                  : !a.is_active ? <span className="text-[12px] text-muted-foreground">Reconnect in Zernio</span>
                  : <button type="button" disabled={!!state.busy} onClick={() => link(a.provider_account_ref)} className="rounded-md bg-foreground px-2.5 py-1 text-[12px] text-background disabled:opacity-50">{state.busy === a.provider_account_ref ? "Linking…" : "Link"}</button>}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
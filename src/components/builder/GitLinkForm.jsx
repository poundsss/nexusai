import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

// Repository + branch selection. Everything is validated server-side on link; this only
// presents what the connected GitHub account can actually push to.
export default function GitLinkForm({ github, onDone }) {
  const [repos, setRepos] = useState(null);
  const [repo, setRepo] = useState("");
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState("");
  const [subdir, setSubdir] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    github.listRepos().then((d) => setRepos(d.repos || [])).catch((e) => setError(e.response?.data?.error || e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickRepo = async (full) => {
    setRepo(full); setBranches([]); setBranch(""); setError(null);
    try {
      const d = await github.listBranches(full);
      setBranches(d.branches || []);
      setBranch(d.repo?.default_branch || d.branches?.[0]?.name || "");
    } catch (e) { setError(e.response?.data?.error || e.message); }
  };

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await github.linkRepo({ repo_full_name: repo, branch, subdirectory: subdir });
      onDone?.();
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  if (repos === null && !error) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading repositories…</div>;

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="font-medium">Link a repository</p>
      {error && <p className="text-[12px] text-destructive">{error}</p>}

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Repository</span>
        <select value={repo} onChange={(e) => pickRepo(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-[12px]">
          <option value="">Select a repository…</option>
          {(repos || []).filter((r) => r.permissions?.push).map((r) => (
            <option key={r.full_name} value={r.full_name}>{r.full_name}{r.private ? " (private)" : ""}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Or paste the repository HTTPS URL</span>
        <input
          onBlur={(e) => {
            const m = e.target.value.trim().match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
            if (m) pickRepo(`${m[1]}/${m[2]}`);
          }}
          placeholder="https://github.com/owner/repo"
          className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]"
        />
        <span className="mt-1 block text-[11px] text-muted-foreground">Access still uses your own connected account — the URL only identifies the repository.</span>
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Branch</span>
        <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!branches.length} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-[12px] disabled:bg-muted">
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Subdirectory (optional)</span>
        <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="e.g. apps/crm" className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]" />
      </label>

      {repo && <p className="text-[11px] text-muted-foreground font-mono">Selected: {repo}</p>}
      <button onClick={submit} disabled={!repo || !branch || busy} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Link repository
      </button>
    </div>
  );
}
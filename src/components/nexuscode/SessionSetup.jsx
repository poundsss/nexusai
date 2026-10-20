import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Loader2, GitBranch } from "lucide-react";

export default function SessionSetup({ onConnected }) {
  const [repos, setRepos] = useState(null);
  const [repo, setRepo] = useState("");
  const [branches, setBranches] = useState(null);
  const [branch, setBranch] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    base44.functions.invoke("nexusCode", { action: "repos" })
      .then((r) => setRepos(r.data?.repos || []))
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  const pickRepo = async (fullName) => {
    setRepo(fullName);
    setBranches(null);
    setBranch("");
    setError(null);
    if (!fullName) return;
    try {
      const r = await base44.functions.invoke("nexusCode", { action: "branches", repo_full_name: fullName });
      setBranches(r.data?.branches || []);
      setBranch(r.data?.repo?.default_branch || "");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const start = async () => {
    setWorking(true);
    setError(null);
    try {
      const r = await base44.functions.invoke("nexusCode", {
        action: "connect", repo_full_name: repo, base_branch: branch, subdirectory,
      });
      onConnected(r.data.session);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setWorking(false);
    }
  };

  const canStart = repo && branch && !working;

  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          <h1 className="text-[15px] font-semibold">Start a Nexus Code session</h1>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Pick one of your repositories and the branch to work from. AI edits and commits land on
          their own working branch — the base branch is only the pull-request target.
        </p>

        <label className="block space-y-1">
          <span className="text-[12px] font-medium">Repository</span>
          <select
            value={repo}
            onChange={(e) => pickRepo(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[13px]"
          >
            <option value="">{repos ? "Select a repository…" : "Loading repositories…"}</option>
            {(repos || []).map((r) => (
              <option key={r.full_name} value={r.full_name}>{r.full_name}{r.private ? " (private)" : ""}</option>
            ))}
          </select>
        </label>

        {repo && (
          <label className="block space-y-1">
            <span className="text-[12px] font-medium">Base branch</span>
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[13px]"
            >
              {!branches && <option value="">Loading branches…</option>}
              {branches && <option value={branch}>{branch}</option>}
              {(branches || []).filter((b) => b.name !== branch).map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-[12px] font-medium">Subdirectory <span className="text-muted-foreground font-normal">(optional)</span></span>
          <input
            value={subdirectory}
            onChange={(e) => setSubdirectory(e.target.value)}
            placeholder="e.g. packages/web"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px]"
          />
        </label>

        {error && <p className="text-[12px] text-destructive">{error}</p>}

        <button
          onClick={start}
          disabled={!canStart}
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-foreground text-background px-3 py-2 text-[13px] font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {working && <Loader2 className="h-4 w-4 animate-spin" />}
          Start session
        </button>
      </div>
    </div>
  );
}
import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Thin client over the compliance control plane (base44/functions/compliance). Every mutation
// goes through the real backend, which re-resolves the caller's workspace role server-side.
// The frontend never decides permissions — it only reflects what the server returned.
const call = async (payload) => {
  const res = await base44.functions.invoke("compliance", payload);
  return res.data;
};

// --- Legal Documents -------------------------------------------------------

export function useLegalDocuments(workspaceId) {
  const [documents, setDocuments] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [docsData, pendingData] = await Promise.all([
        call({ action: "list_documents" }),
        call({ action: "pending_acceptances", workspace_id: workspaceId || undefined }).catch(() => ({ pending: [] })),
      ]);
      setDocuments(docsData.documents || []);
      setPending(pendingData.pending || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const accept = useCallback(async (documentId) => {
    setWorking(true);
    try {
      const data = await call({ action: "accept", workspace_id: workspaceId || undefined, document_id: documentId });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const publish = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "publish_document", workspace_id: workspaceId || undefined, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const retire = useCallback(async (documentId) => {
    setWorking(true);
    try {
      const data = await call({ action: "retire_document", workspace_id: workspaceId || undefined, document_id: documentId });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { documents, pending, loading, error, working, reload: load, accept, publish, retire };
}

// --- Data Subject Requests -------------------------------------------------

export function useDataSubjectRequests(workspaceId) {
  const [dsrs, setDsrs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await call({ action: "list_dsrs", workspace_id: workspaceId });
      setDsrs(data.dsrs || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const file = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "file_dsr", workspace_id: workspaceId, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const verify = useCallback(async (dsrId, token) => {
    setWorking(true);
    try {
      const data = await call({ action: "verify_dsr", workspace_id: workspaceId || undefined, dsr_id: dsrId, token });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const complete = useCallback(async (dsrId) => {
    setWorking(true);
    try {
      const data = await call({ action: "complete_dsr", workspace_id: workspaceId, dsr_id: dsrId });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const reject = useCallback(async (dsrId, reason) => {
    setWorking(true);
    try {
      const data = await call({ action: "reject_dsr", workspace_id: workspaceId, dsr_id: dsrId, reason });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { dsrs, loading, error, working, reload: load, file, verify, complete, reject };
}

// --- Abuse Reports ---------------------------------------------------------

export function useAbuseReports(workspaceId) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await call({ action: "list_abuse", workspace_id: workspaceId });
      setReports(data.reports || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const file = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "file_abuse", workspace_id: workspaceId || undefined, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const assign = useCallback(async (reportId) => {
    setWorking(true);
    try {
      const data = await call({ action: "assign_abuse", workspace_id: workspaceId, report_id: reportId });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const resolve = useCallback(async (reportId, resolution, note) => {
    setWorking(true);
    try {
      const data = await call({ action: "resolve_abuse", workspace_id: workspaceId, report_id: reportId, resolution, note });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { reports, loading, error, working, reload: load, file, assign, resolve };
}

// --- Retention Policies ----------------------------------------------------

export function useRetentionPolicies(workspaceId) {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await call({ action: "list_retention", workspace_id: workspaceId });
      setPolicies(data.policies || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "create_retention", workspace_id: workspaceId, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const remove = useCallback(async (policyId) => {
    setWorking(true);
    try {
      await call({ action: "delete_retention", workspace_id: workspaceId, policy_id: policyId });
      await load();
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { policies, loading, error, working, reload: load, create, remove };
}

// --- Compliance Events -----------------------------------------------------

export function useComplianceEvents(workspaceId) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await call({ action: "list_events", workspace_id: workspaceId });
      setEvents(data.events || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  return { events, loading, error, reload: load };
}

// --- Data Breaches ---------------------------------------------------------

export function useBreaches(workspaceId) {
  const [breaches, setBreaches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await call({ action: "list_breaches", workspace_id: workspaceId });
      setBreaches(data.breaches || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const report = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "report_breach", workspace_id: workspaceId, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const contain = useCallback(async (breachId, rootCause) => {
    setWorking(true);
    try {
      const data = await call({ action: "contain_breach", workspace_id: workspaceId, breach_id: breachId, root_cause: rootCause });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const resolve = useCallback(async (breachId, remediation) => {
    setWorking(true);
    try {
      const data = await call({ action: "resolve_breach", workspace_id: workspaceId, breach_id: breachId, remediation });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const notifyRegulator = useCallback(async (breachId) => {
    setWorking(true);
    try {
      const data = await call({ action: "notify_regulator", workspace_id: workspaceId, breach_id: breachId });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const notifyUsers = useCallback(async (breachId) => {
    setWorking(true);
    try {
      const data = await call({ action: "notify_users", workspace_id: workspaceId, breach_id: breachId });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { breaches, loading, error, working, reload: load, report, contain, resolve, notifyRegulator, notifyUsers };
}
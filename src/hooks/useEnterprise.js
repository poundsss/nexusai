import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Thin client over the SSO/SCIM control plane (base44/functions/sso). Every mutation goes
// through the real backend, which re-resolves the caller's role server-side. The frontend
// never decides permissions — it only reflects the capabilities the server returned.
const call = async (payload) => {
  const res = await base44.functions.invoke("sso", payload);
  return res.data;
};

// --- Organization ----------------------------------------------------------

export function useEnterpriseOrg(workspaceId) {
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await call({ action: "get_org", workspace_id: workspaceId });
      setOrg(data.org);
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
      const data = await call({ action: "create_org", workspace_id: workspaceId, ...params });
      setOrg(data.org);
      return data.org;
    } finally { setWorking(false); }
  }, [workspaceId]);

  const update = useCallback(async (patch) => {
    setWorking(true);
    try {
      const data = await call({ action: "update_org", workspace_id: workspaceId, patch });
      setOrg(data.org);
      return data.org;
    } finally { setWorking(false); }
  }, [workspaceId]);

  return { org, loading, error, working, reload: load, create, update };
}

// --- SSO Connections -------------------------------------------------------

export function useSsoConnections(workspaceId) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await call({ action: "list_connections", workspace_id: workspaceId });
      setConnections(data.connections || []);
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
      const data = await call({ action: "create_connection", workspace_id: workspaceId, ...params });
      await load();
      return data.connection;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const update = useCallback(async (connectionId, patch) => {
    setWorking(true);
    try {
      const data = await call({ action: "update_connection", workspace_id: workspaceId, connection_id: connectionId, patch });
      await load();
      return data.connection;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const disable = useCallback(async (connectionId) => {
    setWorking(true);
    try {
      await call({ action: "disable_connection", workspace_id: workspaceId, connection_id: connectionId });
      await load();
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { connections, loading, error, working, reload: load, create, update, disable };
}

// --- Verified Domains ------------------------------------------------------

export function useSsoDomains(workspaceId) {
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await call({ action: "list_domains", workspace_id: workspaceId });
      setDomains(data.domains || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async (domain) => {
    setWorking(true);
    try {
      const data = await call({ action: "create_domain", workspace_id: workspaceId, domain });
      await load();
      return data.domain;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const verify = useCallback(async (domainId, records) => {
    setWorking(true);
    try {
      const data = await call({ action: "verify_domain", workspace_id: workspaceId, domain_id: domainId, records });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const remove = useCallback(async (domainId) => {
    setWorking(true);
    try {
      await call({ action: "remove_domain", workspace_id: workspaceId, domain_id: domainId });
      await load();
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { domains, loading, error, working, reload: load, create, verify, remove };
}

// --- Group Mappings --------------------------------------------------------

export function useGroupMappings(workspaceId) {
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await call({ action: "list_group_mappings", workspace_id: workspaceId });
      setMappings(data.mappings || []);
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
      const data = await call({ action: "create_group_mapping", workspace_id: workspaceId, ...params });
      await load();
      return data.mapping;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const remove = useCallback(async (mappingId) => {
    setWorking(true);
    try {
      await call({ action: "remove_group_mapping", workspace_id: workspaceId, mapping_id: mappingId });
      await load();
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { mappings, loading, error, working, reload: load, create, remove };
}

// --- SCIM Records ----------------------------------------------------------

export function useScimRecords(workspaceId) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async (opts = {}) => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await call({ action: "list_scim_records", workspace_id: workspaceId, ...opts });
      setRecords(data.records || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  const provisionUser = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "provision_user", workspace_id: workspaceId, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const suspendUser = useCallback(async (externalId) => {
    setWorking(true);
    try {
      await call({ action: "suspend_user", workspace_id: workspaceId, external_id: externalId });
      await load();
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const deprovisionUser = useCallback(async (externalId) => {
    setWorking(true);
    try {
      await call({ action: "deprovision_user", workspace_id: workspaceId, external_id: externalId });
      await load();
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const provisionGroup = useCallback(async (params) => {
    setWorking(true);
    try {
      const data = await call({ action: "provision_group", workspace_id: workspaceId, ...params });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  const syncGroups = useCallback(async (externalId, groups) => {
    setWorking(true);
    try {
      const data = await call({ action: "sync_groups", workspace_id: workspaceId, external_id: externalId, groups });
      await load();
      return data;
    } finally { setWorking(false); }
  }, [workspaceId, load]);

  return { records, loading, error, working, reload: load, provisionUser, suspendUser, deprovisionUser, provisionGroup, syncGroups };
}
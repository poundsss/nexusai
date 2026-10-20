// Shared disposable fixtures for the Security Scan certification suite
// (securityScanCert + securityScanPlanGateCert). Plain module — no Deno.serve — so both
// certification functions import the SAME project/job factory instead of re-implementing it.
import { securityScanSurface, SECURITY_SCAN_JOB_TYPE } from "./securityScan.ts";

/** Creates a disposable project named for the cert, records its id for cleanup, and returns it. */
export async function mkScanProject(svc, projects, wsId, name, stamp) {
  const p = await svc.entities.Project.create({
    workspace_id: wsId, name: `secscan-${name}-${stamp}`, status: "ready", version_count: 1,
  });
  projects.push(p.id);
  return p;
}

/** Background jobs of the security-scan type for a project, newest first. */
export const scanJobs = (svc, projectId) =>
  svc.entities.BackgroundJob.filter({ project_id: projectId, job_type: SECURITY_SCAN_JOB_TYPE }, "-created_date", 20);

/** Binds the REAL securityScanSurface to a service-role client for a test. */
export const scanSurface = (svc) => (project, workspace, user, input) =>
  securityScanSurface(svc, project, workspace, user, input);
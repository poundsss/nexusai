// Evidence: https://runable.com/marketing-grow, Your Company is social listening,
// NOT Google Business Profile. Uses the existing terms, observations and monitoring queue.
import { addTerm, removeTerm, listTerms, runMonitor, scheduleMonitoring } from "./growListening.ts";
import { isWebSearchConfigured } from "./webSearch.ts";

export const COMPANY_EVIDENCE = "https://runable.com/marketing-grow";
export async function companySurface(svc, project, workspace, input, opts = {}) {
  const action = input.action;
  if (action === "company_configure") return addTerm(svc, project, workspace, { label: input.label || project.name, terms: input.terms || [project.name], kind: "company" });
  if (action === "company_remove") {
    const term = await svc.entities.ListenTerm.get(String(input.term_id || ""));
    if (!term || term.project_id !== project.id || term.kind !== "company") throw Object.assign(new Error("Company term not found"), { status: 404, code: "TERM_NOT_FOUND" });
    return removeTerm(svc, project, term.id);
  }
  if (action === "company_run") return runMonitor(svc, project, workspace, opts);
  if (action === "company_schedule") return scheduleMonitoring(svc, project, workspace, input);
  if (action === "company_get") {
    const { terms } = await listTerms(svc, project);
    const companyTerms = terms.filter((t) => t.kind === "company");
    const page = companyTerms.length ? await svc.entities.ListenObservation.filter({ project_id: project.id, term_id: { $in: companyTerms.map((t) => t.id) } }, { sort: "-observed_at", limit: 50, cursor: input.cursor }) : { items: [], has_more: false };
    return { project_id: project.id, company_name: project.name, terms: companyTerms, observations: page.items, next_cursor: page.next_cursor, has_more: page.has_more,
      provider_configured: isWebSearchConfigured(), code: isWebSearchConfigured() ? null : "WEB_SEARCH_NOT_CONFIGURED",
      coverage: "Public web-search results only; indexed Reddit, X and review pages may appear. Not exhaustive monitoring, private posts or a native social feed.", evidence: COMPANY_EVIDENCE };
  }
  throw Object.assign(new Error("Unknown company action"), { status: 400, code: "INVALID_ACTION" });
}
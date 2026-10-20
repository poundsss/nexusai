import React from "react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useAppAnalytics } from "@/hooks/useAppAnalytics";
import AccountPage from "@/components/shell/AccountPage";
import ErrorState from "@/components/states/ErrorState";
import EmptyState from "@/components/states/EmptyState";
import AnalyticsToolbar from "@/components/analytics/AnalyticsToolbar";
import AnalyticsOverviewSection from "@/components/analytics/AnalyticsOverviewSection";
import AnalyticsSalesSection from "@/components/analytics/AnalyticsSalesSection";
import AnalyticsErrorsSection from "@/components/analytics/AnalyticsErrorsSection";
import AnalyticsFunnelSection from "@/components/analytics/AnalyticsFunnelSection";
import AnalyticsRetentionSection from "@/components/analytics/AnalyticsRetentionSection";
import AnalyticsEventsSection from "@/components/analytics/AnalyticsEventsSection";
import AnalyticsSessionsSection from "@/components/analytics/AnalyticsSessionsSection";
import AnalyticsPerformanceSection from "@/components/analytics/AnalyticsPerformanceSection";
import AnalyticsExportSection from "@/components/analytics/AnalyticsExportSection";
import AnalyticsSchemasSection from "@/components/analytics/AnalyticsSchemasSection";
import AnalyticsConfigSection from "@/components/analytics/AnalyticsConfigSection";

// Operator analytics for ONE generated application.
//
// Every number on this page comes from the analytics operator API, which authorizes the caller
// against the project server-side — an application the operator cannot access returns a refusal,
// which is shown as-is rather than being worked around.
export default function AppAnalytics() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const { projects, projectId, setProjectId, days, setDays, data, loading, error, reload, query } = useAppAnalytics(workspace);

  return (
    <AccountPage
      workspace={workspace} user={user} loading={wsLoading || loading}
      title="App analytics"
      subtitle="What end-users do inside your published applications — events, sessions, funnels and retention."
      actions={<AnalyticsToolbar projects={projects} projectId={projectId} onProjectChange={setProjectId} days={days} onDaysChange={setDays} onRefresh={reload} />}
    >
      {!projectId ? (
        <EmptyState title="No applications yet" description="Build and publish an application, and its analytics appear here." />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : data ? (
        <div className="space-y-7">
          <AnalyticsOverviewSection overview={data.overview} />
          <AnalyticsSalesSection sales={data.sales} />
          <AnalyticsErrorsSection errors={data.errors} />
          <AnalyticsFunnelSection query={query} />
          <AnalyticsPerformanceSection query={query} />
          <AnalyticsRetentionSection retention={data.retention} />
          <AnalyticsEventsSection query={query} />
          <AnalyticsSessionsSection query={query} />
          <AnalyticsExportSection query={query} />
          <AnalyticsSchemasSection query={query} />
          <AnalyticsConfigSection query={query} />
        </div>
      ) : null}
    </AccountPage>
  );
}
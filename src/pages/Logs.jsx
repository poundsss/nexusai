import React from "react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useLogs } from "@/hooks/useLogs";
import AccountPage from "@/components/shell/AccountPage";
import ErrorState from "@/components/states/ErrorState";
import EmptyState from "@/components/states/EmptyState";
import LogsToolbar from "@/components/app-logs/LogsToolbar";
import LogsList from "@/components/app-logs/LogsList";
import LogDetail from "@/components/app-logs/LogDetail";

// Runtime logs for one application. Every row comes from the `logs` operator API, which
// authorizes the caller against the project server-side and reuses the existing TraceEvent /
// FunctionInvocation / AuditLog backend — no second logging system is created here.
export default function Logs() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const {
    projects, projectId, setProjectId, eventType, setEventType, errorsOnly, setErrorsOnly,
    events, hasMore, loading, error, reload, openDetail, selected, detail, detailLoading,
  } = useLogs(workspace);

  return (
    <AccountPage
      workspace={workspace}
      user={user}
      loading={wsLoading || (loading && !events.length)}
      title="Logs"
      subtitle="Runtime events from your applications — function calls, integrations, user events, entity operations and errors."
      actions={
        <LogsToolbar
          projects={projects}
          projectId={projectId}
          onProjectChange={setProjectId}
          eventType={eventType}
          onEventTypeChange={setEventType}
          errorsOnly={errorsOnly}
          onErrorsOnlyChange={setErrorsOnly}
          onRefresh={reload}
          loading={loading}
        />
      }
    >
      {!projectId ? (
        <EmptyState title="No applications yet" description="Build and publish an application, and its runtime logs appear here." />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 items-start">
          <LogsList events={events} loading={loading} selected={selected} onSelect={openDetail} hasMore={hasMore} />
          <LogDetail selected={selected} detail={detail} detailLoading={detailLoading} />
        </div>
      )}
    </AccountPage>
  );
}
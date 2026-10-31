import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
} from '@plunk/ui';
import {canRetryStepType} from '@plunk/shared';
import type {WorkflowExecution} from '@plunk/db';
import dayjs from 'dayjs';
import {CircleStop, RotateCcw, Users} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../lib/network';

const PAGE_SIZE = 10;

/** How often the list is read while a run on it can still change */
const ACTIVE_REFRESH_MS = 5_000;

type WorkflowExecutionRow = WorkflowExecution & {
  contact: {id: string; email: string};
  currentStep?: {id: string; name: string; type: string} | null;
  /** The last step with an error: a failed one, or a webhook's last attempt */
  stepExecutions: {error: string | null; status: string; executeAfter: string | null}[];
};

export interface PaginatedExecutions {
  executions: WorkflowExecutionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type ExecutionDialog =
  | {type: 'none'}
  | {type: 'cancelAll'; cancelling: boolean}
  | {type: 'cancelOne'; execution: WorkflowExecutionRow; cancelling: boolean}
  | {type: 'retry'; execution: WorkflowExecutionRow; retrying: boolean};

const isActive = (execution: WorkflowExecutionRow) => execution.status === 'RUNNING' || execution.status === 'WAITING';

/** What went wrong in a run, or when its webhook tries again; nothing for a run with neither */
function ExecutionDetail({execution}: {execution: WorkflowExecutionRow}) {
  const last = execution.stepExecutions[0];
  if (execution.status === 'FAILED') {
    const reason = last?.error ?? execution.exitReason;
    return reason ? (
      <div className="max-w-xs truncate text-xs text-red-600" title={reason}>
        {reason}
      </div>
    ) : null;
  }
  if (execution.status === 'WAITING' && last?.status === 'SCHEDULED' && last.executeAfter) {
    return (
      <div className="max-w-xs truncate text-xs text-neutral-500" title={last.error ?? undefined}>
        Retrying at {dayjs(last.executeAfter).format('HH:mm')}
        {last.error ? `: ${last.error}` : ''}
      </div>
    );
  }
  return null;
}

/** The Executions tab of a workflow: its runs, what went wrong in them, and cancelling or retrying them */
export function WorkflowExecutionsTable({
  workflowId,
  activeExecutionsCount,
  onChange,
}: {
  workflowId: string;
  activeExecutionsCount: number;
  onChange: () => void;
}) {
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<ExecutionDialog>({type: 'none'});

  const {data, mutate} = useSWR<PaginatedExecutions>(
    `/workflows/${workflowId}/executions?page=${page}&pageSize=${PAGE_SIZE}`,
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      refreshInterval: latest => (latest?.executions.some(isActive) ? ACTIVE_REFRESH_MS : 0),
    },
  );

  const changed = () => {
    setDialog({type: 'none'});
    void mutate();
    onChange();
  };

  const handleCancelExecution = async (execution: WorkflowExecutionRow) => {
    setDialog({type: 'cancelOne', execution, cancelling: true});
    try {
      await network.fetch('DELETE', `/workflows/${workflowId}/executions/${execution.id}`);
      toast.success('Execution canceled');
      changed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t cancel the execution. Try again.');
      setDialog({type: 'cancelOne', execution, cancelling: false});
    }
  };

  const handleCancelAllExecutions = async () => {
    setDialog({type: 'cancelAll', cancelling: true});
    try {
      const result = await network.fetch<{cancelled: number}>('POST', `/workflows/${workflowId}/executions/cancel-all`);
      toast.success(`Canceled ${result.cancelled} execution${result.cancelled === 1 ? '' : 's'}`);
      changed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t cancel those executions. Try again.');
      setDialog({type: 'cancelAll', cancelling: false});
    }
  };

  const handleRetryExecution = async (execution: WorkflowExecutionRow) => {
    setDialog({type: 'retry', execution, retrying: true});
    try {
      await network.fetch('POST', `/workflows/${workflowId}/executions/${execution.id}/retry`);
      toast.success('Retrying the execution');
      changed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t retry the execution. Try again.');
      setDialog({type: 'retry', execution, retrying: false});
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Workflow executions</CardTitle>
              <CardDescription>View and manage all executions of this workflow</CardDescription>
            </div>
            {activeExecutionsCount > 0 && (
              <Button variant="outline" onClick={() => setDialog({type: 'cancelAll', cancelling: false})}>
                Cancel All Active ({activeExecutionsCount})
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!data?.executions.length ? (
            <EmptyState
              icon={Users}
              title="No executions yet"
              description="This workflow hasn't been executed yet. Enable it to start processing contacts."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Contact
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Current step
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Started
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-neutral-200">
                    {data.executions.map(execution => (
                      <tr key={execution.id} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-neutral-900">
                          {execution.contact.email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge
                            variant={
                              execution.status === 'COMPLETED'
                                ? 'success'
                                : execution.status === 'FAILED'
                                  ? 'destructive'
                                  : execution.status === 'WAITING'
                                    ? 'warning'
                                    : execution.status === 'RUNNING'
                                      ? 'default'
                                      : 'neutral'
                            }
                          >
                            {execution.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-500">
                          {execution.currentStep?.name ?? '-'}
                          <ExecutionDetail execution={execution} />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-500">
                          <div className="group relative inline-block cursor-help">
                            {dayjs(execution.startedAt).fromNow()}
                            <div className="hidden group-hover:block absolute z-10 w-48 p-2 bg-neutral-900 text-white text-xs rounded shadow-md bottom-full left-1/2 transform -translate-x-1/2 mb-1 whitespace-nowrap">
                              {dayjs(execution.startedAt).format('DD MMMM YYYY, hh:mm')}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          {isActive(execution) && (
                            <Button
                              variant="destructiveGhost"
                              size="sm"
                              onClick={() => setDialog({type: 'cancelOne', execution, cancelling: false})}
                            >
                              Cancel
                            </Button>
                          )}
                          {execution.status === 'FAILED' &&
                            execution.currentStep &&
                            canRetryStepType(execution.currentStep.type) && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDialog({type: 'retry', execution, retrying: false})}
                              >
                                Retry
                              </Button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.totalPages > 1 && (
                <div className="flex items-center justify-between mt-6">
                  <p className="text-sm text-neutral-500">
                    Showing {(page - 1) * data.pageSize + 1} to {Math.min(page * data.pageSize, data.total)} of{' '}
                    {data.total} executions
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage(p => p - 1)} disabled={page === 1}>
                      Previous
                    </Button>
                    <span className="text-sm text-neutral-700">
                      Page {page} of {data.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => p + 1)}
                      disabled={page === data.totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Retry Execution Confirmation */}
      <ConfirmDialog
        open={dialog.type === 'retry'}
        onOpenChange={open => !open && setDialog({type: 'none'})}
        onConfirm={() => {
          if (dialog.type === 'retry') {
            return handleRetryExecution(dialog.execution);
          }
        }}
        title="Retry this execution?"
        icon={RotateCcw}
        description={
          dialog.type === 'retry' ? (
            <>
              Runs <strong>{dialog.execution.currentStep?.name ?? 'the step it stopped on'}</strong> again for{' '}
              <strong>{dialog.execution.contact.email}</strong>, once, and carries on with the steps after it. This
              execution started {dayjs(dialog.execution.startedAt).fromNow()}.
            </>
          ) : undefined
        }
        confirmText="Retry"
        cancelText="Keep it failed"
        status={dialog.type === 'retry' && dialog.retrying ? 'loading' : 'idle'}
      />

      {/* Cancel Single Execution Confirmation */}
      <ConfirmDialog
        open={dialog.type === 'cancelOne'}
        onOpenChange={open => !open && setDialog({type: 'none'})}
        onConfirm={() => {
          if (dialog.type === 'cancelOne') {
            return handleCancelExecution(dialog.execution);
          }
        }}
        title="Cancel this execution?"
        icon={CircleStop}
        description={
          dialog.type === 'cancelOne' ? (
            <>
              Stops this workflow for <strong>{dialog.execution.contact.email}</strong>. They won&apos;t receive any
              remaining emails or actions from it. This can&apos;t be undone.
            </>
          ) : undefined
        }
        confirmText="Cancel execution"
        cancelText="Keep running"
        variant="destructive"
        status={dialog.type === 'cancelOne' && dialog.cancelling ? 'loading' : 'idle'}
      />

      {/* Cancel All Executions Confirmation */}
      <ConfirmDialog
        open={dialog.type === 'cancelAll'}
        onOpenChange={open => !open && setDialog({type: 'none'})}
        onConfirm={handleCancelAllExecutions}
        title="Cancel every active execution?"
        icon={CircleStop}
        description={
          <>
            Stops this workflow for all <strong>{activeExecutionsCount}</strong> contact
            {activeExecutionsCount !== 1 ? 's' : ''} currently in it. They won&apos;t receive any remaining emails or
            actions. This can&apos;t be undone.
          </>
        }
        confirmText={`Cancel ${activeExecutionsCount} execution${activeExecutionsCount !== 1 ? 's' : ''}`}
        cancelText="Keep running"
        variant="destructive"
        status={dialog.type === 'cancelAll' && dialog.cancelling ? 'loading' : 'idle'}
      />
    </>
  );
}

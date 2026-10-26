import {ContactSchemas} from '@plunk/shared';
import type {BulkContactActionSelector} from '@plunk/types';
import {Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@plunk/ui';
import {AlertTriangle, Check, EyeOff, Loader2, Minus} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {network} from '../../lib/network';

interface BulkActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  operation: 'subscribe' | 'unsubscribe' | 'delete' | null;
  selector: BulkContactActionSelector;
  targetCount: number;
  onSuccess: () => void;
}

interface BulkActionResult {
  operation: 'subscribe' | 'unsubscribe' | 'delete';
  totalRequested: number;
  /** Contacts whose state was actually changed by this run. */
  successCount: number;
  /** Subscribe/unsubscribe only: contacts that were already in the target state. */
  unchangedCount: number;
  /** Contacts that errored or weren't found. */
  failureCount: number;
  errors: Array<{contactId: string; email: string; error: string}>;
}

export function BulkActionsDialog({open, onOpenChange, operation, selector, targetCount, onSuccess}: BulkActionsDialogProps) {
  const [, setJobId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [result, setResult] = useState<BulkActionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);

  // Clean up polling on unmount or dialog close
  useEffect(() => {
    if (!open) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setTimeout(() => {
        setJobId(null);
        setProgress(0);
        setStatus('idle');
        setResult(null);
        setErrorMessage(null);
      }, 300);
    }
  }, [open]);

  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await network.fetch<{
        id: string;
        state: string;
        progress: number;
        result: BulkActionResult | null;
        failedReason?: string;
      }>('GET', `/contacts/bulk/${jobId}`);

      setProgress(response.progress || 0);

      if (response.state === 'completed') {
        setStatus('completed');
        setResult(response.result);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        if (response.result) {
          toast.success(buildToastSummary(response.result));
        }

        onSuccess();
      } else if (response.state === 'failed') {
        setStatus('failed');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        const errorMsg = response.failedReason || 'Operation failed';
        setErrorMessage(errorMsg);
        toast.error(errorMsg);
      } else if (response.state === 'active') {
        setStatus('processing');
      }
    } catch (error) {
      console.error('Failed to poll job status:', error);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setStatus('failed');
      toast.error('Lost track of the job. It may still be running.');
    }
  };

  const handleConfirm = async () => {
    if (!operation) return;

    setIsProcessing(true);
    setStatus('processing');

    try {
      const endpoint = `/contacts/bulk-${operation}`;
      const data = await network.fetch<{jobId: string; message: string}, typeof ContactSchemas.bulkAction>(
        'POST',
        endpoint,
        selector,
      );

      setJobId(data.jobId);

      // Start polling for job status
      pollIntervalRef.current = setInterval(() => {
        void pollJobStatus(data.jobId);
      }, 1000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Couldn’t start the job. Try again.';
      setErrorMessage(errorMsg);
      toast.error(errorMsg);
      setStatus('failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (status === 'processing') {
      setShowCloseConfirmDialog(true);
      return;
    }
    onOpenChange(false);
  };

  const confirmClose = () => {
    onOpenChange(false);
  };

  const copy = getOperationCopy(operation);

  const isQueueing = status === 'processing' && progress === 0;
  const dialogTitle =
    status === 'completed'
      ? copy.completedTitle
      : status === 'processing'
      ? copy.progressTitle
      : status === 'failed'
      ? copy.failedTitle
      : copy.title;

  const handleRetry = () => {
    setErrorMessage(null);
    setStatus('idle');
    void handleConfirm();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="transition-colors">{dialogTitle}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {status === 'idle' && (
              <div className="space-y-3 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <p className="text-sm text-neutral-700 leading-relaxed">
                  {copy.confirmVerb}{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {targetCount.toLocaleString()} contact{targetCount !== 1 ? 's' : ''}
                  </span>
                  ?
                  {copy.skipNote && <span className="text-neutral-500"> {copy.skipNote}</span>}
                </p>
                {operation === 'delete' && (
                  <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                    <p className="leading-relaxed">
                      <span className="font-medium">This action cannot be undone.</span> Contacts and their event history will be permanently removed.
                    </p>
                  </div>
                )}
                {selector.mode === 'query' && (
                  <p className="text-xs text-neutral-500 leading-relaxed">
                    Contacts are evaluated when the job runs — any added in the meantime may also be included.
                  </p>
                )}
              </div>
            )}

            {status === 'processing' && (
              <div className="space-y-3 py-1 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="flex items-center gap-2 text-neutral-600">
                    {isQueueing && <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />}
                    <span>
                      {isQueueing
                        ? 'Queued — starting up…'
                        : `${copy.processingLabel} ${targetCount.toLocaleString()} contact${targetCount !== 1 ? 's' : ''}`}
                    </span>
                  </span>
                  <span
                    className={`tabular-nums font-medium transition-opacity ${
                      isQueueing ? 'text-neutral-400' : 'text-neutral-900'
                    }`}
                  >
                    {progress}%
                  </span>
                </div>
                <div className="relative w-full bg-neutral-100 rounded-full h-1.5 overflow-hidden">
                  {isQueueing ? (
                    <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-neutral-300 motion-safe:animate-[indeterminate_1.4s_ease-in-out_infinite]" />
                  ) : (
                    <div
                      className="bg-neutral-900 h-full rounded-full transition-[width] duration-500 ease-out"
                      style={{width: `${progress}%`}}
                    />
                  )}
                </div>
              </div>
            )}

            {status === 'completed' && result && <BulkResultSummary result={result} />}

            {status === 'failed' && (
              <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
                <p className="leading-relaxed">{errorMessage || 'Something went wrong. Please try again.'}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            {status === 'idle' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isProcessing}
                  variant={operation === 'delete' ? 'destructive' : 'default'}
                >
                  {isProcessing ? 'Starting…' : copy.confirmButton}
                </Button>
              </>
            ) : status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Close
                </Button>
                <Button type="button" onClick={handleRetry} variant={operation === 'delete' ? 'destructive' : 'default'}>
                  Try again
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={handleClose}
                variant={status === 'completed' ? 'default' : 'outline'}
              >
                {status === 'completed' ? 'Done' : 'Hide'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showCloseConfirmDialog}
        onOpenChange={setShowCloseConfirmDialog}
        onConfirm={confirmClose}
        title="Hide this dialog?"
        description="The job keeps running and your contacts are still updated. You just won't see the result here."
        cancelText="Keep watching"
        confirmText="Hide"
        icon={EyeOff}
      />
    </>
  );
}

interface OperationCopy {
  title: string;
  progressTitle: string;
  completedTitle: string;
  failedTitle: string;
  confirmVerb: string;
  confirmButton: string;
  processingLabel: string;
  /** Past-tense verb used in result rows: "12 subscribed". */
  changedVerb: string;
  /** Result-state noun phrase: "contacts subscribed" — pluralisation handled separately. */
  summaryNoun: string;
  /** Past participle for "already X": "already subscribed". null = no skip case. */
  alreadyState: string | null;
  /** Note shown next to the confirm prompt for ops with skip semantics. */
  skipNote: string | null;
}

function getOperationCopy(operation: 'subscribe' | 'unsubscribe' | 'delete' | null): OperationCopy {
  switch (operation) {
    case 'subscribe':
      return {
        title: 'Subscribe contacts',
        progressTitle: 'Subscribing…',
        completedTitle: 'Subscribed',
        failedTitle: "Couldn't subscribe contacts",
        confirmVerb: 'Subscribe',
        confirmButton: 'Subscribe',
        processingLabel: 'Subscribing',
        changedVerb: 'subscribed',
        summaryNoun: 'subscribed',
        alreadyState: 'already subscribed',
        skipNote: 'Already-subscribed contacts will be skipped.',
      };
    case 'unsubscribe':
      return {
        title: 'Unsubscribe contacts',
        progressTitle: 'Unsubscribing…',
        completedTitle: 'Unsubscribed',
        failedTitle: "Couldn't unsubscribe contacts",
        confirmVerb: 'Unsubscribe',
        confirmButton: 'Unsubscribe',
        processingLabel: 'Unsubscribing',
        changedVerb: 'unsubscribed',
        summaryNoun: 'unsubscribed',
        alreadyState: 'already unsubscribed',
        skipNote: 'Already-unsubscribed contacts will be skipped.',
      };
    case 'delete':
      return {
        title: 'Delete contacts',
        progressTitle: 'Deleting…',
        completedTitle: 'Deleted',
        failedTitle: "Couldn't delete contacts",
        confirmVerb: 'Permanently delete',
        confirmButton: 'Delete',
        processingLabel: 'Deleting',
        changedVerb: 'deleted',
        summaryNoun: 'removed',
        alreadyState: null,
        skipNote: null,
      };
    default:
      return {
        title: 'Process contacts',
        progressTitle: 'Processing…',
        completedTitle: 'Done',
        failedTitle: 'Operation failed',
        confirmVerb: 'Process',
        confirmButton: 'Process',
        processingLabel: 'Processing',
        changedVerb: 'processed',
        summaryNoun: 'processed',
        alreadyState: null,
        skipNote: null,
      };
  }
}

function buildToastSummary(result: BulkActionResult): string {
  const copy = getOperationCopy(result.operation);
  const parts: string[] = [];
  if (result.successCount > 0) parts.push(`${result.successCount.toLocaleString()} ${copy.changedVerb}`);
  if (result.unchangedCount > 0 && copy.alreadyState) {
    parts.push(`${result.unchangedCount.toLocaleString()} ${copy.alreadyState}`);
  }
  if (result.failureCount > 0) parts.push(`${result.failureCount.toLocaleString()} failed`);
  if (parts.length === 0) return 'No contacts to update';
  return parts.join(' · ');
}

function BulkResultSummary({result}: {result: BulkActionResult}) {
  const copy = getOperationCopy(result.operation);
  const {successCount, unchangedCount, failureCount} = result;
  const noChanges = successCount === 0 && failureCount === 0 && unchangedCount > 0;
  const total = successCount + unchangedCount + failureCount;

  // Build the row list. The "primary" row is the row that represents what the
  // user actually got — usually the changed count, but when nothing changed we
  // promote the "already in state" row so the summary still has a clear lead.
  type Row = {
    key: string;
    label: string;
    count: number;
    primary?: boolean;
    tone?: 'default' | 'danger';
  };
  const rows: Row[] = [];

  if (noChanges && copy.alreadyState) {
    rows.push({key: 'already', label: copy.alreadyState, count: unchangedCount, primary: true});
  } else {
    rows.push({key: 'changed', label: copy.completedTitle, count: successCount, primary: true});
    if (unchangedCount > 0 && copy.alreadyState) {
      rows.push({key: 'already', label: copy.alreadyState, count: unchangedCount});
    }
  }
  if (failureCount > 0) {
    rows.push({key: 'failed', label: 'Failed', count: failureCount, tone: 'danger'});
  }

  return (
    <div className="space-y-3 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300">
      <div className="rounded-lg border border-neutral-200 overflow-hidden divide-y divide-neutral-100">
        {rows.map(row => {
          const isPrimary = !!row.primary;
          const isDanger = row.tone === 'danger';
          return (
            <div
              key={row.key}
              className={`flex items-center gap-3 px-4 ${isPrimary ? 'py-4' : 'py-2.5'}`}
            >
              {/* Status mark — only on the primary row. Subsequent rows leave the
                  same column blank to keep the labels in a single visual track. */}
              <div className="w-7 shrink-0 flex items-center">
                {isPrimary && (
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full ${
                      noChanges ? 'bg-neutral-100 text-neutral-500' : 'bg-neutral-900 text-white'
                    }`}
                  >
                    {noChanges ? (
                      <Minus className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    )}
                  </div>
                )}
              </div>
              <div
                className={`flex-1 first-letter:capitalize ${
                  isPrimary
                    ? 'text-sm font-medium text-neutral-900'
                    : isDanger
                    ? 'text-sm text-red-600'
                    : 'text-sm text-neutral-500'
                }`}
              >
                {row.label}
              </div>
              <div
                className={`tabular-nums tracking-tight ${
                  isPrimary
                    ? 'text-2xl font-semibold text-neutral-900 leading-none'
                    : isDanger
                    ? 'text-sm font-medium text-red-700'
                    : 'text-sm font-medium text-neutral-700'
                }`}
              >
                {row.count.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>

      {total > 1 && rows.length > 1 && (
        <div className="px-4 flex items-baseline justify-between text-xs text-neutral-500">
          <span>Total processed</span>
          <span className="tabular-nums font-medium text-neutral-700">{total.toLocaleString()}</span>
        </div>
      )}

      {result.errors && result.errors.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700 select-none px-4">
            Show error details ({result.errors.length.toLocaleString()})
          </summary>
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-neutral-200 divide-y divide-neutral-100 text-xs">
            {result.errors.slice(0, 10).map((error, idx) => (
              <div key={idx} className="px-3 py-2 text-red-700">
                {error.error}
              </div>
            ))}
            {result.errors.length > 10 && (
              <div className="px-3 py-2 text-neutral-500">
                +{(result.errors.length - 10).toLocaleString()} more
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}


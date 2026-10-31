import type {AlertSchemas} from '@plunk/shared';
import type {FailureAlert} from '@plunk/types';
import {Alert, Button} from '@plunk/ui';
import {AlertTriangle} from 'lucide-react';
import Link from 'next/link';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {describeFailure, failuresUrl, shortError} from '../lib/failureAlerts';
import {network} from '../lib/network';

const POLL_MS = 60_000;
const SHOWN = 3;

/**
 * What failed in the project, or needs attention (its sending reputation, a domain), and has not
 * been reviewed (Plunk Lite): on every page until someone marks it reviewed, for the whole team. A
 * source that fails again after that shows up again.
 */
export function FailureBanner() {
  const {activeProject} = useActiveProject();
  const url = activeProject ? failuresUrl(activeProject.id) : null;
  const {data, mutate} = useSWR<{failures: FailureAlert[]}>(url, {refreshInterval: POLL_MS});
  const [reviewing, setReviewing] = useState(false);

  const failures = data?.failures ?? [];
  if (!url || failures.length === 0) {
    return null;
  }

  const shown = failures.slice(0, SHOWN);

  const review = async () => {
    setReviewing(true);
    try {
      // What was shown, each with the failure it showed: one that failed since, and the ones
      // behind "more", stay open
      await network.fetch<{reviewed: number}, typeof AlertSchemas.review>('POST', `${url}/review`, {
        seen: shown.map(failure => ({id: failure.id, lastAt: failure.lastAt})),
      });
      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t mark them reviewed. Try again.');
    } finally {
      setReviewing(false);
    }
  };

  return (
    <Alert variant="destructive" className="mb-6 bg-red-50 border-red-300">
      <AlertTriangle className="h-5 w-5 text-red-600" />
      <div className="ml-3 flex-1">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <h3 className="font-semibold text-red-900 mb-1">Something needs review</h3>
            <ul className="space-y-2">
              {shown.map(failure => (
                <li key={failure.id} className="text-sm text-red-800">
                  <span className="font-semibold">{failure.label}</span> · {describeFailure(failure)} ·{' '}
                  <Link href={failure.reviewPath} className="font-medium underline hover:text-red-950">
                    Review
                  </Link>
                  <span className="block truncate text-xs text-red-700" title={failure.lastError}>
                    {shortError(failure.lastError)}
                  </span>
                </li>
              ))}
            </ul>
            {failures.length > SHOWN && <p className="mt-2 text-xs text-red-700">+ {failures.length - SHOWN} more</p>}
          </div>
          <Button variant="outline" size="sm" onClick={review} disabled={reviewing} className="ml-4 shrink-0">
            {reviewing ? 'Marking…' : 'Mark as reviewed'}
          </Button>
        </div>
      </div>
    </Alert>
  );
}

import type {Segment} from '@plunk/db';
import {segmentEventName, slugifySegmentName} from '@plunk/shared';
import {AlertTriangle} from 'lucide-react';
import useSWR from 'swr';
import {ApiKeyDisplay} from './ApiKeyDisplay';

interface SegmentEventNamesProps {
  segment: Segment;
}

/**
 * The workflow events a tracked segment fires, ready to copy into a trigger or a wait step.
 * Warns when the name gives no slug, or the same slug as another tracked segment of the project.
 */
export function SegmentEventNames({segment}: SegmentEventNamesProps) {
  const {data: segments} = useSWR<Segment[]>('/segments', {revalidateOnFocus: false});
  const slug = slugifySegmentName(segment.name);
  const sharedWith = (segments ?? []).filter(
    s => s.id !== segment.id && s.trackMembership && slugifySegmentName(s.name) === slug,
  );

  return (
    <div className="space-y-3">
      <ApiKeyDisplay label="Entry event" value={segmentEventName(segment.name, 'entry')} />
      <ApiKeyDisplay label="Exit event" value={segmentEventName(segment.name, 'exit')} />
      {segment.type === 'STATIC' && (
        <p className="text-xs text-neutral-500">
          Adding a contact who is already a member through the API fires the entry event again. A workflow only runs
          again for them with <em>Allow re-entry</em> on — and with it on, workflows that add contacts to each
          other&apos;s segments can loop.
        </p>
      )}
      {(slug === '' || sharedWith.length > 0) && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {slug === ''
            ? 'This name has no letters or digits to build the event name from. Rename the segment.'
            : `Same event names as ${sharedWith.map(s => `“${s.name}”`).join(', ')}. Workflows can tell them apart with a condition on event.segmentId.`}
        </p>
      )}
    </div>
  );
}

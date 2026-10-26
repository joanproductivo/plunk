import type {Segment} from '@plunk/db';
import type {SegmentSchemas} from '@plunk/shared';
import type {ContactSegments, SegmentRef} from '@plunk/types';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@plunk/ui';
import {X} from 'lucide-react';
import Link from 'next/link';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {network} from '../../lib/network';
import {addSegmentMembers} from '../../lib/segmentMembers';

interface ContactSegmentsCardProps {
  contactId: string;
  /** Static segment members are added and removed by email */
  email: string;
}

/**
 * The segments a contact is in. Static ones can be left or joined from here; dynamic ones only
 * follow their filter, so they are listed in grey.
 */
export function ContactSegmentsCard({contactId, email}: ContactSegmentsCardProps) {
  const {data: segments, error, mutate} = useSWR<ContactSegments>(`/contacts/${contactId}/segments`);
  const {data: allSegments} = useSWR<Segment[]>('/segments', {revalidateOnFocus: false});
  const [isBusy, setIsBusy] = useState(false);

  const joinable = (allSegments ?? []).filter(
    segment => segment.type === 'STATIC' && !segments?.static.some(s => s.id === segment.id),
  );

  const changeMembership = async (segment: SegmentRef, action: 'add' | 'remove') => {
    setIsBusy(true);
    try {
      // The endpoints answer 200 even when nothing changed (the email no longer exists, or the
      // contact had already left), so say what actually happened
      if (action === 'add') {
        const {added} = await addSegmentMembers(segment.id, [email], {createMissing: false});
        if (added > 0) toast.success(`Added to ${segment.name}`);
        else toast.error(`Couldn’t add ${email} to ${segment.name}. Reload the page and try again.`);
      } else {
        const {removed} = await network.fetch<{removed: number}, typeof SegmentSchemas.members>(
          'DELETE',
          `/segments/${segment.id}/members`,
          {emails: [email]},
        );
        if (removed > 0) toast.success(`Removed from ${segment.name}`);
        else toast.info(`${email} was no longer in ${segment.name}`);
      }
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t update the segment. Try again.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Segments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-neutral-500">Couldn’t load this contact’s segments.</p>
        ) : !segments ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-xs font-medium text-neutral-700">Static</p>
              {segments.static.length === 0 ? (
                <p className="text-sm text-neutral-500">Not in any static segment.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {segments.static.map(segment => (
                    <Badge key={segment.id} variant="outline" className="gap-1 pr-1 font-medium">
                      <Link href={`/segments/${segment.id}`} className="hover:underline">
                        {segment.name}
                      </Link>
                      <button
                        type="button"
                        onClick={() => void changeMembership(segment, 'remove')}
                        disabled={isBusy}
                        className="rounded-full p-0.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
                        aria-label={`Remove from ${segment.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {joinable.length > 0 && (
                <Select
                  value=""
                  onValueChange={segmentId => {
                    const segment = joinable.find(s => s.id === segmentId);
                    if (segment) void changeMembership(segment, 'add');
                  }}
                  disabled={isBusy}
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Add to a static segment">
                    <SelectValue placeholder="Add to a segment…" />
                  </SelectTrigger>
                  <SelectContent>
                    {joinable.map(segment => (
                      <SelectItem key={segment.id} value={segment.id}>
                        {segment.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {segments.dynamic.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-neutral-700">Dynamic</p>
                <div className="flex flex-wrap gap-1.5">
                  {segments.dynamic.map(segment => (
                    <Badge key={segment.id} variant="neutral" className="font-normal">
                      <Link href={`/segments/${segment.id}`} className="hover:underline">
                        {segment.name}
                      </Link>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

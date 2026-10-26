import type {Segment} from '@plunk/db';
import {Badge, Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import {X} from 'lucide-react';
import Link from 'next/link';
import type {ReactNode} from 'react';
import useSWR from 'swr';

import {segmentName} from '../../lib/segments';

/** The project's segments, as every segment picker reads them */
export function useSegments() {
  return useSWR<Segment[]>('/segments', {revalidateOnFocus: false});
}

/** `segmentName` over the project's segments */
export function useSegmentName() {
  const {data: segments} = useSegments();
  return (id: string) => segmentName(segments, id);
}

interface SegmentChipProps {
  name: ReactNode;
  /** Links the name to the segment's page */
  href?: string;
  onRemove: () => void;
  removeLabel: string;
  disabled?: boolean;
}

/** A segment as a removable chip */
export function SegmentChip({name, href, onRemove, removeLabel, disabled}: SegmentChipProps) {
  return (
    <Badge variant="outline" className="gap-1 pr-1 font-medium">
      {href ? (
        <Link href={href} className="hover:underline">
          {name}
        </Link>
      ) : (
        name
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="rounded-full p-0.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
        aria-label={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}

interface StaticSegmentSelectProps {
  /** Segment ids not to offer, such as the ones already chosen */
  exclude: string[];
  onSelect: (segment: Segment) => void;
  placeholder: string;
  disabled?: boolean;
}

/** Picks one of the project's static segments; renders nothing when none is left to pick */
export function StaticSegmentSelect({exclude, onSelect, placeholder, disabled}: StaticSegmentSelectProps) {
  const {data: segments} = useSegments();
  const choices = (segments ?? []).filter(segment => segment.type === 'STATIC' && !exclude.includes(segment.id));

  if (choices.length === 0) {
    return null;
  }

  return (
    <Select
      value=""
      onValueChange={id => {
        const segment = choices.find(choice => choice.id === id);
        if (segment) onSelect(segment);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 text-xs" aria-label={placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {choices.map(segment => (
          <SelectItem key={segment.id} value={segment.id}>
            {segment.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

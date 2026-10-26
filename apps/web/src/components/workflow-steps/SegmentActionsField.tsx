import {WORKFLOW_SEGMENT_CHANGES_MAX} from '@plunk/shared';
import type {UpdateContactSegmentChanges} from '@plunk/types';
import {Label} from '@plunk/ui';

import {SegmentChip, StaticSegmentSelect, useSegmentName} from '../segments/SegmentPicker';

const ROWS: Array<{key: keyof UpdateContactSegmentChanges; label: string; verb: string; placeholder: string}> = [
  {key: 'add', label: 'Add to segments', verb: 'add to', placeholder: 'Add to a segment…'},
  {key: 'remove', label: 'Remove from segments', verb: 'remove from', placeholder: 'Remove from a segment…'},
];

interface SegmentActionsFieldProps {
  value: UpdateContactSegmentChanges;
  onChange: (next: UpdateContactSegmentChanges) => void;
}

/**
 * Picks the static segments an Update contact step adds to and removes from. A segment can be
 * in one list only. Ids that no longer match a segment are kept, shown as deleted, so saving
 * the step does not drop them silently.
 */
export function SegmentActionsField({value, onChange}: SegmentActionsFieldProps) {
  const nameOf = useSegmentName();
  const chosen = [...value.add, ...value.remove];

  return (
    <div className="space-y-3">
      {ROWS.map(row => (
        <div key={row.key} className="space-y-1.5">
          <Label>{row.label}</Label>
          {value[row.key].length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {value[row.key].map(id => (
                <SegmentChip
                  key={id}
                  name={nameOf(id)}
                  onRemove={() => onChange({...value, [row.key]: value[row.key].filter(other => other !== id)})}
                  removeLabel={`Don't ${row.verb} ${nameOf(id)}`}
                />
              ))}
            </div>
          )}
          {value[row.key].length < WORKFLOW_SEGMENT_CHANGES_MAX && (
            <StaticSegmentSelect
              exclude={chosen}
              onSelect={segment => onChange({...value, [row.key]: [...value[row.key], segment.id]})}
              placeholder={row.placeholder}
            />
          )}
        </div>
      ))}
      <p className="text-xs text-neutral-500 leading-relaxed">
        Removals run before additions. Adding a contact who is already in a segment counts as a new entry, so a segment
        that tracks membership fires its entry event again.
      </p>
    </div>
  );
}

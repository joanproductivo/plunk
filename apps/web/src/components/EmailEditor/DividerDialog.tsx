import {normalizeHexColor} from '@plunk/shared';
import {Button, Dialog, DialogContent, DialogHeader, DialogTitle} from '@plunk/ui';
import {useState} from 'react';

import {ColorField, OptionSelect} from './BlockFields';
import {
  DIVIDER_DEFAULTS,
  DIVIDER_SPACING,
  DIVIDER_THICKNESS,
  type DividerAttrs,
  type DividerSpacing,
  type DividerThickness,
} from './EmailDivider';
import type {BlockDialogProps} from './useBlockDialog';

const THICKNESSES: Record<DividerThickness, string> = {thin: 'Thin', medium: 'Medium', thick: 'Thick'};
const SPACINGS: Record<DividerSpacing, string> = {small: 'Small', medium: 'Medium', large: 'Large'};

/** Edits a divider; new ones are inserted with the defaults straight from the toolbar. */
export function DividerDialog({open, onOpenChange, initial, onSubmit}: BlockDialogProps<DividerAttrs>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit divider</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from `initial` */}
        <DividerForm initial={initial ?? DIVIDER_DEFAULTS} onSubmit={onSubmit} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DividerForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: DividerAttrs;
  onSubmit: (attrs: DividerAttrs) => void;
  onCancel: () => void;
}) {
  const [attrs, setAttrs] = useState<DividerAttrs>(initial);

  const set = <K extends keyof DividerAttrs>(key: K, value: DividerAttrs[K]) =>
    setAttrs(prev => ({...prev, [key]: value}));
  const color = normalizeHexColor(attrs.color);

  return (
    <div className="space-y-4">
      <ColorField id="divider-color" label="Color" value={attrs.color} onChange={value => set('color', value)} />
      <div className="grid grid-cols-2 gap-3">
        <OptionSelect
          label="Thickness"
          value={attrs.thickness}
          options={THICKNESSES}
          onChange={value => set('thickness', value)}
        />
        <OptionSelect
          label="Spacing"
          value={attrs.spacing}
          options={SPACINGS}
          onChange={value => set('spacing', value)}
        />
      </div>
      <div className="rounded border border-neutral-200 bg-white px-4">
        <div
          style={{
            borderTop: `${DIVIDER_THICKNESS[attrs.thickness]}px solid ${color ?? DIVIDER_DEFAULTS.color}`,
            margin: `${DIVIDER_SPACING[attrs.spacing]}px 0`,
          }}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={() => color && onSubmit({...attrs, color})} disabled={!color}>
          Save
        </Button>
      </div>
    </div>
  );
}

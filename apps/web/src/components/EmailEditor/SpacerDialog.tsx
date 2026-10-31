import {closestOption, SPACER_DEFAULT_HEIGHT, SPACER_HEIGHTS, type SpacerSize} from '@plunk/shared';
import {Button, Dialog, DialogContent, DialogHeader, DialogTitle} from '@plunk/ui';
import {useState} from 'react';

import {OptionSelect} from './BlockFields';
import type {SpacerAttrs} from './EmailSpacer';
import type {BlockDialogProps} from './useBlockDialog';

const SIZES: Record<SpacerSize, string> = {
  small: `Small (${SPACER_HEIGHTS.small}px)`,
  medium: `Medium (${SPACER_HEIGHTS.medium}px)`,
  large: `Large (${SPACER_HEIGHTS.large}px)`,
  xlarge: `Extra large (${SPACER_HEIGHTS.xlarge}px)`,
};

/** Edits a spacer; new ones are inserted with the default height straight from the toolbar. */
export function SpacerDialog({open, onOpenChange, initial, onSubmit}: BlockDialogProps<SpacerAttrs>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Edit spacer</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from `initial` */}
        <SpacerForm
          height={initial?.height ?? SPACER_DEFAULT_HEIGHT}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SpacerForm(props: {height: number; onSubmit: (attrs: SpacerAttrs) => void; onCancel: () => void}) {
  const [size, setSize] = useState<SpacerSize>(() => closestOption(SPACER_HEIGHTS, props.height));

  return (
    <div className="space-y-4">
      <OptionSelect label="Height" value={size} options={SIZES} onChange={setSize} />
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={() => props.onSubmit({height: SPACER_HEIGHTS[size]})}>
          Save
        </Button>
      </div>
    </div>
  );
}

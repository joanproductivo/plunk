import {
  BOX_DEFAULTS,
  BOX_RADIUS,
  boxPadding,
  type BoxStyle,
  contrastRatio,
  type EmailBrand,
  normalizeHexColor,
  suggestedTextColor,
  TEXT_CONTRAST,
} from '@plunk/shared';
import {Button, Checkbox, Dialog, DialogContent, DialogHeader, DialogTitle, Label} from '@plunk/ui';
import type {Editor} from '@tiptap/react';
import {useEffect, useRef, useState} from 'react';

import {BOX, boxAtSelection, unwrapBox, updateBox, wrapInBox} from './boxCommands';
import {ColorField, OptionSelect} from './BlockFields';
import {useFollowBlock} from './useBlockDialog';

// Below these, the brand's links and buttons are hard to make out on a box's background
const LINK_CONTRAST = 3;
const BUTTON_CONTRAST = 1.5;

const WIDTHS = {inset: 'With margin, rounded', full: 'Full width'};

/** A new box in `look`: a light grey one, its text in the brand's colour where it reads. */
export function newBox(look: EmailBrand): BoxStyle {
  return {...BOX_DEFAULTS, textColor: suggestedTextColor(BOX_DEFAULTS.backgroundColor, look.textColor)};
}

/**
 * Wires the box's settings to an editor. The toolbar opens the settings of the box the cursor is
 * in, or else wraps the blocks it touches in a new box, as the slash menu asks for one; a box's
 * settings button opens its own.
 */
export function useBoxDialog(editor: Editor | null, look: EmailBrand) {
  const [pos, setPos] = useState<number | null>(null);
  // Read when a box is made, so the events need not be wired again whenever the brand is
  const lookRef = useRef(look);
  useEffect(() => {
    lookRef.current = look;
  });

  useEffect(() => {
    if (!editor) return;
    const edit = ({pos: at}: {pos: number}) => {
      if (editor.state.doc.nodeAt(at)?.type.name === BOX) setPos(at);
    };
    const add = ({type}: {type: string}) => {
      if (type === BOX)
        editor
          .chain()
          .focus()
          .command(wrapInBox(newBox(lookRef.current)))
          .run();
    };
    editor.on('editBlock', edit);
    editor.on('newBlock', add);
    return () => {
      editor.off('editBlock', edit);
      editor.off('newBlock', add);
    };
  }, [editor]);

  useFollowBlock(editor, pos, setPos);

  const onToolbar = () => {
    if (!editor) return;
    const at = boxAtSelection(editor);
    if (at === null) {
      editor
        .chain()
        .focus()
        .command(wrapInBox(newBox(look)))
        .run();
    } else {
      setPos(at);
    }
  };

  const initial = pos === null ? null : ((editor?.state.doc.nodeAt(pos)?.attrs as BoxStyle | undefined) ?? null);
  // Changes leave the cursor where it was, in the box's text
  const run = (command: ReturnType<typeof updateBox>) => {
    editor?.chain().focus().command(command).run();
    setPos(null);
  };

  return {
    onToolbar,
    dialogProps: {
      open: initial !== null,
      onOpenChange: (open: boolean) => !open && setPos(null),
      initial,
      look,
      onSubmit: (attrs: BoxStyle) => pos !== null && run(updateBox(pos, attrs)),
      onRemove: () => pos !== null && run(unwrapBox(pos)),
    },
  };
}

interface BoxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: BoxStyle | null;
  look: EmailBrand;
  /** The background of the brand's buttons, to warn when they blend into the box. */
  buttonColor?: string;
  onSubmit: (attrs: BoxStyle) => void;
  onRemove: () => void;
}

export function BoxDialog({open, onOpenChange, initial, ...props}: BoxDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Box</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from the box */}
        {initial && <BoxForm initial={initial} {...props} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function BoxForm({
  initial,
  look,
  buttonColor,
  onSubmit,
  onRemove,
  onCancel,
}: Omit<BoxDialogProps, 'open' | 'onOpenChange' | 'initial'> & {initial: BoxStyle; onCancel: () => void}) {
  const [box, setBox] = useState(initial);
  // Automatic while the text colour is the one suggested for the background: it follows it
  const [auto, setAuto] = useState(initial.textColor === suggestedTextColor(initial.backgroundColor, look.textColor));

  const background = normalizeHexColor(box.backgroundColor);
  const text = normalizeHexColor(box.textColor);
  const setBackground = (value: string) => {
    const color = normalizeHexColor(value);
    setBox(prev => ({
      ...prev,
      backgroundColor: value,
      textColor: auto && color ? suggestedTextColor(color, look.textColor) : prev.textColor,
    }));
  };
  const setAutomatic = (on: boolean) => {
    setAuto(on);
    if (on && background) setBox(prev => ({...prev, textColor: suggestedTextColor(background, look.textColor)}));
  };

  const presets = [...new Set([BOX_DEFAULTS.backgroundColor, look.backgroundColor, look.linkColor, look.headingColor])]
    .map(color => normalizeHexColor(color))
    .filter((color): color is string => color !== null);
  const warnings = background
    ? [
        text && contrastRatio(text, background) < TEXT_CONTRAST && 'The text is hard to read on this background.',
        contrastRatio(look.linkColor, background) < LINK_CONTRAST &&
          'Links in the brand’s color are hard to read on this background.',
        buttonColor &&
          contrastRatio(buttonColor, background) < BUTTON_CONTRAST &&
          'Buttons in the brand’s style blend into this background.',
      ].filter((warning): warning is string => Boolean(warning))
    : [];
  const valid = background !== null && text !== null;

  return (
    <div className="space-y-4">
      <ColorField id="box-background" label="Background" value={box.backgroundColor} onChange={setBackground} />
      <div className="flex flex-wrap gap-2" aria-label="Brand colors">
        {presets.map(color => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={`Use ${color}`}
            onClick={() => setBackground(color)}
            className="h-6 w-6 rounded border border-neutral-300"
            style={{backgroundColor: color}}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="box-auto-text" checked={auto} onCheckedChange={checked => setAutomatic(checked === true)} />
        <Label htmlFor="box-auto-text" className="text-sm">
          Pick the text color for the background
        </Label>
      </div>
      {!auto && (
        <ColorField
          id="box-text"
          label="Text color"
          value={box.textColor}
          onChange={value => setBox(prev => ({...prev, textColor: value}))}
        />
      )}
      <OptionSelect
        label="Width"
        value={box.fullWidth ? 'full' : 'inset'}
        options={WIDTHS}
        onChange={value => setBox(prev => ({...prev, fullWidth: value === 'full'}))}
      />

      <div
        className="text-sm"
        style={{
          backgroundColor: background ?? undefined,
          color: text ?? undefined,
          padding: boxPadding(box.fullWidth),
          borderRadius: box.fullWidth ? 0 : BOX_RADIUS,
        }}
      >
        <p className="font-semibold">A heading in the box</p>
        <p>
          Text in the box, with <span style={{color: look.linkColor, textDecoration: 'underline'}}>a link</span>.
        </p>
      </div>
      {warnings.map(warning => (
        <p key={warning} className="text-xs text-amber-700">
          {warning}
        </p>
      ))}

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={onRemove}>
          Remove box
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => valid && onSubmit({...box, backgroundColor: background, textColor: text})}
            disabled={!valid}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

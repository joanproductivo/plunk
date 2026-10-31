import {
  BUTTON_DEFAULTS,
  type ButtonShape,
  type ButtonSize,
  type ButtonStyle,
  isSafeButtonHref,
  normalizeHexColor,
} from '@plunk/shared';
import {Button, Checkbox, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import {FileText} from 'lucide-react';
import {useState} from 'react';

import {ColorField, FontSelect, OptionSelect} from './BlockFields';
import {type ButtonAttrs, ButtonFace} from './EmailButton';
import {FileDialog} from './FileDialog';
import type {BlockDialogProps} from './useBlockDialog';

// Spaces outside Liquid tags would break the link (and read as custom HTML attributes).
function isValidHref(href: string): boolean {
  return isSafeButtonHref(href) && !/\s/.test(href.trim().replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, ''));
}

const SHAPES: Record<ButtonShape, string> = {rectangle: 'Rectangle', rounded: 'Rounded', pill: 'Pill'};
const SIZES: Record<ButtonSize, string> = {small: 'Small', medium: 'Medium', large: 'Large'};

type ButtonDialogProps = BlockDialogProps<ButtonAttrs> & {
  /** The look new buttons start from: the project brand's button, once loaded. */
  defaultStyle?: ButtonStyle;
  /** Whether files can be uploaded to link to (storage is configured). */
  canUpload?: boolean;
};

export function ButtonDialog({open, onOpenChange, initial, onSubmit, defaultStyle, canUpload}: ButtonDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit button' : 'Insert button'}</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from `initial` */}
        <ButtonForm
          initial={initial}
          defaultStyle={defaultStyle}
          canUpload={canUpload}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ButtonForm({
  initial,
  defaultStyle,
  canUpload,
  onSubmit,
  onCancel,
}: Omit<ButtonDialogProps, 'open' | 'onOpenChange'> & {onCancel: () => void}) {
  const [attrs, setAttrs] = useState<ButtonAttrs>(
    () => initial ?? {...(defaultStyle ?? BUTTON_DEFAULTS), text: '', href: ''},
  );
  const [showFileDialog, setShowFileDialog] = useState(false);

  const set = <K extends keyof ButtonAttrs>(key: K, value: ButtonAttrs[K]) =>
    setAttrs(prev => ({...prev, [key]: value}));
  const backgroundColor = normalizeHexColor(attrs.backgroundColor);
  const textColor = normalizeHexColor(attrs.textColor);
  const valid = attrs.text.trim() !== '' && isValidHref(attrs.href) && backgroundColor !== null && textColor !== null;

  const submit = () => {
    if (!valid) return;
    onSubmit({...attrs, text: attrs.text.trim(), href: attrs.href.trim(), backgroundColor, textColor});
  };

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="button-text" className="text-sm font-medium mb-2 block">
          Text
        </Label>
        <Input id="button-text" value={attrs.text} onChange={e => set('text', e.target.value)} placeholder="Shop now" />
      </div>
      <div>
        <Label htmlFor="button-href" className="text-sm font-medium mb-2 block">
          Link
        </Label>
        {/* Text, not url: links can be built with variables such as {{unsubscribeUrl}}. */}
        <Input
          id="button-href"
          value={attrs.href}
          onChange={e => set('href', e.target.value)}
          placeholder="https://example.com"
        />
        {attrs.href.trim() !== '' && !isValidHref(attrs.href) && (
          <p className="mt-1 text-xs text-red-700">
            Use an https://, mailto: or tel: link, a #anchor, or a {'{{variable}}'}.
          </p>
        )}
        {canUpload && (
          <>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setShowFileDialog(true)}>
              <FileText className="h-4 w-4 mr-1" />
              Link to a file
            </Button>
            <FileDialog open={showFileDialog} onOpenChange={setShowFileDialog} onPick={url => set('href', url)} />
          </>
        )}
      </div>
      <ButtonStyleFields idPrefix="button" value={attrs} onChange={style => setAttrs(prev => ({...prev, ...style}))} />
      <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
        <ButtonFace
          button={{
            ...attrs,
            backgroundColor: backgroundColor ?? BUTTON_DEFAULTS.backgroundColor,
            textColor: textColor ?? BUTTON_DEFAULTS.textColor,
          }}
          text={attrs.text.trim()}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={!valid}>
          {initial ? 'Save' : 'Insert'}
        </Button>
      </div>
    </div>
  );
}

/** A button's look: its colours, shape, size, font and width. Also edits the brand's default button. */
export function ButtonStyleFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: ButtonStyle;
  onChange: (value: ButtonStyle) => void;
}) {
  const set = <K extends keyof ButtonStyle>(key: K, next: ButtonStyle[K]) => onChange({...value, [key]: next});

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <ColorField
          id={`${idPrefix}-background`}
          label="Background"
          value={value.backgroundColor}
          onChange={next => set('backgroundColor', next)}
        />
        <ColorField
          id={`${idPrefix}-color`}
          label="Text color"
          value={value.textColor}
          onChange={next => set('textColor', next)}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <OptionSelect label="Shape" value={value.shape} options={SHAPES} onChange={next => set('shape', next)} />
        <OptionSelect label="Size" value={value.size} options={SIZES} onChange={next => set('size', next)} />
        <FontSelect label="Font" value={value.font} ownFont="Email's font" onChange={next => set('font', next)} />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-full-width`}
          checked={value.fullWidth}
          onCheckedChange={checked => set('fullWidth', checked === true)}
        />
        <Label htmlFor={`${idPrefix}-full-width`} className="text-sm">
          Full width
        </Label>
      </div>
    </>
  );
}

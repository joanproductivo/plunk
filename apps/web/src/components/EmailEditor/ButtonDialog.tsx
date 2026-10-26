import {
  BUTTON_DEFAULTS,
  type ButtonShape,
  type ButtonSize,
  type ButtonStyle,
  EMAIL_FONTS,
  type EmailFont,
  isSafeButtonHref,
  normalizeHexColor,
  toButtonStyle,
} from '@plunk/shared';
import {Button, Checkbox, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import {useState} from 'react';

import {ColorField, OptionSelect} from './BlockFields';
import {type ButtonAttrs, ButtonFace} from './EmailButton';
import type {BlockDialogProps} from './useBlockDialog';

// New buttons start from the look of the last one created in this browser.
const LAST_STYLE_KEY = 'plunk:email-button-style';

function lastStyle(): ButtonStyle {
  try {
    return toButtonStyle(JSON.parse(localStorage.getItem(LAST_STYLE_KEY) ?? 'null'));
  } catch {
    return BUTTON_DEFAULTS;
  }
}

function rememberStyle(button: ButtonStyle) {
  try {
    localStorage.setItem(LAST_STYLE_KEY, JSON.stringify(toButtonStyle(button)));
  } catch {
    // Private windows and blocked storage only lose the convenience.
  }
}

// Spaces outside Liquid tags would break the link (and read as custom HTML attributes).
function isValidHref(href: string): boolean {
  return isSafeButtonHref(href) && !/\s/.test(href.trim().replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, ''));
}

const SHAPES: Record<ButtonShape, string> = {rectangle: 'Rectangle', rounded: 'Rounded', pill: 'Pill'};
const SIZES: Record<ButtonSize, string> = {small: 'Small', medium: 'Medium', large: 'Large'};
// The email's own font is stored as no font of the button's own.
const EMAIL_FONT = 'email';
const FONTS: Record<EmailFont | typeof EMAIL_FONT, string> = {
  [EMAIL_FONT]: "Email's font",
  'modern-sans': 'Modern sans',
  'geometric-sans': 'Geometric sans',
  'rounded-sans': 'Rounded sans',
  'modern-serif': 'Modern serif',
  'book-serif': 'Book serif',
  'monospace': 'Monospace',
};

type ButtonDialogProps = BlockDialogProps<ButtonAttrs>;

export function ButtonDialog({open, onOpenChange, initial, onSubmit}: ButtonDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit button' : 'Insert button'}</DialogTitle>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so each opening starts from `initial` */}
        <ButtonForm initial={initial} onSubmit={onSubmit} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ButtonForm({
  initial,
  onSubmit,
  onCancel,
}: Omit<ButtonDialogProps, 'open' | 'onOpenChange'> & {onCancel: () => void}) {
  const [attrs, setAttrs] = useState<ButtonAttrs>(() => initial ?? {...lastStyle(), text: '', href: ''});

  const set = <K extends keyof ButtonAttrs>(key: K, value: ButtonAttrs[K]) =>
    setAttrs(prev => ({...prev, [key]: value}));
  const backgroundColor = normalizeHexColor(attrs.backgroundColor);
  const textColor = normalizeHexColor(attrs.textColor);
  const valid = attrs.text.trim() !== '' && isValidHref(attrs.href) && backgroundColor !== null && textColor !== null;

  const submit = () => {
    if (!valid) return;
    const result = {...attrs, text: attrs.text.trim(), href: attrs.href.trim(), backgroundColor, textColor};
    if (!initial) rememberStyle(result);
    onSubmit(result);
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
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ColorField
          id="button-background"
          label="Background"
          value={attrs.backgroundColor}
          onChange={value => set('backgroundColor', value)}
        />
        <ColorField
          id="button-color"
          label="Text color"
          value={attrs.textColor}
          onChange={value => set('textColor', value)}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <OptionSelect label="Shape" value={attrs.shape} options={SHAPES} onChange={value => set('shape', value)} />
        <OptionSelect label="Size" value={attrs.size} options={SIZES} onChange={value => set('size', value)} />
        <OptionSelect
          label="Font"
          value={attrs.font ?? EMAIL_FONT}
          options={FONTS}
          onChange={value => set('font', value === EMAIL_FONT ? null : value)}
          optionStyle={value => ({fontFamily: value === EMAIL_FONT ? undefined : EMAIL_FONTS[value]})}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="button-full-width"
          checked={attrs.fullWidth}
          onCheckedChange={v => set('fullWidth', v === true)}
        />
        <Label htmlFor="button-full-width" className="text-sm">
          Full width
        </Label>
      </div>
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

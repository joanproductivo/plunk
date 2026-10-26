import {EMAIL_FONTS, type EmailFont, normalizeHexColor} from '@plunk/shared';
import {Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import type {CSSProperties} from 'react';

/** Fields shared by the dialogs of the editor's blocks. */

export function OptionSelect<T extends string>(props: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
  optionStyle?: (value: T) => CSSProperties;
}) {
  return (
    <div>
      <Label className="text-sm font-medium mb-2 block">{props.label}</Label>
      <Select value={props.value} onValueChange={value => props.onChange(value as T)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(props.options) as T[]).map(key => (
            <SelectItem key={key} value={key}>
              <span style={props.optionStyle?.(key)}>{props.options[key]}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ColorField(props: {id: string; label: string; value: string; onChange: (value: string) => void}) {
  const valid = normalizeHexColor(props.value) !== null;

  return (
    <div>
      <Label htmlFor={props.id} className="text-sm font-medium mb-2 block">
        {props.label}
      </Label>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={props.label}
          value={normalizeHexColor(props.value) ?? '#000000'}
          onChange={e => props.onChange(e.target.value)}
          className="h-9 w-10 cursor-pointer rounded border border-neutral-200"
        />
        <Input id={props.id} value={props.value} onChange={e => props.onChange(e.target.value)} className="font-mono" />
      </div>
      {!valid && <p className="mt-1 text-xs text-red-700">Use a hex color such as #e11d48.</p>}
    </div>
  );
}

const FONTS: Record<EmailFont, string> = {
  'modern-sans': 'Modern sans',
  'geometric-sans': 'Geometric sans',
  'rounded-sans': 'Rounded sans',
  'modern-serif': 'Modern serif',
  'book-serif': 'Book serif',
  'monospace': 'Monospace',
};
// No font of its own, which `ownFont` names: the email's font for a button, the system's for a brand
const OWN_FONT = 'own';

export function FontSelect(props: {
  label: string;
  value: EmailFont | null;
  ownFont: string;
  onChange: (value: EmailFont | null) => void;
}) {
  return (
    <OptionSelect<EmailFont | typeof OWN_FONT>
      label={props.label}
      value={props.value ?? OWN_FONT}
      options={{[OWN_FONT]: props.ownFont, ...FONTS}}
      onChange={value => props.onChange(value === OWN_FONT ? null : value)}
      optionStyle={value => ({fontFamily: value === OWN_FONT ? undefined : EMAIL_FONTS[value]})}
    />
  );
}

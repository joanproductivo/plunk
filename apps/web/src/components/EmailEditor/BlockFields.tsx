import {normalizeHexColor} from '@plunk/shared';
import {Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import type {CSSProperties} from 'react';

/** Fields shared by the dialogs of the editor's blocks (see ButtonDialog). */

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

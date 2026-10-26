import {preheaderToText, textToPreheader} from '@plunk/shared';
import {Input, Label} from '@plunk/ui';
import {useTemplateValidation} from '../../lib/hooks/useTemplateValidation';

interface PreheaderFieldProps {
  /** The preheader as stored in the body, HTML-escaped. */
  value: string;
  onChange: (value: string) => void;
}

/** The preview text most inboxes show after the subject line. */
export function PreheaderField({value, onChange}: PreheaderFieldProps) {
  // Checked as stored, the way the API checks the body when saving
  const syntaxIssue = useTemplateValidation(value);

  return (
    <div className="border-b border-neutral-200 px-4 py-3 space-y-1.5">
      <Label htmlFor="email-preheader" className="text-xs text-neutral-600">
        Preview text
      </Label>
      <Input
        id="email-preheader"
        value={preheaderToText(value)}
        onChange={e => onChange(textToPreheader(e.target.value))}
        placeholder="Shown after the subject in most inboxes"
        className="h-8 text-sm"
      />
      {syntaxIssue ? (
        <p className="text-xs text-red-700">{syntaxIssue.message}. Saving will fail until this is fixed.</p>
      ) : (
        <p className="text-[11px] text-neutral-500">Optional. Variables such as {'{{name}}'} work here too.</p>
      )}
    </div>
  );
}

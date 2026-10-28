import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@plunk/ui';
import {ChevronDown, Plus, ShieldCheck, Trash2} from 'lucide-react';
import Link from 'next/link';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {WIKI_URI} from '../../lib/constants';

import {type EditStepDialogProps, getStepConfig, StepDialogShell, useStepUpdate} from './shared';

interface HeaderEntry {
  key: string;
  value: string;
}

/** Plunk Lite: what a custom payload starts from */
const DEFAULT_CUSTOM_BODY = {email: '{{email}}', id: '{{id}}'};

/** Plunk Lite: a custom payload as typed, or undefined when it is not JSON the step accepts */
function parsePayload(text: string): Record<string, unknown> | unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown> | unknown[]) : undefined;
  } catch {
    return undefined;
  }
}

export function WebhookStepDialog({step, workflowId, open, onOpenChange, onSuccess}: EditStepDialogProps) {
  const config = getStepConfig(step);

  const initialHeaders: HeaderEntry[] =
    config.headers && typeof config.headers === 'object'
      ? Object.entries(config.headers as Record<string, unknown>).map(([key, value]) => ({key, value: String(value)}))
      : [];

  const [name, setName] = useState(step.name);
  const [webhookUrl, setWebhookUrl] = useState(String(config.url ?? ''));
  const [webhookMethod, setWebhookMethod] = useState(String(config.method ?? 'POST'));
  const [webhookHeaders, setWebhookHeaders] = useState<HeaderEntry[]>(initialHeaders);
  const [showWebhookInfo, setShowWebhookInfo] = useState(false);
  // Plunk Lite: a body set before -- here or through the API -- is kept, and opens as the custom payload.
  // Not a bare value (null, a string), which the step sends as no body at all.
  const hasBody = config.body !== null && typeof config.body === 'object';
  const [customPayload, setCustomPayload] = useState(hasBody);
  const [payloadText, setPayloadText] = useState(() =>
    JSON.stringify(hasBody ? config.body : DEFAULT_CUSTOM_BODY, null, 2),
  );

  // Plunk Lite: whether the receiver set a signing secret. The secret itself is never sent back.
  const {data: signing} = useSWR<{active: boolean}>(
    open ? `/workflows/${workflowId}/steps/${step.id}/signing-secret` : null,
    {revalidateOnFocus: false},
  );

  const {update, isSubmitting} = useStepUpdate(workflowId, step.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!webhookUrl) {
      toast.error('Webhook URL is required');
      return;
    }

    const headers: Record<string, string> = {};
    webhookHeaders.forEach(header => {
      if (header.key.trim() && header.value.trim()) {
        headers[header.key.trim()] = header.value.trim();
      }
    });

    let body: Record<string, unknown> | unknown[] | undefined;
    if (customPayload) {
      body = parsePayload(payloadText);
      if (!body) {
        toast.error('Payload must be valid JSON (an object or an array)');
        return;
      }
    }

    const ok = await update({
      name,
      config: {url: webhookUrl, method: webhookMethod, headers, ...(body ? {body} : {})},
    });

    if (ok) {
      onOpenChange(false);
      onSuccess();
    }
  };

  const updateHeader = (index: number, patch: Partial<HeaderEntry>) => {
    setWebhookHeaders(prev => prev.map((h, i) => (i === index ? {...h, ...patch} : h)));
  };

  return (
    <StepDialogShell
      step={step}
      open={open}
      onOpenChange={onOpenChange}
      name={name}
      onNameChange={setName}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
    >
      <div className="space-y-4">
        <Collapsible open={showWebhookInfo} onOpenChange={setShowWebhookInfo}>
          <div className="flex items-center justify-between">
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700">
              <ChevronDown className={`h-3 w-3 transition-transform ${showWebhookInfo ? 'rotate-180' : ''}`} />
              {showWebhookInfo ? 'Hide' : 'View'} default payload
            </CollapsibleTrigger>
            <Link
              href={`${WIKI_URI}/guides/webhooks#webhook-payload`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-neutral-500 hover:text-neutral-700 underline underline-offset-2"
            >
              Webhook guide
            </Link>
          </div>
          <CollapsibleContent className="mt-2">
            <pre className="text-[10px] bg-neutral-50 p-2 rounded border border-neutral-200 overflow-x-auto">
              {`{
  "contact": { "email": "user@example.com", "subscribed": true, "data": { ... } },
  "workflow": { "id": "wf_...", "name": "Welcome Series" },
  "execution": { "id": "exec_...", "startedAt": "2025-01-19T..." },
  "event": { ... }
}`}
            </pre>
          </CollapsibleContent>
        </Collapsible>

        {signing?.active && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-green-200 bg-green-50">
            <ShieldCheck className="h-4 w-4 text-green-700 mt-0.5 shrink-0" />
            <div className="text-xs text-green-900">
              <Badge variant="success" className="mb-1">
                Signed requests
              </Badge>
              <p>Requests carry an X-Plunk-Signature header. The secret is set through the API and never shown.</p>
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="editWebhookUrl">URL</Label>
          <Input
            className="font-mono mt-1.5"
            id="editWebhookUrl"
            type="url"
            value={webhookUrl}
            onChange={e => setWebhookUrl(e.target.value)}
            required
            placeholder="https://api.example.com/webhook"
          />
        </div>

        <div>
          <Label htmlFor="editWebhookMethod">Method</Label>
          <Select value={webhookMethod} onValueChange={setWebhookMethod}>
            <SelectTrigger id="editWebhookMethod" className="font-mono mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="PATCH">PATCH</SelectItem>
              <SelectItem value="DELETE">DELETE</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Headers</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setWebhookHeaders(prev => [...prev, {key: '', value: ''}])}
              className="h-7 text-xs"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          </div>

          <div className="space-y-2">
            {webhookHeaders.map((header, index) => (
              <div key={index} className="flex gap-2 items-center">
                <Input
                  placeholder="e.g., plan"
                  value={header.key}
                  onChange={e => updateHeader(index, {key: e.target.value})}
                  className="text-sm font-mono"
                />
                <Input
                  placeholder="e.g., pro"
                  value={header.value}
                  onChange={e => updateHeader(index, {value: e.target.value})}
                  className="text-sm font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setWebhookHeaders(prev => prev.filter((_, i) => i !== index))}
                  className="h-9 w-9 p-0 flex-shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3 p-4 bg-neutral-50 rounded-lg border border-neutral-200">
          <div className="flex items-start gap-3">
            <Switch id="editWebhookCustomPayload" checked={customPayload} onCheckedChange={setCustomPayload} />
            <div className="flex-1">
              <Label htmlFor="editWebhookCustomPayload" className="font-medium cursor-pointer">
                Custom payload
              </Label>
              <p className="text-xs text-neutral-500 mt-1">
                Send this JSON instead of the default request payload. It replaces the default one entirely.
              </p>
            </div>
          </div>

          {customPayload && (
            <>
              <Textarea
                id="editWebhookPayload"
                aria-label="Custom payload"
                className="font-mono text-xs min-h-40"
                value={payloadText}
                onChange={e => setPayloadText(e.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-neutral-500">
                Variables are filled in string values only, with Liquid: <code>{'{{email}}'}</code>,{' '}
                <code>{'{{id}}'}</code>, a contact field such as <code>{'{{data.plan}}'}</code>, a field of the event
                that started the workflow such as <code>{'{{event.plan}}'}</code>, <code>{'{{unsubscribeUrl}}'}</code>,{' '}
                <code>{'{{subscribeUrl}}'}</code> and <code>{'{{manageUrl}}'}</code>. A fallback:{' '}
                <code>{'{{data.name ?? there}}'}</code>.
              </p>
              {webhookMethod === 'GET' && (
                <p className="text-xs text-amber-700">GET requests send no body: choose another method to send it.</p>
              )}
            </>
          )}
        </div>
      </div>
    </StepDialogShell>
  );
}

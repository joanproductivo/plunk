import {ALERT_RECIPIENTS_MAX, type AlertSchemas} from '@plunk/shared';
import type {AlertSettings} from '@plunk/types';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Textarea} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {alertSettingsUrl, parseRecipients} from '../lib/failureAlerts';
import {network} from '../lib/network';

interface FailureAlertSettingsProps {
  projectId: string;
  canEdit: boolean;
}

/** Where a project's failure alerts go (Plunk Lite) */
export function FailureAlertSettings(props: FailureAlertSettingsProps) {
  const {data, error} = useSWR<{settings: AlertSettings | null}>(alertSettingsUrl(props.projectId), {
    revalidateOnFocus: false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Failure alerts</CardTitle>
        <CardDescription>
          When a workflow, a campaign or an email fails, the dashboard shows it until someone marks it reviewed, and
          these addresses get an email: the first time a source fails, then at most once an hour while it keeps failing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data ? (
          // Mounted once the settings load, so the form starts from them, and again for another project
          <AlertSettingsForm key={props.projectId} {...props} saved={data.settings} />
        ) : error ? (
          <p className="text-sm text-red-700">{error instanceof Error ? error.message : String(error)}</p>
        ) : (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}

function AlertSettingsForm({projectId, canEdit, saved}: FailureAlertSettingsProps & {saved: AlertSettings | null}) {
  const [recipients, setRecipients] = useState(saved?.recipients.join('\n') ?? '');
  const [fromEmail, setFromEmail] = useState(saved?.fromEmail ?? '');
  const [fromName, setFromName] = useState(saved?.fromName ?? '');
  const [busy, setBusy] = useState<'saving' | 'testing' | null>(null);
  const {mutate} = useSWR<{settings: AlertSettings | null}>(alertSettingsUrl(projectId), {revalidateOnFocus: false});

  const save = async () => {
    setBusy('saving');
    try {
      const next = await network.fetch<{settings: AlertSettings | null}, typeof AlertSchemas.settings>(
        'PUT',
        alertSettingsUrl(projectId),
        {
          recipients: parseRecipients(recipients),
          fromEmail: fromEmail.trim() || undefined,
          fromName: fromName.trim() || undefined,
        },
      );
      await mutate(next, {revalidate: false});
      setRecipients(next.settings?.recipients.join('\n') ?? '');
      toast.success(next.settings ? 'Alert settings saved' : 'Alert emails turned off');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the alert settings. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy('testing');
    try {
      await network.fetch('POST', `${alertSettingsUrl(projectId)}/test`);
      toast.success('Test alert sent');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t send the test alert.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="alert-recipients" className="text-sm font-medium mb-2 block">
          Send alerts to
        </Label>
        <Textarea
          id="alert-recipients"
          rows={3}
          value={recipients}
          disabled={!canEdit}
          placeholder="you@example.com"
          onChange={e => setRecipients(e.target.value)}
        />
        <p className="mt-1 text-xs text-neutral-500">
          One address per line, up to {ALERT_RECIPIENTS_MAX}. They only get these alerts: they are not contacts. Leave
          it empty to turn the emails off. If your SES account is still in the sandbox, each address must be verified in
          SES.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="alert-from-email" className="text-sm font-medium mb-2 block">
            From address
          </Label>
          <Input
            id="alert-from-email"
            type="email"
            value={fromEmail}
            disabled={!canEdit}
            placeholder="alerts@yourdomain.com"
            onChange={e => setFromEmail(e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500">On one of this project&apos;s verified domains.</p>
        </div>
        <div>
          <Label htmlFor="alert-from-name" className="text-sm font-medium mb-2 block">
            From name
          </Label>
          <Input
            id="alert-from-name"
            value={fromName}
            disabled={!canEdit}
            placeholder="The project's name"
            onChange={e => setFromName(e.target.value)}
          />
        </div>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button onClick={save} disabled={busy !== null}>
            {busy === 'saving' ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="outline" onClick={sendTest} disabled={busy !== null || !saved}>
            {busy === 'testing' ? 'Sending…' : 'Send test alert'}
          </Button>
        </div>
      )}
    </div>
  );
}

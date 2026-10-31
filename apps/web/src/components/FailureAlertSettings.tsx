import {ALERT_RECIPIENTS_MAX, type AlertSchemas} from '@plunk/shared';
import type {AlertSettings} from '@plunk/types';
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Textarea} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';

import {alertSettingsUrl, deadLetterDrainUrl, parseRecipients} from '../lib/failureAlerts';
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
          When a workflow, a campaign or an email fails, bounce or complaint rates pass a threshold, or a domain stops
          being verified, the dashboard shows it until someone marks it reviewed, and these addresses get an email: the
          first time, then at most once an hour while it goes on (once a day for the same reputation warnings).
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
        {props.canEdit && <DeadLetterQueueDrain projectId={props.projectId} />}
      </CardContent>
    </Card>
  );
}

/**
 * Takes back now what SNS left in the AWS dead-letter queue of SES events (Plunk Lite). Plunk
 * already does this when the queue's alarm goes off and every 15 minutes; this is for not waiting.
 */
function DeadLetterQueueDrain({projectId}: {projectId: string}) {
  const [busy, setBusy] = useState(false);

  const drain = async () => {
    setBusy(true);
    try {
      await network.fetch('POST', deadLetterDrainUrl(projectId));
      toast.success('Queued: what it takes back for this project shows on the dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t queue the drain. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-neutral-200 pt-4">
      <p className="text-sm font-medium">AWS dead-letter queue</p>
      <p className="mt-1 text-xs text-neutral-500">
        Bounces, complaints and other SES events SNS could not deliver to Plunk wait there for 14 days. Plunk takes them
        back on its own when the queue&apos;s alarm goes off and every 15 minutes.
      </p>
      <Button variant="outline" className="mt-3" onClick={drain} disabled={busy}>
        {busy ? 'Queueing…' : 'Process AWS dead-letter queue now'}
      </Button>
    </div>
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
          <p className="mt-1 text-xs text-neutral-500">
            On one of this project&apos;s verified domains. If that domain stops being verified, alerts go from the same
            name on another one.
          </p>
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

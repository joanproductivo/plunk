import type {UpdateContactSegmentChanges} from '@plunk/types';
import {Label, RadioGroup, RadioGroupItem} from '@plunk/ui';
import {useState} from 'react';
import {toast} from 'sonner';

import {KeyValueEditor} from '../KeyValueEditor';

import {SegmentActionsField} from './SegmentActionsField';
import {
  type EditStepDialogProps,
  getStepConfig,
  hasUpdateContactAction,
  StepDialogShell,
  useStepUpdate,
} from './shared';

type SubscriptionAction = 'none' | 'subscribe' | 'unsubscribe';

const SUBSCRIPTION_OPTIONS: Array<{value: SubscriptionAction; label: string; description: string}> = [
  {value: 'none', label: 'Leave as is', description: "Don't change the contact's subscription state."},
  {value: 'subscribe', label: 'Subscribe', description: 'Mark the contact as subscribed.'},
  {value: 'unsubscribe', label: 'Unsubscribe', description: 'Mark the contact as unsubscribed.'},
];

export function UpdateContactStepDialog({step, workflowId, open, onOpenChange, onSuccess}: EditStepDialogProps) {
  const config = getStepConfig(step);
  const initialUpdates =
    config.updates && typeof config.updates === 'object'
      ? (config.updates as Record<string, string | number | boolean>)
      : null;
  const initialSubscriptionAction: SubscriptionAction =
    config.subscriptionAction === 'subscribe' || config.subscriptionAction === 'unsubscribe'
      ? config.subscriptionAction
      : 'none';
  const configSegments = (config.segments ?? {}) as Partial<UpdateContactSegmentChanges>;
  const initialSegments: UpdateContactSegmentChanges = {
    add: Array.isArray(configSegments.add) ? configSegments.add : [],
    remove: Array.isArray(configSegments.remove) ? configSegments.remove : [],
  };

  const [name, setName] = useState(step.name);
  const [contactUpdateData, setContactUpdateData] = useState<Record<string, string | number | boolean> | null>(
    initialUpdates,
  );
  const [subscriptionAction, setSubscriptionAction] = useState<SubscriptionAction>(initialSubscriptionAction);
  const [segmentActions, setSegmentActions] = useState<UpdateContactSegmentChanges>(initialSegments);

  const {update, isSubmitting} = useStepUpdate(workflowId, step.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const hasUpdates = contactUpdateData && Object.keys(contactUpdateData).length > 0;
    if (!hasUpdateContactAction({updates: contactUpdateData, subscriptionAction, segments: segmentActions})) {
      toast.error('Add at least one field to update, a subscription action or a segment');
      return;
    }

    const ok = await update({
      name,
      config: {
        updates: hasUpdates ? contactUpdateData : {},
        subscriptionAction,
        segments: segmentActions,
      },
    });

    if (ok) {
      onOpenChange(false);
      onSuccess();
    }
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
      <div className="space-y-2">
        <Label>Subscription state</Label>
        <RadioGroup
          value={subscriptionAction}
          onValueChange={value => setSubscriptionAction(value as SubscriptionAction)}
          className="gap-2"
        >
          {SUBSCRIPTION_OPTIONS.map(option => (
            <label
              key={option.value}
              htmlFor={`subscriptionAction-${option.value}`}
              className="flex items-start gap-3 rounded-md border border-neutral-200 p-3 cursor-pointer hover:bg-neutral-50"
            >
              <RadioGroupItem id={`subscriptionAction-${option.value}`} value={option.value} className="mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-neutral-900">{option.label}</div>
                <div className="text-xs text-neutral-500">{option.description}</div>
              </div>
            </label>
          ))}
        </RadioGroup>
      </div>

      <SegmentActionsField value={segmentActions} onChange={setSegmentActions} />

      <div className="space-y-2">
        <KeyValueEditor key={`edit-${step.id}`} initialData={contactUpdateData} onChange={setContactUpdateData} />
      </div>
    </StepDialogShell>
  );
}

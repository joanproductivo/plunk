import {Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label} from '@plunk/ui';
import type {WorkflowStep} from '@plunk/db';
import {WorkflowSchemas} from '@plunk/shared';
import type {UpdateContactSegmentChanges} from '@plunk/types';
import {useState} from 'react';
import {toast} from 'sonner';

import {network} from '../../lib/network';

export const STEP_TYPE_LABELS: Record<WorkflowStep['type'], string> = {
  TRIGGER:        'Trigger',
  SEND_EMAIL:     'Send Email',
  DELAY:          'Delay',
  WAIT_FOR_EVENT: 'Wait for Event',
  CONDITION:      'Condition',
  EXIT:           'Exit',
  WEBHOOK:        'Webhook',
  UPDATE_CONTACT: 'Update Contact',
};

export const STEP_TYPE_DESCRIPTIONS: Record<WorkflowStep['type'], string> = {
  TRIGGER:        'Starts the workflow when a specific event is received.',
  SEND_EMAIL:     'Sends an email to the contact using a template you choose.',
  DELAY:          'Pauses the workflow for a set amount of time before continuing.',
  WAIT_FOR_EVENT: 'Waits until the contact triggers a specific event, then continues.',
  CONDITION:      'Splits the flow based on contact data or segment membership — each path leads to different steps.',
  EXIT:           'Ends the workflow for the contact.',
  WEBHOOK:        "Makes an HTTP request to an external URL with the contact's data.",
  UPDATE_CONTACT: "Sets fields on the contact's profile, its subscription, or the static segments it is in.",
};

export type StepWithTemplate = WorkflowStep & {
  template?: {id: string; name: string} | null;
};

export interface EditStepDialogProps {
  step: StepWithTemplate;
  workflowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export interface UpdateStepInput {
  name: string;
  config: Record<string, unknown>;
  templateId?: string;
}

export function useStepUpdate(workflowId: string, stepId: string) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const update = async (input: UpdateStepInput): Promise<boolean> => {
    setIsSubmitting(true);
    try {
      await network.fetch<WorkflowStep, typeof WorkflowSchemas.updateStep>(
        'PATCH',
        `/workflows/${workflowId}/steps/${stepId}`,
        input as Parameters<typeof network.fetch>[2],
      );
      toast.success('Step updated');
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the step. Try again.');
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  return {update, isSubmitting};
}

/** Whether an Update contact step's config changes anything: data, subscription or segments */
export function hasUpdateContactAction(config: {updates?: unknown; subscriptionAction?: unknown; segments?: unknown}) {
  const hasUpdates = !!config.updates && typeof config.updates === 'object' && Object.keys(config.updates).length > 0;
  const hasSubscriptionAction =
    typeof config.subscriptionAction === 'string' &&
    config.subscriptionAction !== 'none' &&
    config.subscriptionAction !== '';
  const segments = (config.segments ?? {}) as Partial<UpdateContactSegmentChanges>;
  const hasSegmentChanges = [segments.add, segments.remove].some(ids => Array.isArray(ids) && ids.length > 0);
  return hasUpdates || hasSubscriptionAction || hasSegmentChanges;
}

export function getStepConfig(step: {config: unknown}): Record<string, unknown> {
  return step.config && typeof step.config === 'object' && !Array.isArray(step.config)
    ? (step.config as Record<string, unknown>)
    : {};
}

interface StepDialogShellProps {
  step: StepWithTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isSubmitting: boolean;
  children: React.ReactNode;
}

export function StepDialogShell({
  step,
  open,
  onOpenChange,
  name,
  onNameChange,
  onSubmit,
  isSubmitting,
  children,
}: StepDialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {STEP_TYPE_LABELS[step.type] ?? step.type}</DialogTitle>
          {STEP_TYPE_DESCRIPTIONS[step.type] && (
            <p className="text-sm text-neutral-500 mt-1">{STEP_TYPE_DESCRIPTIONS[step.type]}</p>
          )}
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <Label htmlFor="editStepName">Step name</Label>
            <Input
              id="editStepName"
              type="text"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              required
              placeholder="e.g., Send Welcome Email"
              className="mt-1.5"
            />
          </div>

          {children}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

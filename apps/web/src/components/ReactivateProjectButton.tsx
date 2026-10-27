import {Button, ConfirmDialog} from '@plunk/ui';
import {RotateCcw} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {useProjects} from '../lib/hooks/useProject';
import {useProjectSecurity} from '../lib/hooks/useProjectSecurity';
import {network} from '../lib/network';

/**
 * Whether the dashboard can reactivate a project (Plunk Lite): only one disabled for its sending
 * reputation. Other reasons still need whoever runs the installation.
 */
export function canReactivate(project: {disabled: boolean; disabledReason?: string | null} | null | undefined) {
  return Boolean(project?.disabled && project.disabledReason === 'EMAIL_REPUTATION');
}

/**
 * Reactivates the active project after a confirmation that shows its current rates and what the
 * disable left behind. Renders nothing for a project the dashboard cannot reactivate. Owners and
 * admins only: anyone else is told so by the API.
 */
export function ReactivateProjectButton({size = 'sm'}: {size?: 'sm' | 'default'}) {
  const {activeProject, updateActiveProject} = useActiveProject();
  const {mutate: mutateProjects} = useProjects();
  const {securityMetrics, mutate: mutateSecurity} = useProjectSecurity(activeProject?.id);
  const [open, setOpen] = useState(false);

  if (!activeProject || !canReactivate(activeProject)) {
    return null;
  }

  async function reactivate() {
    if (!activeProject) return;
    try {
      const {draftedCampaigns} = await network.fetch<{draftedCampaigns: number}>(
        'POST',
        `/users/@me/projects/${activeProject.id}/reactivate`,
      );
      updateActiveProject({...activeProject, disabled: false, disabledReason: null});
      await Promise.all([mutateProjects(), mutateSecurity()]);
      setOpen(false);
      toast.success(
        draftedCampaigns > 0
          ? `Project reactivated. ${draftedCampaigns} scheduled ${draftedCampaigns === 1 ? 'campaign is a draft' : 'campaigns are drafts'} again: schedule ${draftedCampaigns === 1 ? 'it' : 'them'} again.`
          : 'Project reactivated.',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t reactivate the project. Try again.');
    }
  }

  const sevenDay = securityMetrics?.status.sevenDay;

  return (
    <>
      <Button size={size} onClick={() => setOpen(true)}>
        Reactivate project
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={reactivate}
        icon={RotateCcw}
        title="Reactivate this project?"
        description="Sending starts again straight away. The addresses that bounced or complained are already suppressed, and deleting them does not change the rates: check first where they came from (an import, a signup form), or the project will be disabled again."
        details={
          <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-600">
            {sevenDay && (
              <li>
                Last 7 days: {sevenDay.bounceRate.toFixed(2)}% bounces and {sevenDay.complaintRate.toFixed(3)}%
                complaints, out of {sevenDay.total.toLocaleString()} emails.
              </li>
            )}
            <li>For 7 days, only the emails sent from now on count towards disabling it again.</li>
            <li>
              Scheduled campaigns were cancelled when the project was disabled. The ones that hadn’t started go back to
              drafts, to schedule again; a campaign stopped halfway stays cancelled.
            </li>
          </ul>
        }
        confirmText="Reactivate"
        loadingText="Reactivating…"
      />
    </>
  );
}

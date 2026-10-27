// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {ReactivateProjectButton} from '../ReactivateProjectButton';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  project: {id: 'p1', disabled: true, disabledReason: 'EMAIL_REPUTATION' as string | null},
  updateActiveProject: vi.fn(),
  mutateProjects: vi.fn(async () => undefined),
  mutateSecurity: vi.fn(async () => undefined),
}));

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn(async () => ({draftedCampaigns: 2}))}}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/contexts/ActiveProjectProvider', () => ({
  useActiveProject: () => ({activeProject: state.project, updateActiveProject: state.updateActiveProject}),
}));
vi.mock('../../lib/hooks/useProject', () => ({useProjects: () => ({mutate: state.mutateProjects})}));
vi.mock('../../lib/hooks/useProjectSecurity', () => ({
  useProjectSecurity: () => ({
    securityMetrics: {status: {sevenDay: {total: 1200, bounceRate: 9.25, complaintRate: 0.05}}},
    mutate: state.mutateSecurity,
  }),
}));

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => root.render(<ReactivateProjectButton />));
}

function button(text: string) {
  return [...document.body.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
}

beforeEach(() => {
  state.project = {id: 'p1', disabled: true, disabledReason: 'EMAIL_REPUTATION'};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('ReactivateProjectButton', () => {
  it.each([
    ['disabled for another reason', {id: 'p1', disabled: true, disabledReason: 'PHISHING_DETECTED'}],
    ['not disabled', {id: 'p1', disabled: false, disabledReason: null}],
  ])('shows nothing for a project %s', async (_case, project) => {
    state.project = project;
    await render();

    expect(container.textContent).toBe('');
  });

  it('asks first, showing the rates and what happened to the scheduled campaigns, then reactivates', async () => {
    await render();
    await act(async () => button('Reactivate project')!.click());

    const dialog = document.body.textContent!;
    expect(dialog).toContain('Last 7 days: 9.25% bounces and 0.050% complaints, out of 1,200 emails.');
    expect(dialog).toContain('Scheduled campaigns were cancelled when the project was disabled');
    expect(network.fetch).not.toHaveBeenCalled();

    await act(async () => button('Reactivate')!.click());

    expect(network.fetch).toHaveBeenCalledWith('POST', '/users/@me/projects/p1/reactivate');
    expect(state.updateActiveProject).toHaveBeenCalledWith({id: 'p1', disabled: false, disabledReason: null});
    expect(state.mutateProjects).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      'Project reactivated. 2 scheduled campaigns are drafts again: schedule them again.',
    );
  });

  it('says what the API answered when it cannot reactivate', async () => {
    vi.mocked(network.fetch).mockRejectedValueOnce(
      new Error('Insufficient permissions. Admin or owner access required.'),
    );
    await render();
    await act(async () => button('Reactivate project')!.click());
    await act(async () => button('Reactivate')!.click());

    expect(toast.error).toHaveBeenCalledWith('Insufficient permissions. Admin or owner access required.');
    expect(state.updateActiveProject).not.toHaveBeenCalled();
  });
});

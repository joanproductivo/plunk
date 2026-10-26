// @vitest-environment happy-dom
import {BRAND_DEFAULTS, BUTTON_DEFAULTS, type ProjectBrand} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {BrandSettings} from '../BrandSettings';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));

const STORED: ProjectBrand = {...BRAND_DEFAULTS, textColor: '#222222', button: BUTTON_DEFAULTS};

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn(async (): Promise<ProjectBrand> => STORED);

async function render(canEdit: boolean) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0}}>
        <BrandSettings projectId="project-1" canEdit={canEdit} />
      </SWRConfig>,
    );
  });
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('BrandSettings', () => {
  it("shows the project's brand in the fields and the preview", async () => {
    await render(true);

    expect(fetcher).toHaveBeenCalledWith('/projects/project-1/brand');
    expect(document.querySelector<HTMLInputElement>('#brand-text')!.value).toBe('#222222');
    expect(document.querySelector('iframe')!.getAttribute('srcdoc')).toContain('color: #222222;');
  });

  it('saves the brand as edited', async () => {
    vi.mocked(network.fetch).mockResolvedValueOnce({...STORED, backgroundColor: '#f3f4f6'});
    await render(true);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('#brand-has-background')!.click();
    });
    await act(async () => {
      buttonNamed('Save')!.click();
    });

    expect(network.fetch).toHaveBeenCalledWith('PUT', '/projects/project-1/brand', {
      ...STORED,
      backgroundColor: '#f3f4f6',
    });
    expect(toast.success).toHaveBeenCalledWith('Brand saved');
  });

  it('shows the unsubscribe footer in the preview of a framed brand', async () => {
    vi.mocked(network.fetch).mockResolvedValueOnce(STORED);
    await render(true);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('#brand-has-background')!.click();
    });

    const preview = document.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(preview).toContain('Update your preferences');
    expect(preview).not.toContain('plunk:footer');
  });

  it('does not offer saving to members who are not admins', async () => {
    await render(false);

    expect(buttonNamed('Save')).toBeUndefined();
    expect(container.textContent).toContain('Only admins can change the brand.');
  });
});

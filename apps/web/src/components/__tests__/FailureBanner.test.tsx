// @vitest-environment happy-dom
import type {FailureAlert} from '@plunk/types';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {FailureBanner} from '../FailureBanner';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn(async () => ({reviewed: 1}))}}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));
vi.mock('../../lib/contexts/ActiveProjectProvider', () => ({useActiveProject: () => ({activeProject: {id: 'p1'}})}));
vi.mock('next/link', () => ({
  default: ({href, children, ...props}: {href: string; children: React.ReactNode}) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const failure = (n: number): FailureAlert => ({
  id: `f${n}`,
  sourceKey: `workflow:w${n}`,
  label: `Workflow ${n}`,
  count: n,
  lastError: `Error ${n}`,
  lastContactEmail: null,
  firstAt: '2026-10-26T10:00:00.000Z',
  lastAt: `2026-10-26T10:0${n}:00.000Z`,
  reviewPath: `/workflows/w${n}?tab=executions`,
});

let root: Root;
let container: HTMLDivElement;
let failures: FailureAlert[] = [];
const fetcher = vi.fn(async () => ({failures}));

async function render() {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0}}>
        <FailureBanner />
      </SWRConfig>,
    );
  });
}

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

describe('FailureBanner', () => {
  it('shows nothing when nothing failed', async () => {
    failures = [];
    await render();

    expect(fetcher).toHaveBeenCalledWith('/projects/p1/alerts/failures');
    expect(container.textContent).toBe('');
  });

  it('shows the first three sources with a link to review each, and how many more there are', async () => {
    failures = [1, 2, 3, 4, 5].map(failure);
    await render();

    expect(container.textContent).toContain('Something needs review');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.textContent).toContain('Workflow 1');
    expect(container.textContent).toContain('Error 3');
    expect(container.textContent).not.toContain('Workflow 4');
    expect(container.textContent).toContain('+ 2 more');
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/workflows/w1?tab=executions');
  });

  it('marks reviewed only the sources it showed, each with the failure it showed', async () => {
    failures = [1, 2, 3, 4].map(failure);
    await render();

    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Mark as reviewed')!;
    await act(async () => button.click());

    expect(network.fetch).toHaveBeenCalledWith('POST', '/projects/p1/alerts/failures/review', {
      seen: [1, 2, 3].map(n => ({id: `f${n}`, lastAt: `2026-10-26T10:0${n}:00.000Z`})),
    });
  });
});

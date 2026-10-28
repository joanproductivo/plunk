// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import Confirm from '../../pages/confirm';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('next/image', () => ({default: () => null}));

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => {
    root.render(<Confirm />);
  });
  // The description is read after the first render
  await act(async () => {});
}

const button = () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Confirmar'));

beforeEach(() => {
  window.location.hash = '#the-token';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Plunk Lite: the page a double opt-in email links to */
describe('the confirmation page', () => {
  it('only reads the link on loading, and confirms it when the button is pressed', async () => {
    vi.mocked(network.fetch).mockImplementation(async (_method, path) =>
      path === '/optin/describe'
        ? {status: 'pending', projectName: 'Acme', email: 'ana@example.com', language: 'es'}
        : {status: 'confirmed'},
    );

    await render();

    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(network.fetch).toHaveBeenCalledWith('POST', '/optin/describe', {token: 'the-token'});
    expect(container.textContent).toContain('Confirma tu suscripción');
    expect(container.textContent).toContain('ana@example.com');

    await act(async () => button()!.click());

    expect(network.fetch).toHaveBeenLastCalledWith('POST', '/optin/confirm', {token: 'the-token'});
    expect(container.textContent).toContain('¡Suscripción confirmada!');
  });

  it('says when a link no longer works', async () => {
    vi.mocked(network.fetch).mockResolvedValue({status: 'invalid'});

    await render();

    expect(container.textContent).toContain('This link no longer works');
    expect(button()).toBeUndefined();
  });
});

// @vitest-environment happy-dom
import {BRAND_DEFAULTS, BUTTON_DEFAULTS, type ProjectFooters} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {FooterSettings} from '../FooterSettings';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));

const SAVED: ProjectFooters = {de: {text: 'Hallo von {projectName}', linkText: 'abmelden'}};

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn(
  async (url: string): Promise<unknown> =>
    url.endsWith('/footers') ? SAVED : {...BRAND_DEFAULTS, button: BUTTON_DEFAULTS},
);

async function render(canEdit = true) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0}}>
        <FooterSettings projectId="project-1" projectName="Acme" language="es" canEdit={canEdit} />
      </SWRConfig>,
    );
  });
}

const text = () => document.querySelector<HTMLTextAreaElement>('#footer-text')!;
const link = () => document.querySelector<HTMLInputElement>('#footer-link')!;
const preview = () => document.querySelector('iframe')!.getAttribute('srcdoc')!;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === name);

// Types into a React-controlled field as a user would
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', {bubbles: true}));
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

describe('FooterSettings', () => {
  it("starts in the project's language, from Plunk's text where it has none of its own", async () => {
    await render();

    expect(fetcher).toHaveBeenCalledWith('/projects/project-1/footers');
    expect(text().value).toMatch(/aceptaste recibir correos electrónicos de \{projectName\}.* por favor \{link\}\.$/);
    expect(link().value).toBe('actualiza tus preferencias');
    expect(preview()).toContain('de Acme');
    expect(buttonNamed("Restore Plunk's text")!.disabled).toBe(true);
    expect(buttonNamed('Save')!.disabled).toBe(true);
  });

  it('saves the language edited, keeping the others it already had, and only those', async () => {
    vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => body);
    await render();

    await type(text(), 'Recibes esto de {projectName}.\nCalle Mayor 1. Para irte, {link}.');
    expect(preview()).toContain(
      'Recibes esto de Acme.<br>Calle Mayor 1. Para irte, <a href="#">actualiza tus preferencias</a>.',
    );
    await act(async () => buttonNamed('Save')!.click());

    expect(network.fetch).toHaveBeenCalledWith('PUT', '/projects/project-1/footers', {
      ...SAVED,
      es: {
        text: 'Recibes esto de {projectName}.\nCalle Mayor 1. Para irte, {link}.',
        linkText: 'actualiza tus preferencias',
      },
    });
    expect(toast.success).toHaveBeenCalledWith('Footer saved');
  });

  it('does not save a link that is too short, and says why', async () => {
    await render();

    await type(link(), '.');

    expect(buttonNamed('Save')!.disabled).toBe(true);
    expect(container.textContent).toContain('es: the link text needs 3 to 100 visible letters or digits, on one line');
  });

  it("restores Plunk's text by removing the language's own", async () => {
    vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => body);
    await render();
    await type(text(), 'Otro texto');

    await act(async () => buttonNamed("Restore Plunk's text")!.click());

    expect(text().value).toContain('aceptaste recibir');
    expect(buttonNamed('Save')!.disabled).toBe(true);
  });

  it("needs no footer of its own once edited back to Plunk's text", async () => {
    await render();
    const plunk = text().value;

    await type(text(), `${plunk} Calle Mayor 1.`);
    expect(buttonNamed('Save')!.disabled).toBe(false);
    await type(text(), plunk);

    expect(buttonNamed('Save')!.disabled).toBe(true);
    expect(buttonNamed("Restore Plunk's text")!.disabled).toBe(true);
  });

  it('does not offer saving to members who are not admins', async () => {
    await render(false);

    expect(buttonNamed('Save')).toBeUndefined();
    expect(container.textContent).toContain('Only admins can change the footer.');
    expect(text().disabled).toBe(true);
    expect(link().disabled).toBe(true);
  });
});

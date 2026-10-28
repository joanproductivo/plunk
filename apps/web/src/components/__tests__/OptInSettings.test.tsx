// @vitest-environment happy-dom
import {BRAND_DEFAULTS, BUTTON_DEFAULTS} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {toast} from 'sonner';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../lib/network';
import {OptInSettings} from '../OptInSettings';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/network', () => ({network: {fetch: vi.fn()}}));
vi.mock('sonner', () => ({toast: {success: vi.fn(), error: vi.fn()}}));

const SAVED = {
  enabled: false,
  fromEmail: null,
  fromName: null,
  texts: {de: {subject: 'Bitte bestätigen', text: 'Hallo von {projectName}', buttonText: 'Bestätigen'}},
};

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn(
  async (url: string): Promise<unknown> =>
    url.endsWith('/optin') ? SAVED : {...BRAND_DEFAULTS, button: BUTTON_DEFAULTS},
);

async function render(canEdit = true) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher, provider: () => new Map(), dedupingInterval: 0}}>
        <OptInSettings projectId="project-1" projectName="Acme" language="es" canEdit={canEdit} />
      </SWRConfig>,
    );
  });
}

const field = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const preview = () => document.querySelector('iframe')!.getAttribute('srcdoc')!;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === name);

// Types into a React-controlled field as a user would
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
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

describe('OptInSettings', () => {
  it("starts in the project's language, from Plunk's text where it has none of its own", async () => {
    await render();

    expect(fetcher).toHaveBeenCalledWith('/projects/project-1/optin');
    expect(field<HTMLInputElement>('optin-subject').value).toBe('Confirma tu suscripción a {projectName}');
    expect(preview()).toContain('Gracias por apuntarte a los emails de Acme.');
    expect(container.textContent).toContain('Subject: Confirma tu suscripción a Acme');
    expect(buttonNamed('Save')!.disabled).toBe(true);
  });

  it('needs a sender to turn it on, and saves it with the language edited', async () => {
    vi.mocked(network.fetch).mockImplementationOnce(async (_method, _url, body) => body);
    await render();

    await act(async () => field<HTMLButtonElement>('optin-enabled').click());
    expect(buttonNamed('Save')!.disabled).toBe(true);
    expect(container.textContent).toContain('Choose the address the confirmation emails come from.');

    await type(field('optin-from'), ' hola@acme.test ');
    await type(field('optin-button'), 'Sí, quiero');
    await act(async () => buttonNamed('Save')!.click());

    expect(network.fetch).toHaveBeenCalledWith('PUT', '/projects/project-1/optin', {
      enabled: true,
      fromEmail: 'hola@acme.test',
      fromName: null,
      texts: {
        ...SAVED.texts,
        es: {
          subject: 'Confirma tu suscripción a {projectName}',
          text: 'Gracias por apuntarte a los emails de {projectName}.\n\nPara empezar a recibirlos, confirma que esta es tu dirección:',
          buttonText: 'Sí, quiero',
        },
      },
    });
    expect(toast.success).toHaveBeenCalledWith('Double opt-in on');
  });

  it('does not save a text with template tags, and says why', async () => {
    await render();

    await type(field('optin-text'), 'Hola {{ name }}');

    expect(buttonNamed('Save')!.disabled).toBe(true);
    expect(container.textContent).toContain('the texts cannot hold template tags');
  });

  it('does not offer saving to members who are not admins', async () => {
    await render(false);

    expect(buttonNamed('Save')).toBeUndefined();
    expect(container.textContent).toContain('Only admins can change the double opt-in.');
    expect(field<HTMLInputElement>('optin-subject').disabled).toBe(true);
  });
});

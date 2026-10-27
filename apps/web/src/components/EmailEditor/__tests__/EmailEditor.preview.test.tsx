// @vitest-environment happy-dom
import {joinEmailMarkers, textToPreheader} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailEditor} from '../EmailEditor';

/**
 * Preview is a tab beside Visual and HTML: it takes the editor's place without unmounting it,
 * and renders the email for a contact, or with the template's default values when there is none.
 */
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const ANA = {id: 'contact-1', email: 'ana@example.com', subscribed: true, data: {name: 'Ana'}};
let contacts: (typeof ANA)[] = [];

vi.mock('../../../lib/contexts/ActiveProjectProvider', () => ({
  useActiveProject: () => ({activeProject: {id: 'project-1'}}),
}));
vi.mock('../../../lib/hooks/useContacts', () => ({
  useContactFields: () => ({fields: [], fieldDetails: []}),
  useContacts: () => ({contacts}),
  useSegmentContacts: () => ({contacts}),
}));
vi.mock('../../../lib/hooks/useConfig', () => ({useConfig: () => ({data: undefined})}));
vi.mock('../../../lib/hooks/useTemplateValidation', () => ({
  useTemplateValidation: () => null,
  useTemplateFieldWarnings: () => [],
}));

let root: Root;
let container: HTMLDivElement;
const changes = vi.fn<(value: string) => void>();

async function render(subject: string, value = '<p>Hello</p>') {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher: () => Promise.resolve(null), provider: () => new Map(), dedupingInterval: 0}}>
        <EmailEditor value={value} onChange={changes} subject={subject} from="hi@example.com" fillHeight />
      </SWRConfig>,
    );
  });
  // Tiptap creates its editor in an effect
  await act(async () => undefined);
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!button) throw new Error(`No ${label} button`);
  await act(async () => button.click());
}

const iframe = () => container.querySelector('iframe');
const editorPane = () => container.querySelector('.ProseMirror')?.closest('.max-h-\\[600px\\]')?.parentElement;
const subjectShown = () =>
  [...container.querySelectorAll('p')].find(p => p.previousElementSibling?.textContent === 'Subject');

beforeEach(() => {
  contacts = [ANA];
  changes.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Preview tab', () => {
  it('covers the editor without unmounting it, and Visual brings it back', async () => {
    await render('Hi');
    const prose = container.querySelector('.ProseMirror');
    expect(iframe()).toBeNull();

    await click('Preview');
    expect(iframe()).not.toBeNull();
    expect(container.querySelector('.ProseMirror')).toBe(prose);
    // Only `hidden`: the wide-screen xl:flex would show it again
    expect(editorPane()?.className).toBe('hidden');
    expect(container.querySelector('#email-preheader')).toBeNull();

    await click('Visual');
    expect(iframe()).toBeNull();
    expect(container.querySelector('.ProseMirror')).toBe(prose);
    expect(editorPane()?.className).not.toContain('hidden');
    expect(changes).not.toHaveBeenCalled();
  });

  it('runs no scripts from the email, and still opens its links', async () => {
    await render('Hi');
    await click('Preview');
    const sandbox = iframe()?.getAttribute('sandbox')?.split(' ') ?? [];
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).toContain('allow-popups');
    expect(sandbox).not.toContain('allow-scripts');
  });

  it('renders the first contact by default', async () => {
    await render('For {{name ?? friend}}');
    await click('Preview');
    expect(subjectShown()?.textContent).toBe('For Ana');
  });

  it("renders the template's default values without contacts", async () => {
    contacts = [];
    await render('For {{name ?? friend}}');
    await click('Preview');
    expect(subjectShown()?.textContent).toBe('For friend');
  });

  it("keeps previewing a template that doesn't parse yet, with its plain variables", async () => {
    await render('For {{name}} {% if name %}');
    await click('Preview');
    expect(subjectShown()?.textContent).toBe('For Ana {% if name %}');
  });

  it('shows the preview text as typed, not as stored', async () => {
    await render(
      'Hi',
      joinEmailMarkers({preheader: textToPreheader('Tom & "Jerry"'), brand: null, body: '<p>Hello</p>'}),
    );
    await click('Preview');
    const shown = [...container.querySelectorAll('p')].find(
      p => p.previousElementSibling?.textContent === 'Preview text',
    );
    expect(shown?.textContent).toBe('Tom & "Jerry"');
  });
});

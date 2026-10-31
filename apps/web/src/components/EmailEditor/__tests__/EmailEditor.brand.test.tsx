// @vitest-environment happy-dom
import {BRAND_DEFAULTS, BUTTON_DEFAULTS, type EmailBrand, joinEmailMarkers, splitEmailMarkers} from '@plunk/shared';
import type {Editor} from '@tiptap/core';
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailEditor} from '../EmailEditor';

/**
 * The editor with Tiptap, as the campaign and template pages use it: an email's brand is only
 * written by a change to it, never by loading it, however its body and the project's brand arrive.
 */
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../lib/contexts/ActiveProjectProvider', () => ({
  useActiveProject: () => ({activeProject: {id: 'project-1'}}),
}));
vi.mock('../../../lib/hooks/useContacts', () => ({
  useContactFields: () => ({fields: [], fieldDetails: []}),
  useContacts: () => ({contacts: []}),
  useSegmentContacts: () => ({contacts: []}),
}));
vi.mock('../../../lib/hooks/useConfig', () => ({useConfig: () => ({data: undefined})}));
vi.mock('../../../lib/hooks/useTemplateValidation', () => ({
  useTemplateValidation: () => null,
  useTemplateFieldWarnings: () => [],
}));

const PROJECT: EmailBrand = {...BRAND_DEFAULTS, textColor: '#222222', backgroundColor: '#f3f4f6'};

let root: Root;
let container: HTMLDivElement;
const changes = vi.fn<(value: string) => void>();
const SAVED = '<p>Saved before brands</p>';

// The page's side: it holds the value, which may arrive after the editor mounts ("Load")
function Page({initial}: {initial: string}) {
  const [value, set] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => set(SAVED)}>
        Load
      </button>
      <EmailEditor
        value={value}
        onChange={next => {
          changes(next);
          set(next);
        }}
      />
    </>
  );
}

async function render(
  initial: string,
  brand: Promise<unknown> = Promise.resolve({...PROJECT, button: BUTTON_DEFAULTS}),
) {
  await act(async () => {
    root.render(
      <SWRConfig value={{fetcher: () => brand, provider: () => new Map(), dedupingInterval: 0}}>
        <Page initial={initial} />
      </SWRConfig>,
    );
  });
  // Tiptap creates its editor in an effect, and the brand resolves after it
  await act(async () => undefined);
}

const editor = () => (document.querySelector('.ProseMirror') as unknown as {editor: Editor}).editor;
const brandOf = (value: string) => splitEmailMarkers(value).brand;

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

describe('EmailEditor brands', () => {
  it('writes no brand into an email written before brands when its body loads after mounting', async () => {
    await render('');

    // As campaigns/[id].tsx fills the body in an effect, once the campaign is fetched
    await act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Load')!.click();
    });
    await act(async () => editor().commands.insertContent(' and edited'));

    expect(changes).toHaveBeenCalled();
    for (const [value] of changes.mock.calls) {
      expect(value).not.toContain('plunk:brand');
    }
  });

  it("gives a new email the project's brand with its first change", async () => {
    await render('');

    await act(async () => editor().commands.insertContent('Hello'));

    expect(brandOf(changes.mock.calls.at(-1)![0])).toEqual(PROJECT);
  });

  it('keeps the brand an email already has', async () => {
    const own = {...BRAND_DEFAULTS, linkColor: '#0a7c3e'};
    await render(joinEmailMarkers({preheader: '', brand: own, body: '<p>Hi</p>'}));

    await act(async () => editor().commands.insertContent('!'));

    expect(brandOf(changes.mock.calls.at(-1)![0])).toEqual(own);
  });

  it("offers the project's brand to an email without it, and applies it on request", async () => {
    await render(SAVED);
    const apply = [...document.querySelectorAll('button')].find(button => button.textContent === 'Apply brand');
    expect(apply).toBeDefined();

    await act(async () => apply!.click());

    const applied = changes.mock.calls.at(-1)![0];
    expect(brandOf(applied)).toEqual(PROJECT);
    expect(splitEmailMarkers(applied).body).toBe(SAVED);
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Apply brand')).toBe(false);
  });

  it('shows the email in its brand', async () => {
    await render(joinEmailMarkers({preheader: '', brand: PROJECT, body: '<p>Hi</p>'}));

    expect(document.querySelector('.ProseMirror')!.getAttribute('style')).toContain('--tw-prose-body: #222222');
  });
});

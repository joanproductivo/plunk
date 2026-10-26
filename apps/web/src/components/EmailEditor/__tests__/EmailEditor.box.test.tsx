// @vitest-environment happy-dom
import {BRAND_DEFAULTS, BUTTON_DEFAULTS, type EmailBrand, joinEmailMarkers, splitEmailMarkers} from '@plunk/shared';
import type {Editor} from '@tiptap/core';
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailEditor} from '../EmailEditor';

/**
 * Boxes in the editor, as the campaign and template pages use it: made from the toolbar in the
 * email's brand, changed and removed from their settings.
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

const BRAND: EmailBrand = {...BRAND_DEFAULTS, textColor: '#222222'};

let root: Root;
let container: HTMLDivElement;
let value = '';

function Page() {
  const [current, set] = useState(joinEmailMarkers({preheader: '', brand: BRAND, body: '<p>Hello</p><p>There</p>'}));
  return (
    <EmailEditor
      value={current}
      onChange={next => {
        value = next;
        set(next);
      }}
    />
  );
}

async function render() {
  await act(async () => {
    root.render(
      <SWRConfig
        value={{
          fetcher: () => Promise.resolve({...BRAND, button: BUTTON_DEFAULTS}),
          provider: () => new Map(),
          dedupingInterval: 0,
        }}
      >
        <Page />
      </SWRConfig>,
    );
  });
  await act(async () => undefined);
}

const editor = () => (document.querySelector('.ProseMirror') as unknown as {editor: Editor}).editor;
const body = () => splitEmailMarkers(value).body;
const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    element => element.getAttribute('title') === label || element.textContent?.trim() === label,
  );

async function click(element: Element | undefined) {
  expect(element).toBeDefined();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  value = '';
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('EmailEditor boxes', () => {
  it("puts the cursor's paragraph in a box in the email's brand, then changes and removes it", async () => {
    await render();
    await act(async () => editor().commands.setTextSelection(2));

    await click(button('Put in a box with a background'));
    expect(body()).toBe(
      '<div class="email-box" style="background-color: #f3f4f6; color: #222222;"><p>Hello</p></div><p>There</p>',
    );

    // Its settings, from the toolbar with the cursor in it: a dark background, the text turning white
    await click(button('Box settings'));
    await click(document.querySelector('button[aria-label="Use #111827"]')!);
    await click(button('Save'));
    expect(body()).toBe(
      '<div class="email-box" style="background-color: #111827; color: #ffffff;"><p>Hello</p></div><p>There</p>',
    );
    expect(editor().state.selection.from).toBe(3);

    await click(button('Box settings'));
    await click(button('Remove box'));
    expect(body()).toBe('<p>Hello</p><p>There</p>');
  });

  it("opens a box's settings from its own button, and closes them if the box goes", async () => {
    await render();
    await act(async () => editor().commands.setTextSelection(2));
    await click(button('Put in a box with a background'));

    await click(document.querySelector('button[aria-label="Settings of this box"]')!);
    expect(button('Remove box')).toBeDefined();

    // Deleted meanwhile, say by an undo: the settings of a box that is gone close
    await act(async () => {
      editor().commands.undo();
    });
    expect(button('Remove box')).toBeUndefined();
  });
});

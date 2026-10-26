// @vitest-environment happy-dom
import {BUTTON_DEFAULTS, type ButtonStyle} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ButtonDialog} from '../ButtonDialog';
import type {ButtonAttrs} from '../EmailButton';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const BRAND_BUTTON: ButtonStyle = {...BUTTON_DEFAULTS, backgroundColor: '#0a7c3e', shape: 'pill'};

let root: Root;
let container: HTMLDivElement;

async function render({initial = null, defaultStyle}: {initial?: ButtonAttrs | null; defaultStyle?: ButtonStyle}) {
  await act(async () => {
    root.render(
      <ButtonDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} initial={initial} defaultStyle={defaultStyle} />,
    );
  });
}

const background = () => document.querySelector<HTMLInputElement>('#button-background')!.value;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ButtonDialog', () => {
  it("starts a new button from the brand's button", async () => {
    await render({defaultStyle: BRAND_BUTTON});

    expect(background()).toBe('#0a7c3e');
  });

  it('starts from the defaults until the brand has loaded', async () => {
    await render({});

    expect(background()).toBe(BUTTON_DEFAULTS.backgroundColor);
  });

  it('edits a button in its own style, whatever the brand', async () => {
    await render({
      initial: {...BUTTON_DEFAULTS, backgroundColor: '#e11d48', text: 'Go', href: 'https://a.com'},
      defaultStyle: BRAND_BUTTON,
    });

    expect(background()).toBe('#e11d48');
  });

  it('remembers nothing in the browser', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await render({defaultStyle: BRAND_BUTTON});

    expect(setItem).not.toHaveBeenCalled();
  });
});

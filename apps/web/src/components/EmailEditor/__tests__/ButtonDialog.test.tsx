// @vitest-environment happy-dom
import {BUTTON_DEFAULTS, type ButtonStyle} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ButtonDialog} from '../ButtonDialog';
import type {ButtonAttrs} from '../EmailButton';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_URL = 'https://files.example.com/files/p/1-0123456789abcdef-guide.pdf';

// The file dialog's part is its own test's: here it only hands back a file
vi.mock('../FileDialog', () => ({
  FileDialog: ({open, onPick}: {open: boolean; onPick: (url: string, name: string) => void}) =>
    open ? (
      <button type="button" onClick={() => onPick(FILE_URL, 'guide.pdf')}>
        Pick guide
      </button>
    ) : null,
}));

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

// Types into a React-controlled input as a user would
async function type(selector: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', {bubbles: true}));
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

  it('inserts a button without remembering its look in the browser', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <ButtonDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} initial={null} defaultStyle={BRAND_BUTTON} />,
      );
    });

    await type('#button-text', 'Shop now');
    await type('#button-href', 'https://a.com');
    await act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Insert')!.click();
    });

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({...BRAND_BUTTON, text: 'Shop now'}));
    expect(setItem).not.toHaveBeenCalled();
  });

  it('links the button to an uploaded file, when storage is configured', async () => {
    const linkToFile = () =>
      [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Link to a file'));
    await render({});
    expect(linkToFile()).toBeUndefined();

    await act(async () => {
      root.render(<ButtonDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} initial={null} canUpload />);
    });
    await act(async () => linkToFile()!.click());
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Pick guide')!.click());

    expect(document.querySelector<HTMLInputElement>('#button-href')!.value).toBe(FILE_URL);
  });
});

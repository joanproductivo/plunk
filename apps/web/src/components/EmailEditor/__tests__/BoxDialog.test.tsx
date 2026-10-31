// @vitest-environment happy-dom
import {BRAND_DEFAULTS, type BoxStyle} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {BoxDialog} from '../BoxDialog';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const LIGHT: BoxStyle = {backgroundColor: '#f3f4f6', textColor: BRAND_DEFAULTS.textColor, fullWidth: false};

let root: Root;
let container: HTMLDivElement;
const onSubmit = vi.fn();
const onRemove = vi.fn();

async function render(initial: BoxStyle, buttonColor = '#111827') {
  await act(async () => {
    root.render(
      <BoxDialog
        open
        onOpenChange={() => undefined}
        initial={initial}
        look={BRAND_DEFAULTS}
        buttonColor={buttonColor}
        onSubmit={onSubmit}
        onRemove={onRemove}
      />,
    );
  });
}

const text = () => document.body.textContent ?? '';
const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === label)!;

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  });
}

// Types into a React-controlled input as a user would
async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
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

describe('BoxDialog', () => {
  it('picks the text colour for the background until one is set by hand', async () => {
    await render(LIGHT);
    expect(document.querySelector('#box-text')).toBeNull();

    await type('#box-background', '#1d4ed8');
    await click(buttonNamed('Save'));
    expect(onSubmit).toHaveBeenLastCalledWith({backgroundColor: '#1d4ed8', textColor: '#ffffff', fullWidth: false});

    await click(document.querySelector('#box-auto-text')!);
    await type('#box-text', '#FEF3C7');
    await type('#box-background', '#111827');
    await click(buttonNamed('Save'));
    expect(onSubmit).toHaveBeenLastCalledWith({backgroundColor: '#111827', textColor: '#fef3c7', fullWidth: false});
  });

  it('keeps a text colour set by hand when the box is opened again', async () => {
    await render({...LIGHT, textColor: '#7c2d12'});

    expect(document.querySelector<HTMLInputElement>('#box-text')!.value).toBe('#7c2d12');
  });

  it('warns when the text, links or buttons are hard to make out', async () => {
    await render(LIGHT);
    expect(text()).not.toContain('hard to read');

    // The brand's blue links on a blue box
    await type('#box-background', '#2563eb');
    expect(text()).toContain('Links in the brand’s color are hard to read on this background.');
    expect(text()).not.toContain('Buttons in the brand’s style');

    // Its near-black buttons on a near-black box, where its links read
    await type('#box-background', '#111827');
    expect(text()).not.toContain('Links in the brand’s color');
    expect(text()).toContain('Buttons in the brand’s style blend into this background.');
    expect(text()).not.toContain('The text is hard to read');

    await click(document.querySelector('#box-auto-text')!);
    await type('#box-text', '#1f2937');
    expect(text()).toContain('The text is hard to read on this background.');
  });

  it('saves nothing while a colour is not one', async () => {
    await render(LIGHT);

    await type('#box-background', 'blue');

    expect(buttonNamed('Save').disabled).toBe(true);
    expect(text()).toContain('Use a hex color');
  });

  it('removes the box', async () => {
    await render(LIGHT);

    await click(buttonNamed('Remove box'));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

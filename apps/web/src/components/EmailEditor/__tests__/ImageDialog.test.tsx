// @vitest-environment happy-dom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ImageDialog} from '../ImageDialog';

/**
 * Listing the gallery is a billed storage request, so these pin when it happens: never before
 * "My images" is pressed, once after, and not again on reopening the dialog or refocusing the window.
 */
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGES = {
  images: [
    {url: 'https://files.example.com/p/2-0123456789abcdef-new.png', name: 'new', uploadedAt: null, size: 1},
    {url: 'https://files.example.com/p/1-0123456789abcdef.jpg', name: null, uploadedAt: null, size: 1},
  ],
  truncated: false,
};

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn(async () => IMAGES);
const onInsert = vi.fn();
// One cache for the whole test, as the dashboard keeps one for the session
let cache: Map<string, unknown>;

// The editor's side of the dialog: it opens it, and the dialog closes itself (Cancel, Esc, insert)
function Editor() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <ImageDialog open={open} onOpenChange={setOpen} canUpload onInsert={onInsert} />
    </>
  );
}

async function render() {
  await act(async () => {
    root.render(
      <SWRConfig
        value={{
          fetcher,
          provider: () => cache as never,
          shouldRetryOnError: false,
          // No grace periods, so any request SWR would make, however soon after the last, is counted
          dedupingInterval: 0,
          focusThrottleInterval: 0,
        }}
      >
        <Editor />
      </SWRConfig>,
    );
  });
}

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text);
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  });
}

beforeEach(() => {
  cache = new Map();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('ImageDialog gallery', () => {
  it('lists the images only once asked, and once per session', async () => {
    await render();
    expect(fetcher).not.toHaveBeenCalled();

    await click(buttonNamed('My images')!);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('img')).toHaveLength(2);

    // Coming back to the window does not list them again
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Nor does closing and reopening the dialog, then the gallery
    await click(buttonNamed('Cancel')!);
    expect(buttonNamed('Cancel')).toBeUndefined();
    await click(buttonNamed('Reopen')!);
    expect(buttonNamed('My images')).toBeDefined();
    await click(buttonNamed('My images')!);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('img')).toHaveLength(2);
  });

  it('inserts the picked image', async () => {
    await render();
    await click(buttonNamed('My images')!);

    await click(document.querySelector('button[title="new"]')!);

    expect(onInsert).toHaveBeenCalledWith(IMAGES.images[0]!.url);
  });

  it('names older images by their upload date or as an uploaded image', async () => {
    await render();
    await click(buttonNamed('My images')!);

    expect(document.querySelectorAll('img')[1]!.getAttribute('alt')).toBe('Uploaded image');
  });
});

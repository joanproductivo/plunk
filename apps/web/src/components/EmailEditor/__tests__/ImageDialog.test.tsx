// @vitest-environment happy-dom
import type {UploadedImagesResponse} from '@plunk/types';
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../../lib/network';
import {ImageDialog} from '../ImageDialog';

/**
 * Listing the gallery is a billed storage request, so these pin when it happens: never before
 * "My images" is pressed, once after, and not again on reopening the dialog or refocusing the window.
 */
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../lib/network', () => ({
  network: {upload: vi.fn(async () => ({url: 'https://files.example.com/p/3-0123456789abcdef-up.png', key: 'k'}))},
}));

const image = (name: string | null, uploadedAt: string | null = null) => ({
  url: `https://files.example.com/p/${name ?? uploadedAt ?? 'unnamed'}.png`,
  name,
  uploadedAt,
  size: 1,
});

const IMAGES: UploadedImagesResponse = {
  images: [image('new'), image(null, '2026-10-20T10:00:00.000Z'), image(null)],
  truncated: false,
};

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn(async (): Promise<UploadedImagesResponse> => IMAGES);
const onInsert = vi.fn();
// One cache for the whole test, as the dashboard keeps one for the session
let cache: Map<string, unknown>;

// The editor's side of the dialog: it opens and may close it, and the dialog closes itself (Cancel, Esc, insert)
function Editor() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close from outside
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

async function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {value: [file], configurable: true});
  await act(async () => {
    input.dispatchEvent(new Event('change', {bubbles: true}));
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
  fetcher.mockImplementation(async () => IMAGES);
});

describe('ImageDialog gallery', () => {
  it('lists the images only once asked, and once per session', async () => {
    await render();
    expect(fetcher).not.toHaveBeenCalled();

    await click(buttonNamed('My images')!);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('img')).toHaveLength(3);

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
    expect(document.querySelectorAll('img')).toHaveLength(3);
  });

  it('folds the gallery away however the dialog closes', async () => {
    await render();
    await click(buttonNamed('My images')!);

    await click(buttonNamed('Close from outside')!);
    await click(buttonNamed('Reopen')!);

    expect(buttonNamed('My images')).toBeDefined();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('lists again once, and only once asked, after an upload', async () => {
    await render();
    await click(buttonNamed('My images')!);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await chooseFile(new File(['x'], 'up.png', {type: 'image/png'}));
    await click(buttonNamed('Insert')!);
    expect(network.upload).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith('https://files.example.com/p/3-0123456789abcdef-up.png');

    await click(buttonNamed('Reopen')!);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await click(buttonNamed('My images')!);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('img')).toHaveLength(3);
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

    const alts = [...document.querySelectorAll('img')].map(img => img.getAttribute('alt'));
    expect(alts).toEqual([
      'new',
      `Uploaded ${new Date('2026-10-20T10:00:00.000Z').toLocaleDateString()}`,
      'Uploaded image',
    ]);
  });

  it('shows the thumbnails a batch at a time, and says when the list is cut short', async () => {
    fetcher.mockImplementation(async () => ({
      images: Array.from({length: 30}, (_, index) => image(`image-${index}`)),
      truncated: true,
    }));
    await render();
    await click(buttonNamed('My images')!);

    expect(document.querySelectorAll('img')).toHaveLength(24);
    expect(container.ownerDocument.body.textContent).toContain('Showing 30 of your images');

    await click(buttonNamed('Show more')!);
    expect(document.querySelectorAll('img')).toHaveLength(30);
    expect(buttonNamed('Show more')).toBeUndefined();
  });

  it('says why the images could not be listed', async () => {
    fetcher.mockImplementation(async () => {
      throw new Error("Couldn't list your images in storage");
    });
    await render();
    await click(buttonNamed('My images')!);

    expect(document.body.textContent).toContain("Couldn't list your images in storage");
  });
});

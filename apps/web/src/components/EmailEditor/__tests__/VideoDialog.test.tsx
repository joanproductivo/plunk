// @vitest-environment happy-dom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../../lib/network';
import type {VideoAttrs} from '../EmailVideo';
import {VideoDialog} from '../VideoDialog';
import {composeVideoPoster, VideoNotFoundError} from '../videoPoster';

/**
 * A poster is uploaded to the project's storage, so these pin when that happens: once per video
 * inserted, never for a change of alt text or start, and never with the dialog closed under it.
 */
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = 'https://files.example.com/p/3-0123456789abcdef-youtube-dqw4w9wgxcq.jpg';

vi.mock('../../../lib/network', () => ({
  network: {upload: vi.fn(async () => ({url: SRC, key: 'k'}))},
}));

vi.mock('../videoPoster', async importOriginal => ({
  ...(await importOriginal<typeof import('../videoPoster')>()),
  composeVideoPoster: vi.fn(),
}));

const POSTER = {image: new Blob(['jpeg'], {type: 'image/jpeg'}), width: 1280, height: 720, title: 'Never gonna'};
const EDITED: VideoAttrs = {
  src: 'https://files.example.com/p/old.jpg',
  href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  alt: 'Old alt',
  width: 1280,
  height: 720,
};

let root: Root;
let container: HTMLDivElement;
const onSubmit = vi.fn();

// The editor's side: it opens the dialog, and closes it when told to or on a submit
function Editor({initial}: {initial: VideoAttrs | null}) {
  const [open, setOpen] = useState(true);
  return (
    <VideoDialog
      open={open}
      onOpenChange={setOpen}
      initial={initial}
      onSubmit={attrs => {
        onSubmit(attrs);
        setOpen(false);
      }}
    />
  );
}

async function render(initial: VideoAttrs | null = null) {
  await act(async () => {
    root.render(
      <SWRConfig value={{provider: () => new Map()}}>
        <Editor initial={initial} />
      </SWRConfig>,
    );
  });
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text);
const text = () => document.body.textContent ?? '';

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

async function pressEscape() {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(composeVideoPoster).mockResolvedValue(POSTER);
  URL.createObjectURL = vi.fn(() => 'blob:poster');
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('VideoDialog', () => {
  it('composes the poster, uploads it named after the video, then inserts the video', async () => {
    await render();

    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ?t=90');
    expect(composeVideoPoster).toHaveBeenCalledWith({id: 'dQw4w9WgXcQ', start: null});
    expect(document.querySelector<HTMLInputElement>('#video-alt')!.value).toBe('Never gonna');
    expect(text()).toContain('Starts at 1:30.');

    await click(buttonNamed('Insert')!);

    expect(network.upload).toHaveBeenCalledTimes(1);
    const form = vi.mocked(network.upload).mock.calls[0]![2];
    expect((form.get('image') as File).name).toBe('youtube-dQw4w9WgXcQ.jpg');
    expect(onSubmit).toHaveBeenCalledWith({
      href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
      alt: 'Never gonna',
      src: SRC,
      width: 1280,
      height: 720,
    });
  });

  it('keeps alt text written before the title arrives', async () => {
    let finish: (poster: typeof POSTER) => void = () => undefined;
    vi.mocked(composeVideoPoster).mockReturnValue(new Promise(resolve => (finish = resolve)));
    await render();

    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ');
    await type('#video-alt', 'My own words');
    await act(async () => finish(POSTER));

    expect(document.querySelector<HTMLInputElement>('#video-alt')!.value).toBe('My own words');
  });

  it('saves the alt text and start of the same video without uploading again', async () => {
    await render(EDITED);

    await type('#video-alt', 'New alt');
    await type('#video-link', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m');
    await click(buttonNamed('Save')!);

    expect(composeVideoPoster).not.toHaveBeenCalled();
    expect(network.upload).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith({
      ...EDITED,
      alt: 'New alt',
      href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s',
    });
  });

  it("gives another video's title to a block edited to show it, unless the alt text was written", async () => {
    await render(EDITED);

    await type('#video-link', 'https://youtu.be/jNQXAC9IVRw');
    expect(composeVideoPoster).toHaveBeenCalledWith({id: 'jNQXAC9IVRw', start: null});
    expect(document.querySelector<HTMLInputElement>('#video-alt')!.value).toBe('Never gonna');
    await click(buttonNamed('Save')!);

    expect(network.upload).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({src: SRC, alt: 'Never gonna'}));
  });

  it('composes a video again when it comes back, its earlier preview gone', async () => {
    await render();

    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ');
    await type('#video-link', 'https://youtu.be/dQw4');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:poster');
    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ');

    expect(composeVideoPoster).toHaveBeenCalledTimes(2);
    expect(document.querySelector('img')!.getAttribute('src')).toBe('blob:poster');
  });

  it('says when a start in the link cannot be kept', async () => {
    await render();

    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ?t=01:30');

    expect(text()).toContain('The start in the link can’t be read');
  });

  it('stays open while the poster uploads', async () => {
    let finish: (value: {url: string; key: string}) => void = () => undefined;
    vi.mocked(network.upload).mockReturnValueOnce(new Promise(resolve => (finish = resolve)) as never);
    await render();
    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ');

    await click(buttonNamed('Insert')!);
    expect(buttonNamed('Uploading…')!.disabled).toBe(true);
    await pressEscape();
    expect(buttonNamed('Cancel')).toBeDefined();

    await act(async () => finish({url: SRC, key: 'k'}));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(buttonNamed('Cancel')).toBeUndefined();
  });

  it('says why a video cannot be inserted', async () => {
    vi.mocked(composeVideoPoster).mockRejectedValue(new VideoNotFoundError());
    await render();

    await type('#video-link', 'example.com/watch');
    expect(text()).toContain('Paste a link to a YouTube video');

    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ');
    expect(text()).toContain('That video doesn’t exist or isn’t public.');
    expect(buttonNamed('Insert')!.disabled).toBe(true);
  });

  it('says an upload failed and lets it be tried again', async () => {
    vi.mocked(network.upload).mockRejectedValueOnce(new Error('S3 down'));
    await render();
    await type('#video-link', 'https://youtu.be/dQw4w9WgXcQ');

    await click(buttonNamed('Insert')!);
    expect(text()).toContain('Couldn’t upload the poster. Try again.');
    expect(onSubmit).not.toHaveBeenCalled();

    await click(buttonNamed('Insert')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {network} from '../../../lib/network';
import {FileDialog, linkedFileProblem, MAX_LINKED_FILE_BYTES} from '../FileDialog';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const URL_OF_UPLOAD = 'https://files.example.com/files/p/3-0123456789abcdef-guide.pdf';

vi.mock('../../../lib/network', () => ({
  network: {upload: vi.fn(async () => ({url: URL_OF_UPLOAD, key: 'k'}))},
}));

let root: Root;
let container: HTMLDivElement;
const onPick = vi.fn();
const onOpenChange = vi.fn();

async function render() {
  await act(async () => {
    root.render(
      <SWRConfig value={{provider: () => new Map()}}>
        <FileDialog open onOpenChange={onOpenChange} onPick={onPick} />
      </SWRConfig>,
    );
  });
}

const fileOf = (name: string, bytes: number, type = 'application/pdf') =>
  new File([new Uint8Array(bytes)], name, {type});

async function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {value: [file], configurable: true});
  await act(async () => {
    input.dispatchEvent(new Event('change', {bubbles: true}));
  });
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!;

async function click(text: string) {
  await act(async () => {
    button(text).click();
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

describe('linkedFileProblem', () => {
  it('takes documents up to what nginx lets through, with room for the rest of the request', () => {
    expect(linkedFileProblem(fileOf('Guide.PDF', 1000))).toBeNull();
    expect(linkedFileProblem(fileOf('deck.pptx', MAX_LINKED_FILE_BYTES))).toBeNull();
    expect(linkedFileProblem(fileOf('big.pdf', 10 * 1024 * 1024))).toBe('Files can be up to 9.9 MB');
    expect(linkedFileProblem(fileOf('setup.exe', 10))).toContain('Choose a PDF, Word, Excel or PowerPoint file');
    expect(linkedFileProblem(fileOf('macro.docm', 10))).toContain('Choose a PDF');
  });
});

describe('FileDialog', () => {
  it('refuses a file it cannot upload without sending it', async () => {
    await render();

    await choose(fileOf('big.pdf', 10 * 1024 * 1024));

    expect(container.ownerDocument.body.textContent).toContain('Files can be up to 9.9 MB');
    expect(button('Upload and link').disabled).toBe(true);
    expect(network.upload).not.toHaveBeenCalled();
  });

  it('uploads the chosen file and links to it, with its name for a link without text', async () => {
    await render();

    await choose(fileOf('Guide.pdf', 1000));
    await click('Upload and link');

    const [method, path, form] = vi.mocked(network.upload).mock.calls[0]!;
    expect([method, path]).toEqual(['POST', '/uploads/file']);
    expect((form as FormData).get('file')).toBeInstanceOf(File);
    expect(onPick).toHaveBeenCalledWith(URL_OF_UPLOAD, 'Guide.pdf');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open while the file uploads, so the upload is not left without a link', async () => {
    let finish: (value: {url: string; key: string}) => void = () => undefined;
    vi.mocked(network.upload).mockImplementationOnce(() => new Promise(resolve => (finish = resolve)));
    await render();

    await choose(fileOf('Guide.pdf', 1000));
    await click('Upload and link');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    });

    // The dialog's own close button (the X) asks to close too
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Close'))!.click();
    });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Uploading…')).toBeDefined();

    await act(async () => finish({url: URL_OF_UPLOAD, key: 'k'}));
    expect(onPick).toHaveBeenCalledWith(URL_OF_UPLOAD, 'Guide.pdf');
  });

  it("shows the API's reason when the upload is refused", async () => {
    vi.mocked(network.upload).mockRejectedValueOnce(new Error('File contents do not match its type'));
    await render();

    await choose(fileOf('Guide.pdf', 1000));
    await click('Upload and link');

    expect(document.body.textContent).toContain('File contents do not match its type');
    expect(onPick).not.toHaveBeenCalled();
  });
});

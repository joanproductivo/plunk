// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';

import {network} from '../network';

/**
 * What an upload's caller is told when it fails: the API's reason when it answered, and a readable
 * message when it did not (nginx's HTML 413, or a response the browser hides for lack of CORS).
 */
const respond = (status: number, body: string, contentType = 'application/json') =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, {status, headers: {'Content-Type': contentType}})),
  );

const upload = () => network.upload('POST', '/uploads/file', new FormData());

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('network.upload', () => {
  it("rejects with the API's reason", async () => {
    respond(400, JSON.stringify({success: false, error: {code: 'BAD_REQUEST', message: 'Only PDF files'}}));

    await expect(upload()).rejects.toThrow('Only PDF files');
  });

  it("explains nginx's HTML page for a body too large", async () => {
    respond(413, '<html><body>413 Request Entity Too Large</body></html>', 'text/html');

    await expect(upload()).rejects.toThrow('The file is too large to upload');
  });

  it('names the status of another response that is not the API’s', async () => {
    respond(502, '<html>Bad Gateway</html>', 'text/html');

    await expect(upload()).rejects.toThrow('Upload failed (HTTP 502)');
  });

  it('explains a request the browser could not complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(upload()).rejects.toThrow('Couldn’t reach the server');
  });

  it('resolves with the body of a successful upload', async () => {
    respond(200, JSON.stringify({url: 'https://files.example.com/a.pdf'}));

    await expect(upload()).resolves.toEqual({url: 'https://files.example.com/a.pdf'});
  });
});

/**
 * Plunk Lite: read at most `maxBytes` of a response body as text, then stop reading. A body over
 * the cap is cut at the last whole character and `truncated`; the rest is never downloaded. A
 * response without a body (204, HEAD) reads as empty.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<{text: string; truncated: boolean}> {
  if (!response.body) {
    return {text: '', truncated: false};
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;

  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      return {text: text + decoder.decode(), truncated: false};
    }
    if (bytes + value.byteLength > maxBytes) {
      // stream: true keeps a character split at the cut out of the text instead of mangling it
      text += decoder.decode(value.subarray(0, maxBytes - bytes), {stream: true});
      await reader.cancel();
      return {text, truncated: true};
    }
    bytes += value.byteLength;
    text += decoder.decode(value, {stream: true});
  }
}

import {describe, expect, it} from 'vitest';

import {readCapped} from '../readCapped.js';

/** Plunk Lite: a response body read up to a cap */
describe('readCapped', () => {
  it('reads a body under the cap whole', async () => {
    expect(await readCapped(new Response('hola'), 10)).toEqual({text: 'hola', truncated: false});
  });

  it('cuts a body over the cap without splitting a character', async () => {
    // 'é' takes two bytes: a cap of 3 falls in the middle of the second one
    expect(await readCapped(new Response('éé'), 3)).toEqual({text: 'é', truncated: true});
  });

  it('reads a response without a body as empty', async () => {
    expect(await readCapped(new Response(null, {status: 204}), 10)).toEqual({text: '', truncated: false});
  });
});

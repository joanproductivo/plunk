import {describe, expect, it} from 'vitest';

import {isSafeVideoHref, isSafeVideoHrefAttribute, parseYouTubeLink, youTubeWatchUrl} from '../template/index.js';

describe('parseYouTubeLink', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', null],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2', null],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', null],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', null],
    ['HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ', null],
    ['https://youtu.be/dQw4w9WgXcQ?si=abcdef', null],
    ['youtu.be/dQw4w9WgXcQ', null],
    ['  www.youtube.com/watch?v=dQw4w9WgXcQ  ', null],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', null],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=42', 42],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', null],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', null],
    ['https://youtu.be/dQw4w9WgXcQ?t=90', 90],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s', 90],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s', 3723],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m', 120],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0', null],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=soon', null],
  ])('reads %s', (input, start) => {
    expect(parseYouTubeLink(input)).toEqual({id: 'dQw4w9WgXcQ', start});
  });

  it.each([
    '',
    null,
    undefined,
    'not a link',
    'https://www.youtube.com.example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com@example.com/watch?v=dQw4w9WgXcQ',
    'https://user@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://notyoutu.be/dQw4w9WgXcQ',
    'javascript:alert(1)//youtu.be/dQw4w9WgXcQ',
    'ftp://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ%22',
    'https://www.youtube.com/watch?list=PL123',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@channel',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ/extra',
  ])('refuses %s', input => {
    expect(parseYouTubeLink(input)).toBeNull();
  });
});

describe('youTubeWatchUrl', () => {
  it('links to the watch page, at the start if there is one', () => {
    expect(youTubeWatchUrl({id: 'dQw4w9WgXcQ', start: null})).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(youTubeWatchUrl({id: 'dQw4w9WgXcQ', start: 90})).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s');
  });

  it('writes links that are safe for a video', () => {
    expect(isSafeVideoHref(youTubeWatchUrl(parseYouTubeLink('youtu.be/dQw4w9WgXcQ?t=1h')!))).toBe(true);
  });
});

describe('isSafeVideoHref', () => {
  it.each(['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=a-b_c-d_e-f&t=999999s'])(
    'accepts %s',
    href => {
      expect(isSafeVideoHref(href)).toBe(true);
    },
  );

  it.each([
    'https://youtu.be/dQw4w9WgXcQ',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n',
    'javascript:alert(1)',
    '',
    null,
    undefined,
  ])('refuses %s', href => {
    expect(isSafeVideoHref(href)).toBe(false);
  });
});

describe('isSafeVideoHrefAttribute', () => {
  it('reads the start as an attribute writes it', () => {
    expect(isSafeVideoHrefAttribute('https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s')).toBe(true);
    expect(isSafeVideoHrefAttribute('https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;amp;t=90s')).toBe(false);
    expect(isSafeVideoHrefAttribute(undefined)).toBe(false);
  });
});

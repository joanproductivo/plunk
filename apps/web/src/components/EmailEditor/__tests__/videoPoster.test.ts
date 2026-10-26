import {afterEach, describe, expect, it, vi} from 'vitest';

import {composeVideoPoster, cropTo, type PosterTools, VideoNotFoundError} from '../videoPoster';

/**
 * YouTube and the canvas stand in as doubles: posters by quality, each a size (or a failed load),
 * and a canvas that records what is drawn on it.
 */
const VIDEO = {id: 'dQw4w9WgXcQ', start: 90};
const GREY = {width: 120, height: 90};

function tools(posters: Record<string, {width: number; height: number} | null>) {
  const loaded: string[] = [];
  const drawn: unknown[][] = [];
  const canvases: {width: number; height: number}[] = [];
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, key) =>
      key === 'drawImage' ? (...args: unknown[]) => drawn.push(args) : (target[key as string] ?? (() => undefined)),
  });
  const fake: PosterTools = {
    loadImage: async src => {
      loaded.push(src.replace(`https://i.ytimg.com/vi/${VIDEO.id}/`, '').replace('.jpg', ''));
      const size = posters[loaded.at(-1)!];
      return size ? ({naturalWidth: size.width, naturalHeight: size.height} as never) : null;
    },
    createCanvas: (width, height) => {
      canvases.push({width, height});
      return {
        getContext: () => context,
        toBlob: (done: BlobCallback, type?: string) => done(new Blob(['jpeg'], {type})),
      } as unknown as HTMLCanvasElement;
    },
  };
  return {fake, loaded, drawn, canvases};
}

function oEmbed(response: {status: number; body?: unknown} | Error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (response instanceof Error) throw response;
      return new Response(JSON.stringify(response.body ?? {}), {status: response.status});
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cropTo', () => {
  it.each([
    // A 16:9 video in hqdefault's 4:3 frame loses the bars above and below
    [480, 360, 16 / 9, [0, 45, 480, 270]],
    [1280, 720, 16 / 9, [0, 0, 1280, 720]],
    // As YouTube rounds 16:9
    [1280, 720, 200 / 113, [0, 0, 1280, 720]],
    [480, 360, 200 / 113, [0, 45, 480, 270]],
    // A 4:3 video keeps its whole frame
    [480, 360, 4 / 3, [0, 0, 480, 360]],
    // A vertical Short is cut no narrower than 4:3
    [1280, 720, 9 / 16, [160, 0, 960, 720]],
  ])('crops %ix%i to %f as %j', (width, height, ratio, crop) => {
    expect(cropTo(width, height, ratio)).toEqual(crop);
  });
});

describe('composeVideoPoster', () => {
  it('draws the largest poster with a play button and gives the title', async () => {
    oEmbed({status: 200, body: {title: ' Never gonna give you up ', width: 200, height: 113}});
    const {fake, loaded, drawn, canvases} = tools({maxresdefault: {width: 1280, height: 720}});

    const poster = await composeVideoPoster(VIDEO, fake);

    expect(loaded).toEqual(['maxresdefault']);
    expect(canvases).toEqual([{width: 1280, height: 720}]);
    expect(drawn[0]!.slice(1)).toEqual([0, 0, 1280, 720, 0, 0, 1280, 720]);
    expect(poster).toMatchObject({width: 1280, height: 720, title: 'Never gonna give you up'});
    expect(poster.image.type).toBe('image/jpeg');
    // The title is asked for the video, without its start
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`,
    );
  });

  it("skips missing qualities and YouTube's grey placeholder, and keeps a 4:3 video whole", async () => {
    oEmbed({status: 200, body: {title: 'Me at the zoo', width: 200, height: 150}});
    const {fake, loaded, drawn} = tools({maxresdefault: null, sddefault: GREY, hqdefault: {width: 480, height: 360}});

    const poster = await composeVideoPoster(VIDEO, fake);

    expect(loaded).toEqual(['maxresdefault', 'sddefault', 'hqdefault']);
    expect(drawn[0]!.slice(1, 5)).toEqual([0, 0, 480, 360]);
    expect(poster).toMatchObject({width: 480, height: 360});
  });

  it('crops a 16:9 video out of a 4:3 poster', async () => {
    oEmbed({status: 200, body: {width: 200, height: 113}});
    const {fake} = tools({hqdefault: {width: 480, height: 360}});

    expect(await composeVideoPoster(VIDEO, fake)).toMatchObject({width: 480, height: 270, title: null});
  });

  it('carries on as 16:9 without a title when YouTube cannot be asked', async () => {
    oEmbed(new TypeError('Failed to fetch'));
    const {fake} = tools({sddefault: {width: 640, height: 480}});

    expect(await composeVideoPoster(VIDEO, fake)).toMatchObject({width: 640, height: 360, title: null});
  });

  it('carries on for a video that may not be embedded, which a link still plays', async () => {
    oEmbed({status: 401});
    const {fake} = tools({maxresdefault: {width: 1280, height: 720}});

    expect(await composeVideoPoster(VIDEO, fake)).toMatchObject({width: 1280, title: null});
  });

  it('says a video does not exist without loading its posters', async () => {
    oEmbed({status: 404});
    const {fake, loaded} = tools({maxresdefault: {width: 1280, height: 720}});

    await expect(composeVideoPoster(VIDEO, fake)).rejects.toBeInstanceOf(VideoNotFoundError);
    expect(loaded).toEqual([]);
  });

  it('says a video does not exist when it only has the grey placeholder', async () => {
    oEmbed(new TypeError('Failed to fetch'));
    const {fake} = tools({maxresdefault: GREY, sddefault: GREY, hqdefault: GREY});

    await expect(composeVideoPoster(VIDEO, fake)).rejects.toBeInstanceOf(VideoNotFoundError);
  });
});

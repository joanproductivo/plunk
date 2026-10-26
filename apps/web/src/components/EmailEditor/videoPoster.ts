import {type YouTubeVideo, youTubeWatchUrl} from '@plunk/shared';

/** A video's poster with a play button drawn on it, ready to upload, and the video's title. */
export interface VideoPoster {
  image: Blob;
  width: number;
  height: number;
  /** null when YouTube did not say. */
  title: string | null;
}

/** The video does not exist, or is not public. */
export class VideoNotFoundError extends Error {
  constructor() {
    super('Video not found');
  }
}

/** A loaded image, or null when it failed to load. */
type LoadedImage = CanvasImageSource & {naturalWidth: number; naturalHeight: number};

/** What composing needs from the browser; tests stand in for it. */
export interface PosterTools {
  loadImage: (src: string) => Promise<LoadedImage | null>;
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
}

// An image that has not loaded by then is taken as failed, and a title not given by then is done
// without, so the dialog never waits forever
const LOAD_TIMEOUT_MS = 15_000;
const OEMBED_TIMEOUT_MS = 10_000;

const browserTools: PosterTools = {
  loadImage: src =>
    new Promise(resolve => {
      const image = new Image();
      const timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
      // YouTube's posters allow any origin, so drawing one leaves the canvas readable. YouTube
      // needs no word of which dashboard asked.
      image.crossOrigin = 'anonymous';
      image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        clearTimeout(timer);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      image.src = src;
    }),
  createCanvas: (width, height) => Object.assign(document.createElement('canvas'), {width, height}),
};

// Largest first. A quality a video lacks answers 404 with a grey 120×90 placeholder, which loads.
const POSTER_QUALITIES = ['maxresdefault', 'sddefault', 'hqdefault'];
const PLACEHOLDER = {width: 120, height: 90};

// Videos are cropped to their own shape, kept between 4:3 and 16:9: posters of narrower videos,
// Shorts among them, are 16:9 or 4:3 frames with the video in the middle.
const NARROWEST = 4 / 3;
const WIDEST = 16 / 9;

/** The play button's diameter, as a share of the poster's width. */
const PLAY_SIZE = 0.17;

// A video's title is a stranger's text going into the email, where Liquid would run it: it keeps
// its braces, but none opens a tag
function withoutLiquid(text: string): string {
  return text.replace(/\{(?=[{%])/g, '{\u200b');
}

// The title and shape YouTube gives; null when it cannot be asked
async function readOEmbed(video: YouTubeVideo): Promise<{title: string | null; ratio: number} | null> {
  let response: Response;
  try {
    const url = youTubeWatchUrl({id: video.id, start: null});
    response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  // 401 is a video that may not be embedded, which a link still plays
  if (response.status === 400 || response.status === 404) throw new VideoNotFoundError();
  if (!response.ok) return null;

  try {
    const data = (await response.json()) as {title?: unknown; width?: unknown; height?: unknown};
    const width = Number(data.width);
    const height = Number(data.height);
    return {
      title: typeof data.title === 'string' && data.title.trim() ? withoutLiquid(data.title.trim()) : null,
      ratio: width > 0 && height > 0 ? width / height : WIDEST,
    };
  } catch {
    return null;
  }
}

async function loadPoster(video: YouTubeVideo, tools: PosterTools): Promise<LoadedImage> {
  for (const quality of POSTER_QUALITIES) {
    const image = await tools.loadImage(`https://i.ytimg.com/vi/${video.id}/${quality}.jpg`);
    const isPlaceholder = image?.naturalWidth === PLACEHOLDER.width && image.naturalHeight === PLACEHOLDER.height;
    if (image && !isPlaceholder && image.naturalWidth > 0 && image.naturalHeight > 0) return image;
  }
  throw new VideoNotFoundError();
}

/** The middle of a `width`×`height` image in the shape `ratio`, as [x, y, width, height]. */
export function cropTo(width: number, height: number, ratio: number): [number, number, number, number] {
  // YouTube gives sizes in whole pixels (200×113 for 16:9), so a shape close to 4:3 or 16:9 is it
  const clamped = Math.min(Math.max(ratio, NARROWEST), WIDEST);
  const shape = [NARROWEST, WIDEST].find(known => Math.abs(clamped - known) / known < 0.02) ?? clamped;
  if (width / height > shape) {
    const cropped = Math.round(height * shape);
    return [Math.round((width - cropped) / 2), 0, cropped, height];
  }
  const cropped = Math.round(width / shape);
  return [0, Math.round((height - cropped) / 2), width, cropped];
}

// A white disc with a dark triangle, its shadow lifting it off the poster
function drawPlayButton(context: CanvasRenderingContext2D, width: number, height: number): void {
  const radius = Math.max(28, (width * PLAY_SIZE) / 2);
  const [x, y] = [width / 2, height / 2];

  context.save();
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  context.shadowBlur = radius * 0.3;
  context.shadowOffsetY = radius * 0.08;
  context.fillStyle = 'rgba(255, 255, 255, 0.95)';
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();

  // Nudged right, so the triangle looks centred in the disc
  const side = radius * 0.8;
  const left = x - side * 0.36;
  context.fillStyle = '#111827';
  context.beginPath();
  context.moveTo(left, y - side / 2);
  context.lineTo(left + side * 0.87, y);
  context.lineTo(left, y + side / 2);
  context.closePath();
  context.fill();
}

/**
 * Composes `video`'s poster with a play button, in the browser: the largest poster YouTube has,
 * cropped to the video's shape, as a JPEG. Throws VideoNotFoundError for a video that does not
 * exist or is not public.
 */
export async function composeVideoPoster(video: YouTubeVideo, tools = browserTools): Promise<VideoPoster> {
  const oEmbed = await readOEmbed(video);
  const poster = await loadPoster(video, tools);

  const [x, y, width, height] = cropTo(poster.naturalWidth, poster.naturalHeight, oEmbed?.ratio ?? WIDEST);
  const canvas = tools.createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  context.drawImage(poster, x, y, width, height, 0, 0, width, height);
  drawPlayButton(context, width, height);

  const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!image) throw new Error('Could not encode the poster');
  return {image, width, height, title: oEmbed?.title ?? null};
}

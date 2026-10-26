/**
 * The email editor's YouTube videos: a poster image linking to the video. The link is always
 * rebuilt from a checked id, so the dashboard, the custom-HTML checks and the API agree on the
 * one form a video may link to.
 */

/** A YouTube video, and the second it starts at (null from the beginning). */
export interface YouTubeVideo {
  id: string;
  start: number | null;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Hosts compared exactly, so that look-alikes such as youtube.com.example.com are refused
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

// Paths whose second segment is the id: /shorts/<id>, /embed/<id>, /live/<id>
const ID_PATHS = new Set(['shorts', 'embed', 'live']);

/** Starts beyond this many seconds (about 11 days) are not a video's. */
const MAX_START = 999_999;

// `t` and `start` as YouTube writes them: 90, 90s or 1h2m3s
function readStart(value: string | null): number | null {
  const parts = /^(?:(\d{1,6})h)?(?:(\d{1,6})m)?(?:(\d{1,6})s?)?$/.exec((value ?? '').trim());
  if (!parts || !value?.trim()) return null;
  const [, hours = '0', minutes = '0', seconds = '0'] = parts;
  const start = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return start > 0 && start <= MAX_START ? start : null;
}

/**
 * The video a YouTube link points to, or null when it is not one: watch, youtu.be, Shorts, embed
 * and live links, with or without `https://`, keeping where the link starts the video.
 */
export function parseYouTubeLink(input: string | null | undefined): YouTubeVideo | null {
  const text = (input ?? '').trim();
  if (!text) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (host === 'youtu.be') {
    id = segments.length === 1 ? segments[0] : undefined;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === 'watch') {
      id = url.searchParams.get('v') ?? undefined;
    } else if (segments.length === 2 && ID_PATHS.has(segments[0]!)) {
      id = segments[1];
    }
  }
  if (!id || !VIDEO_ID.test(id)) return null;

  return {id, start: readStart(url.searchParams.get('t') ?? url.searchParams.get('start'))};
}

/** The one link a video block carries: the video's watch page, at its start if it has one. */
export function youTubeWatchUrl(video: YouTubeVideo): string {
  return `https://www.youtube.com/watch?v=${video.id}${video.start ? `&t=${video.start}s` : ''}`;
}

/** Whether `href` is a link a video block may carry, exactly as youTubeWatchUrl writes it. */
export function isSafeVideoHref(href: string | null | undefined): boolean {
  return /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}(?:&t=[1-9]\d{0,5}s)?$/.test(href ?? '');
}

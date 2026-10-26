/**
 * The size of the email editor's YouTube videos: a share of the email's text width, capped at
 * that share of its width in px, so a video is smaller on a desktop and on a phone alike. Saved in
 * the poster's inline style; the dashboard writes and reads it, and the API reads it again when
 * sending, to write the cap for the email's own width and the width Outlook goes by.
 */

import {BRAND_DEFAULTS, type EmailBrand} from './brand.js';
import {closestOption} from './emailBlocks.js';
import {columnTextWidth, EMAIL_COLUMN_RADIUS} from './emailDocument.js';
import {declarations} from './inlineStyle.js';

/** Each size, as a share of the email's text width, in %. */
export const VIDEO_SIZES = {small: 50, medium: 75, large: 100} as const;

export type VideoSize = keyof typeof VIDEO_SIZES;

/** What a video is without a size of its own: as wide as the email's text, as before sizes. */
export const VIDEO_DEFAULT_SIZE: VideoSize = 'large';

/** The widest `size` is in `brand`, in px: its share of the email's text width. */
export function videoMaxWidth(size: VideoSize, brand: EmailBrand = BRAND_DEFAULTS): number {
  return Math.round((columnTextWidth(brand) * VIDEO_SIZES[size]) / 100);
}

/**
 * The size a poster's inline style gives, from its `width` in %; anything else, such as a width
 * in px or none, reads as large. The `max-width` is never read: sending inlines one from the prose
 * styles before reading it.
 */
export function readVideoSize(style: string | null | undefined): VideoSize {
  const width = /^(\d{1,3}(?:\.\d+)?)%$/.exec(declarations(style).get('width') ?? '');
  return width ? closestOption(VIDEO_SIZES, Number(width[1])) : VIDEO_DEFAULT_SIZE;
}

/**
 * The poster's inline style at `size`, as browsers serialise it, so it reads back unchanged:
 * centred, rounded like a framed email's column, and capped for an email without a brand width;
 * sending writes the cap for the email's own width (see the API's emailBody).
 */
export function videoImageStyle(size: VideoSize): string {
  const width =
    size === 'large' ? 'width: 100%;' : `width: ${VIDEO_SIZES[size]}%; max-width: ${videoMaxWidth(size)}px;`;
  return `display: block; ${width} height: auto; margin: 0px auto; border: 0px; border-radius: ${EMAIL_COLUMN_RADIUS}px;`;
}

/**
 * The email editor's spacer: an invisible <hr class="email-spacer"> with its height in the inline
 * style. The dashboard writes and reads it; the API reads it again when sending, to turn it into
 * a spacer every client keeps (see the API's emailBody).
 */

import {declarations} from './inlineStyle.js';

/**
 * Classes of the editor's own blocks. Telling visual editor content from custom HTML, they are
 * accepted only as they are, so look-alikes such as `email-button-primary` stay custom.
 */
export const EDITOR_BLOCK_CLASSES: readonly string[] = ['email-button', 'email-spacer'];

export type SpacerSize = 'small' | 'medium' | 'large' | 'xlarge';

/** Heights in px. Not below 16: Outlook may grow a spacer shorter than the email's font. */
export const SPACER_HEIGHTS: Record<SpacerSize, number> = {small: 16, medium: 32, large: 48, xlarge: 64};

export const SPACER_DEFAULT_HEIGHT = SPACER_HEIGHTS.medium;

/** Hand-written HTML can ask for any height; a spacer never sends more than this. */
const SPACER_MAX_HEIGHT = 200;

/**
 * A spacer's height from its inline style, as a whole number of px between 1 and 200. Anything
 * else (no height, another unit) is the default height.
 */
export function readSpacerHeight(style: string | null | undefined): number {
  const height = /^(\d+(?:\.\d+)?)px$/i.exec(declarations(style).get('height') ?? '');
  if (!height) {
    return SPACER_DEFAULT_HEIGHT;
  }

  return Math.min(SPACER_MAX_HEIGHT, Math.max(1, Math.round(Number(height[1]))));
}

/** The option of `table` whose value is closest to `value`, for blocks whose HTML set another. */
export function closestOption<K extends string>(table: Record<K, number>, value: number): K {
  const keys = Object.keys(table) as K[];
  return keys.reduce((best, key) => (Math.abs(table[key] - value) < Math.abs(table[best] - value) ? key : best));
}

/** The inline style a spacer is saved with: longhands browsers serialise unchanged. */
export function spacerStyle(height: number): string {
  return `border-style: none; margin: 0px; height: ${height}px;`;
}

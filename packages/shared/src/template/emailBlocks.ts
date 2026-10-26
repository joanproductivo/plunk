/**
 * Shared pieces of the email editor's blocks: the classes the custom-HTML checks accept, a
 * nearest-option lookup, and the spacer, an invisible <hr class="email-spacer"> with its height
 * in the inline style. The dashboard writes and reads spacers; the API reads them again when
 * sending, to turn them into spacers every client keeps (see the API's emailBody).
 */

import {declarations} from './inlineStyle.js';

/**
 * Classes of the editor's own blocks. Telling visual editor content from custom HTML, they are
 * accepted only as they are, so look-alikes such as `email-button-primary` stay custom.
 */
export const EDITOR_BLOCK_CLASSES: readonly string[] = ['email-button', 'email-spacer'];

/** The option of `table` whose value is closest to `value`, for blocks whose HTML set another. */
export function closestOption<K extends string>(table: Record<K, number>, value: number): K {
  const keys = Object.keys(table) as K[];
  return keys.reduce((best, key) => (Math.abs(table[key] - value) < Math.abs(table[best] - value) ? key : best));
}

export type SpacerSize = 'small' | 'medium' | 'large' | 'xlarge';

/** Heights in px. Not below 16: Outlook may grow a spacer shorter than the email's font. */
export const SPACER_HEIGHTS: Record<SpacerSize, number> = {small: 16, medium: 32, large: 48, xlarge: 64};

export const SPACER_DEFAULT_HEIGHT = SPACER_HEIGHTS.medium;

/** Hand-written HTML can ask for any height; a spacer never has more than this. */
const SPACER_MAX_HEIGHT = 200;

/** A spacer height as a whole number of px between 1 and 200, or the default if it is not a number. */
export function clampSpacerHeight(height: number): number {
  if (!Number.isFinite(height)) {
    return SPACER_DEFAULT_HEIGHT;
  }

  return Math.min(SPACER_MAX_HEIGHT, Math.max(1, Math.round(height)));
}

/**
 * A spacer's height from its inline style (see clampSpacerHeight). Anything else (no height,
 * another unit) is the default height.
 */
export function readSpacerHeight(style: string | null | undefined): number {
  const height = /^(\d+(?:\.\d+)?)px$/i.exec(declarations(style).get('height') ?? '');
  return height ? clampSpacerHeight(Number(height[1])) : SPACER_DEFAULT_HEIGHT;
}

/** The inline style a spacer is saved with: longhands browsers serialise unchanged. */
export function spacerStyle(height: number): string {
  return `border-style: none; margin: 0px; height: ${clampSpacerHeight(height)}px;`;
}

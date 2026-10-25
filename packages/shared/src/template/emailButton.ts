/**
 * The email editor's button: how its options map to the inline style it is saved with, and back.
 * The dashboard writes and reads this style; the API reads it again when sending, so both sides
 * agree on what a button is without a column of its own.
 */

export type ButtonShape = 'rectangle' | 'rounded' | 'pill';
export type ButtonSize = 'small' | 'medium' | 'large';
export type ButtonFont =
  | 'modern-sans'
  | 'geometric-sans'
  | 'rounded-sans'
  | 'modern-serif'
  | 'book-serif'
  | 'monospace';

export interface ButtonStyle {
  backgroundColor: string;
  textColor: string;
  shape: ButtonShape;
  size: ButtonSize;
  fullWidth: boolean;
  /** null keeps the email's own font. */
  font: ButtonFont | null;
}

export const BUTTON_DEFAULTS: ButtonStyle = {
  backgroundColor: '#111827',
  textColor: '#ffffff',
  shape: 'rounded',
  size: 'medium',
  fullWidth: false,
  font: null,
};

export const BUTTON_RADIUS: Record<ButtonShape, number> = {rectangle: 0, rounded: 6, pill: 999};

/** Vertical and horizontal padding, in px; the sizes of usewaypoint/email-builder-js (MIT). */
export const BUTTON_PADDING: Record<ButtonSize, readonly [number, number]> = {
  small: [8, 12],
  medium: [12, 20],
  large: [16, 32],
};

// Font stacks that degrade well across email clients, from usewaypoint/email-builder-js (MIT).
export const BUTTON_FONTS: Record<ButtonFont, string> = {
  'modern-sans': "'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', Arial, sans-serif",
  'geometric-sans': "Avenir, 'Avenir Next LT Pro', Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  'rounded-sans':
    "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif",
  'modern-serif': "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif",
  'book-serif': "'Iowan Old Style', 'Palatino Linotype', 'URW Palladio L', P052, serif",
  'monospace': "'Nimbus Mono PS', 'Courier New', 'Cutive Mono', monospace",
};

/**
 * A colour as `#rrggbb`, or null when it is not one. Browsers report inline colours as
 * `rgb(r, g, b)` through the CSSOM, so that form is accepted alongside `#rgb` and `#rrggbb`.
 */
export function normalizeHexColor(value: string | null | undefined): string | null {
  const color = (value ?? '').trim().toLowerCase();

  if (/^#[0-9a-f]{6}$/.test(color)) {
    return color;
  }
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }

  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(color);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    if (channels.every(channel => channel <= 255)) {
      return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
    }
  }

  return null;
}

/**
 * Whether a button may link to `href`: web, mail and phone links, in-page anchors, and links
 * built with Liquid (a variable such as `{{unsubscribeUrl}}` or a `{% if %}` that picks one).
 * Anything else, `javascript:` above all, is never written into a button.
 */
export function isSafeButtonHref(href: string | null | undefined): boolean {
  const value = (href ?? '').trim();
  return /^(https?:\/\/|mailto:|tel:|#|\{\{|\{%)/i.test(value);
}

// `property: value` pairs of an inline style. Values never contain `;` (font names are quoted
// without one), so splitting on it is enough.
function declarations(style: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const declaration of (style ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) {
      result.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim());
    }
  }
  return result;
}

// Font stacks compared without quotes or spaces: juice rewrites double quotes as single ones.
function fontKey(stack: string): string {
  return stack.replace(/["'\s]/g, '').toLowerCase();
}

/**
 * Button options from untrusted data (such as a look remembered in the browser), keeping only
 * known values and falling back to the defaults for the rest.
 */
export function toButtonStyle(value: unknown): ButtonStyle {
  const data = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const known = <T extends string>(table: Record<T, unknown>, key: unknown): key is T =>
    typeof key === 'string' && Object.hasOwn(table, key);

  return {
    backgroundColor: normalizeHexColor(String(data.backgroundColor ?? '')) ?? BUTTON_DEFAULTS.backgroundColor,
    textColor: normalizeHexColor(String(data.textColor ?? '')) ?? BUTTON_DEFAULTS.textColor,
    shape: known(BUTTON_RADIUS, data.shape) ? data.shape : BUTTON_DEFAULTS.shape,
    size: known(BUTTON_PADDING, data.size) ? data.size : BUTTON_DEFAULTS.size,
    fullWidth: typeof data.fullWidth === 'boolean' ? data.fullWidth : BUTTON_DEFAULTS.fullWidth,
    font: known(BUTTON_FONTS, data.font) ? data.font : null,
  };
}

/** The options of a button from its inline style, falling back to the defaults. */
export function readButtonStyle(style: string | null | undefined): ButtonStyle {
  const values = declarations(style);

  const radius = parseFloat(values.get('border-radius') ?? '');
  const shape: ButtonShape = Number.isNaN(radius)
    ? BUTTON_DEFAULTS.shape
    : radius === 0
      ? 'rectangle'
      : radius >= 32
        ? 'pill'
        : 'rounded';

  const padding = (values.get('padding') ?? '').replace(/\s+/g, ' ');
  const size =
    (Object.keys(BUTTON_PADDING) as ButtonSize[]).find(
      key => padding === `${BUTTON_PADDING[key][0]}px ${BUTTON_PADDING[key][1]}px`,
    ) ?? BUTTON_DEFAULTS.size;

  const family = fontKey(values.get('font-family') ?? '');
  const font = (Object.keys(BUTTON_FONTS) as ButtonFont[]).find(key => fontKey(BUTTON_FONTS[key]) === family) ?? null;

  return {
    backgroundColor: normalizeHexColor(values.get('background-color')) ?? BUTTON_DEFAULTS.backgroundColor,
    textColor: normalizeHexColor(values.get('color')) ?? BUTTON_DEFAULTS.textColor,
    shape,
    size,
    fullWidth: values.get('display') === 'block',
    font,
  };
}

/** The inline style a button is saved with, ending in `;` as the editor serialises styles. */
export function buttonStyle(button: ButtonStyle): string {
  const [vertical, horizontal] = BUTTON_PADDING[button.size];
  return [
    button.fullWidth ? 'display: block; text-align: center' : 'display: inline-block',
    `padding: ${vertical}px ${horizontal}px`,
    `background-color: ${normalizeHexColor(button.backgroundColor) ?? BUTTON_DEFAULTS.backgroundColor}`,
    `color: ${normalizeHexColor(button.textColor) ?? BUTTON_DEFAULTS.textColor}`,
    'text-decoration: none',
    'font-weight: 600',
    'line-height: 1.2',
    `border-radius: ${BUTTON_RADIUS[button.shape]}px`,
    ...(button.font ? [`font-family: ${BUTTON_FONTS[button.font]}`] : []),
  ]
    .map(declaration => `${declaration};`)
    .join(' ');
}

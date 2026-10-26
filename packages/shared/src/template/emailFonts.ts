/**
 * Fonts an email can use: its own font, and stacks that degrade well across email clients, from
 * usewaypoint/email-builder-js (MIT). Shared by the email's brand and its buttons.
 */

export type EmailFont = 'modern-sans' | 'geometric-sans' | 'rounded-sans' | 'modern-serif' | 'book-serif' | 'monospace';

/** The email's own font, which buttons without a font of their own also get when sent. */
export const EMAIL_FONT_FAMILY =
  "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const EMAIL_FONTS: Record<EmailFont, string> = {
  'modern-sans': "'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', Arial, sans-serif",
  'geometric-sans': "Avenir, 'Avenir Next LT Pro', Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  'rounded-sans':
    "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif",
  'modern-serif': "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif",
  'book-serif': "'Iowan Old Style', 'Palatino Linotype', 'URW Palladio L', P052, serif",
  'monospace': "'Nimbus Mono PS', 'Courier New', 'Cutive Mono', monospace",
};

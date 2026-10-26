import {
  BRAND_DEFAULTS,
  detectCustomHtmlPatterns,
  emailDocument,
  type EmailBrand,
  emailProseCss,
  splitEmailMarkers,
} from '@plunk/shared';

/**
 * Visual editor content in the document it is sent in, in its brand, with the stylesheet kept in
 * a <style> block, for previews. Custom HTML (from the HTML editor) already carries its own
 * styles and is shown as it is.
 */
export const wrapEmailWithStyles = (htmlBody: string, brand: EmailBrand = BRAND_DEFAULTS): string =>
  detectCustomHtmlPatterns(htmlBody) ? htmlBody : emailDocument(htmlBody, brand, emailProseCss(brand, {preview: true}));

/** A stored email body, with its preview text and brand in front of its content, as it is sent. */
export const wrapStoredEmail = (stored: string): string => {
  const {brand, body} = splitEmailMarkers(stored);
  return wrapEmailWithStyles(body, brand ?? BRAND_DEFAULTS);
};

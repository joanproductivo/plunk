import {detectCustomHtmlPatterns, emailDocument, emailProseCss} from '@plunk/shared';

/**
 * Visual editor content in the document it is sent in, with the stylesheet kept in a <style>
 * block, for previews. Custom HTML (from the HTML editor) already carries its own styles and is
 * shown as it is.
 */
export const wrapEmailWithStyles = (htmlBody: string): string =>
  detectCustomHtmlPatterns(htmlBody) ? htmlBody : emailDocument(htmlBody, emailProseCss(undefined, {preview: true}));

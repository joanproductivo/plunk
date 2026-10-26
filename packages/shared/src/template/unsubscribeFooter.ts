import {createTranslatorSync} from '../i18n/index.js';

/**
 * The unsubscribe footer Plunk adds to marketing emails, shared by sending (EmailService.compile)
 * and the dashboard's previews, so both show the same footer. Its markup, whitespace included, is
 * the one emails have always been sent with.
 */

// Its lines are indented as they always were: the whitespace is part of what is sent
const PARAGRAPH_INDENT = '                  ';

/** The footer around `paragraph`, the HTML inside its <p>. */
export function unsubscribeFooterHtml(paragraph: string): string {
  return `<table align="center" width="100%" style="max-width: 480px; width: 100%; margin-left: auto; margin-right: auto; font-family: Inter, ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'; border: 0; cellpadding: 0; cellspacing: 0;" role="presentation">
          <tbody>
            <tr>
              <td>
                <hr style="border: none; border-top: 1px solid #eaeaea; width: 100%; margin-top: 12px; margin-bottom: 12px;">
                <p style="font-size: 12px; line-height: 24px; margin: 16px 0; text-align: center; color: rgb(64, 64, 64);">
${PARAGRAPH_INDENT}${paragraph}
                </p>
              </td>
            </tr>
          </tbody>
        </table>`;
}

/**
 * Plunk's own footer text in `language` (English when it has none), followed by the link to update
 * preferences. The project's name goes in as it always has, unescaped.
 */
export function plunkFooterParagraph(language: string, projectName: string, href: string): string {
  const translator = createTranslatorSync(language);
  const text = translator.t('email.footer.unsubscribeText', {projectName});
  const linkText = translator.t('email.footer.updatePreferences');
  return `${text}\n${PARAGRAPH_INDENT}<a href="${href}">${linkText}</a>.`;
}

import {describe, expect, it} from 'vitest';

import {createTranslatorSync} from '../i18n/index.js';
import {plunkFooterParagraph, unsubscribeFooterHtml} from '../template/index.js';

// The footer exactly as EmailService.compile built it before it moved here, whitespace included
const before = (
  text: string,
  href: string,
  linkText: string,
) => `<table align="center" width="100%" style="max-width: 480px; width: 100%; margin-left: auto; margin-right: auto; font-family: Inter, ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'; border: 0; cellpadding: 0; cellspacing: 0;" role="presentation">
          <tbody>
            <tr>
              <td>
                <hr style="border: none; border-top: 1px solid #eaeaea; width: 100%; margin-top: 12px; margin-bottom: 12px;">
                <p style="font-size: 12px; line-height: 24px; margin: 16px 0; text-align: center; color: rgb(64, 64, 64);">
                  ${text}
                  <a href="${href}">${linkText}</a>.
                </p>
              </td>
            </tr>
          </tbody>
        </table>`;

describe('unsubscribeFooterHtml', () => {
  it("builds Plunk's footer byte for byte as emails were always sent, in every language", () => {
    for (const language of ['en', 'es', 'de', 'zh-TW', 'xx', 'es-ES']) {
      const translator = createTranslatorSync(language);
      const href = 'https://app.example.com/unsubscribe/contact-1?email=email-1';

      expect(unsubscribeFooterHtml(plunkFooterParagraph(language, 'Acme & Co', href))).toBe(
        before(
          translator.t('email.footer.unsubscribeText', {projectName: 'Acme & Co'}),
          href,
          translator.t('email.footer.updatePreferences'),
        ),
      );
    }
  });
});

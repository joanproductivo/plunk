import {describe, expect, it} from 'vitest';

import {createTranslatorSync} from '../i18n/index.js';
import {
  customFooterParagraph,
  footerParagraph,
  plunkFooterParagraph,
  resolveFooterLanguage,
  toProjectFooters,
  unsubscribeFooterHtml,
} from '../template/index.js';

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

describe('toProjectFooters', () => {
  it('keeps valid footers, trimmed, with Windows line breaks made plain', () => {
    expect(toProjectFooters({es: {text: '  Hola\r\nCalle 1  ', linkText: ' darte de baja '}})).toEqual({
      footers: {es: {text: 'Hola\nCalle 1', linkText: 'darte de baja'}},
      errors: [],
    });
  });

  it('says why it leaves anything out', () => {
    const {footers, errors} = toProjectFooters({
      xx: {text: 'Hi', linkText: 'unsubscribe'},
      constructor: {text: 'Hi', linkText: 'unsubscribe'},
      en: {text: '', linkText: 'unsubscribe'},
      de: {text: 'Hallo', linkText: '·'},
      fr: {text: 'x'.repeat(1001), linkText: 'désabonner'},
      it: {text: 'Ciao', linkText: '123'},
    });

    expect(footers).toEqual({});
    expect(errors).toHaveLength(6);
    expect(errors[0]).toBe('xx: not a supported language');
  });

  it('reads anything but an object as no footers', () => {
    for (const value of [undefined, null, 'x', ['es']]) {
      expect(toProjectFooters(value)).toEqual({footers: {}, errors: []});
    }
  });
});

describe('resolveFooterLanguage', () => {
  it("takes the contact's locale as it is, regardless of case, or its base language", () => {
    expect(resolveFooterLanguage('de', 'es')).toBe('de');
    expect(resolveFooterLanguage('zh-tw', 'es')).toBe('zh-TW');
    for (const locale of ['es-ES', 'es_ES', 'ES', ' es ']) {
      expect(resolveFooterLanguage(locale, 'en')).toBe('es');
    }
  });

  it("falls back to the project's language, then English, whatever the locale holds", () => {
    for (const locale of [undefined, null, '', 'xx', 'zh', 'constructor', '__proto__', 42, {}]) {
      expect(resolveFooterLanguage(locale, 'de')).toBe('de');
    }
    expect(resolveFooterLanguage('xx', null)).toBe('en');
    expect(resolveFooterLanguage('xx', 'nonsense')).toBe('en');
  });
});

describe('customFooterParagraph', () => {
  const href = 'https://app.example.com/unsubscribe/c1';

  it('escapes the text, the link text and the project name', () => {
    const html = customFooterParagraph({text: '<b>{projectName}</b>', linkText: '<i>leave</i>'}, 'A & <B>', href);

    expect(html).toBe(
      `&lt;b&gt;A &amp; &lt;B&gt;&lt;/b&gt;\n                  <a href="${href}">&lt;i&gt;leave&lt;/i&gt;</a>`,
    );
  });

  it('puts the link where {link} is, keeps line breaks, and replaces every {projectName}', () => {
    const html = customFooterParagraph(
      {text: '{projectName}, {link}.\nCalle 1\n{projectName}', linkText: 'baja'},
      '$& Co',
      href,
    );

    expect(html).toBe(`$&amp; Co, <a href="${href}">baja</a>.<br>Calle 1<br>$&amp; Co`);
  });

  it("does not let the project's name move the link", () => {
    const html = customFooterParagraph({text: 'From {projectName}', linkText: 'leave'}, '{link}', href);

    expect(html).toBe(`From {link}\n                  <a href="${href}">leave</a>`);
  });
});

describe('footerParagraph', () => {
  const href = 'https://app.example.com/unsubscribe/c1';
  const footers = {es: {text: 'Hola de {projectName}', linkText: 'darte de baja'}};

  it("uses the project's own footer in that language, and Plunk's elsewhere", () => {
    expect(footerParagraph({language: 'es', projectName: 'Acme', href, footers})).toContain('Hola de Acme');
    expect(footerParagraph({language: 'de', projectName: 'Acme', href, footers})).toBe(
      plunkFooterParagraph('de', 'Acme', href),
    );
    expect(footerParagraph({language: 'es', projectName: 'Acme', href})).toBe(plunkFooterParagraph('es', 'Acme', href));
  });
});

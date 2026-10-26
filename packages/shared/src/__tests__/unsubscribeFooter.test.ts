import {describe, expect, it} from 'vitest';

import {createTranslatorSync} from '../i18n/index.js';
import {
  footerParagraph,
  isPlunkFooter,
  plunkFooterParagraph,
  plunkFooterTemplate,
  resolveContactLanguage,
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
      it: {text: 'Ciao', linkText: '...'},
    });

    expect(footers).toEqual({});
    expect(errors).toHaveLength(6);
    expect(errors[0]).toBe('xx: not a supported language');
  });

  it('keeps the link visible: no invisible characters, and three letters or digits', () => {
    const filler = String.fromCharCode(0x3164);
    const zeroWidth = String.fromCharCode(0x200b);
    const override = String.fromCharCode(0x202e);
    for (const linkText of [filler.repeat(3), `x${zeroWidth}${zeroWidth}`, `${override}etadpu`, 'a\nb\nc', 'ab.']) {
      expect(toProjectFooters({es: {text: 'Hola', linkText}}).errors).toEqual([
        'es: the link text needs 3 to 100 visible letters or digits, on one line',
      ]);
    }
    expect(toProjectFooters({es: {text: `Hola ${override}`, linkText: 'baja'}}).errors).toEqual([
      'es: the text cannot hold characters that reorder it',
    ]);
    // A joiner inside an emoji is fine in the text
    const family = `\u{1F468}${String.fromCharCode(0x200d)}\u{1F469}`;
    expect(toProjectFooters({es: {text: `Hola ${family}`, linkText: 'baja'}}).errors).toEqual([]);
  });

  it('keeps the footer short: blank lines folded, few lines, links and names', () => {
    expect(toProjectFooters({es: {text: 'a\n\n\n\n\nb', linkText: 'baja'}}).footers.es!.text).toBe('a\n\nb');
    expect(toProjectFooters({es: {text: 'a\n'.repeat(10) + 'b', linkText: 'baja'}}).errors).toEqual([
      'es: the text can have at most 10 lines',
    ]);
    expect(toProjectFooters({es: {text: '{link}'.repeat(3), linkText: 'baja'}}).errors).toEqual([
      'es: the text can place the link at most 2 times',
    ]);
    expect(toProjectFooters({es: {text: '{projectName}'.repeat(4), linkText: 'baja'}}).errors).toEqual([
      'es: the text can name the project at most 3 times',
    ]);
  });

  it('lists only the first few reasons', () => {
    const many = Object.fromEntries(Array.from({length: 40}, (_, index) => [`x${index}`, {}]));

    expect(toProjectFooters(many).errors).toHaveLength(6);
    expect(toProjectFooters(many).errors.at(-1)).toBe('and 35 more');
  });

  it('reads anything but an object as no footers', () => {
    for (const value of [undefined, null, 'x', ['es']]) {
      expect(toProjectFooters(value)).toEqual({footers: {}, errors: []});
    }
  });
});

describe('resolveContactLanguage', () => {
  it("takes the contact's locale as it is, regardless of case, or its base language", () => {
    expect(resolveContactLanguage('de', 'es')).toBe('de');
    expect(resolveContactLanguage('zh-tw', 'es')).toBe('zh-TW');
    for (const locale of ['es-ES', 'es_ES', 'ES', ' es ']) {
      expect(resolveContactLanguage(locale, 'en')).toBe('es');
    }
  });

  it("falls back to the project's language, then English, whatever the locale holds", () => {
    for (const locale of [undefined, null, '', 'xx', 'zh', 'constructor', '__proto__', 42, {}]) {
      expect(resolveContactLanguage(locale, 'de')).toBe('de');
    }
    expect(resolveContactLanguage('xx', null)).toBe('en');
    expect(resolveContactLanguage('xx', 'nonsense')).toBe('en');
  });
});

describe('a footer of its own', () => {
  const href = 'https://app.example.com/unsubscribe/c1';
  const customFooterParagraph = (footer: {text: string; linkText: string}, projectName: string, url: string) =>
    footerParagraph({language: 'es', projectName, href: url, footers: {es: footer}});

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

describe("Plunk's footer as a starting point", () => {
  it("sends just like Plunk's own when left as it is, and needs no footer of its own", () => {
    for (const language of ['es', 'de', 'ja']) {
      const template = plunkFooterTemplate(language);
      const own = footerParagraph({language, projectName: 'Acme', href: '#', footers: {[language]: template}});
      const flat = (html: string) => html.replace(/\s+/g, ' ');

      expect(flat(own)).toBe(flat(plunkFooterParagraph(language, 'Acme', '#')));
      expect(isPlunkFooter(template, language)).toBe(true);
      expect(isPlunkFooter({...template, linkText: 'otro'}, language)).toBe(false);
    }
  });
});

import {createTranslatorSync, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES} from '../i18n/index.js';
import {escapeHtml} from './html.js';

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

/** A project's own footer in one language: its text, and the text of the link it always carries. */
export interface ProjectFooter {
  text: string;
  linkText: string;
}

/** A project's own footers, by language code; languages without one get Plunk's. */
export type ProjectFooters = Partial<Record<string, ProjectFooter>>;

const TEXT_MAX = 1000;
const LINK_MIN = 3;
const LINK_MAX = 100;

const CODES = SUPPORTED_LANGUAGES.map(language => language.code);

/**
 * A project's footers from untrusted data, keeping the valid ones, with the reasons the others
 * were left out. Only supported languages, with a text of up to 1000 characters and a link text of
 * 3 to 100 that has letters in it, so the link can never be reduced to a dot.
 */
export function toProjectFooters(value: unknown): {footers: ProjectFooters; errors: string[]} {
  const data = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const footers: ProjectFooters = {};
  const errors: string[] = [];

  for (const [code, entry] of Object.entries(data)) {
    if (!CODES.includes(code)) {
      errors.push(`${code}: not a supported language`);
      continue;
    }
    const fields = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const text = typeof fields.text === 'string' ? fields.text.replace(/\r\n?/g, '\n').trim() : '';
    const linkText = typeof fields.linkText === 'string' ? fields.linkText.trim() : '';

    if (text.length < 1 || text.length > TEXT_MAX) {
      errors.push(`${code}: the text needs 1 to ${TEXT_MAX} characters`);
    } else if (linkText.length < LINK_MIN || linkText.length > LINK_MAX || !/\p{L}/u.test(linkText)) {
      errors.push(`${code}: the link text needs ${LINK_MIN} to ${LINK_MAX} characters, with letters`);
    } else {
      footers[code] = {text, linkText};
    }
  }

  return {footers, errors};
}

/**
 * The language a contact's footer is in: their locale as it is, regardless of case, or its base
 * language (es-ES, es_ES, ES → es); else the project's language; else English. Always one of the
 * supported codes, whatever the locale holds: it comes from contact data anyone with the public
 * key can write.
 */
export function resolveFooterLanguage(locale: unknown, projectLanguage: string | null | undefined): string {
  const find = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const wanted = value.trim().toLowerCase().replace(/_/g, '-');
    return CODES.find(code => code.toLowerCase() === wanted) ?? CODES.find(code => code === wanted.split('-')[0]);
  };

  return find(locale) ?? find(projectLanguage) ?? DEFAULT_LANGUAGE;
}

/**
 * A project's own footer text with its link: escaped, with `{projectName}` replaced, the link where
 * `{link}` is or else at the end, and line breaks kept.
 */
export function customFooterParagraph(footer: ProjectFooter, projectName: string, href: string): string {
  const link = `<a href="${href}">${escapeHtml(footer.linkText)}</a>`;
  // The author's {link} goes in before the project's name, which could itself hold "{link}"
  const text = escapeHtml(footer.text).replace(/\n/g, '<br>');
  const withLink = text.includes('{link}')
    ? text.replaceAll('{link}', () => link)
    : `${text}\n${PARAGRAPH_INDENT}${link}`;
  return withLink.replaceAll('{projectName}', () => escapeHtml(projectName));
}

/** The footer text for a contact: the project's own in that language, or else Plunk's. */
export function footerParagraph(params: {
  language: string;
  projectName: string;
  href: string;
  footers?: ProjectFooters;
}): string {
  const own =
    params.footers && Object.hasOwn(params.footers, params.language) ? params.footers[params.language] : undefined;
  return own
    ? customFooterParagraph(own, params.projectName, params.href)
    : plunkFooterParagraph(params.language, params.projectName, params.href);
}

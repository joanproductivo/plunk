import {createTranslatorSync, DEFAULT_LANGUAGE, isValidLanguageCode, SUPPORTED_LANGUAGES} from '../i18n/index.js';

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

/** A project's own footer in one language: its text, and the text of the link it always carries. */
export interface ProjectFooter {
  text: string;
  linkText: string;
}

/** A project's own footers, by language code; languages without one get Plunk's. */
export type ProjectFooters = Partial<Record<string, ProjectFooter>>;

/** Plunk's own footer text and link text in `language` (English when it has none), unfilled. */
export function plunkFooterText(language: string): ProjectFooter {
  const translator = createTranslatorSync(language);
  return {text: translator.t('email.footer.unsubscribeText'), linkText: translator.t('email.footer.updatePreferences')};
}

/**
 * Plunk's own footer text in `language`, followed by the link to update preferences. The project's
 * name goes in as it always has, unescaped.
 */
export function plunkFooterParagraph(language: string, projectName: string, href: string): string {
  const translator = createTranslatorSync(language);
  const text = translator.t('email.footer.unsubscribeText', {projectName});
  return `${text}\n${PARAGRAPH_INDENT}<a href="${href}">${translator.t('email.footer.updatePreferences')}</a>.`;
}

/** Plunk's footer as a project's own starts from: its text with the link in place, as Plunk sends it. */
export function plunkFooterTemplate(language: string): ProjectFooter {
  const {text, linkText} = plunkFooterText(language);
  return {text: `${text} {link}.`, linkText};
}

const TEXT_MAX = 1000;
const LINES_MAX = 10;
const LINK_MIN = 3;
const LINK_MAX = 100;
const LINKS_MAX = 2;
const NAMES_MAX = 3;
const ERRORS_MAX = 5;

const CODES = SUPPORTED_LANGUAGES.map(language => language.code);
const count = (text: string, token: string) => text.split(token).length - 1;

// The reason a footer cannot be kept, or null. The link must stay visible and plain: no characters
// that render as nothing (zero-width, fillers) or reorder text, and at least three letters or digits
function footerProblem(text: string, linkText: string): string | null {
  if (text.length < 1 || text.length > TEXT_MAX) return `the text needs 1 to ${TEXT_MAX} characters`;
  if (count(text, '\n') >= LINES_MAX) return `the text can have at most ${LINES_MAX} lines`;
  if (/\p{Bidi_Control}/u.test(text)) return 'the text cannot hold characters that reorder it';
  if (count(text, '{link}') > LINKS_MAX) return `the text can place the link at most ${LINKS_MAX} times`;
  if (count(text, '{projectName}') > NAMES_MAX) return `the text can name the project at most ${NAMES_MAX} times`;
  if (
    linkText.length > LINK_MAX ||
    /[\p{Default_Ignorable_Code_Point}\n]/u.test(linkText) ||
    (linkText.match(/[\p{L}\p{N}]/gu) ?? []).length < LINK_MIN
  ) {
    return `the link text needs ${LINK_MIN} to ${LINK_MAX} visible letters or digits, on one line`;
  }
  return null;
}

/**
 * A project's footers from untrusted data, keeping the valid ones, with the reasons the others
 * were left out (the first few). Line breaks are made plain and runs of blank lines kept to one.
 */
export function toProjectFooters(value: unknown): {footers: ProjectFooters; errors: string[]} {
  const data = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const footers: ProjectFooters = {};
  const errors: string[] = [];

  for (const [code, entry] of Object.entries(data)) {
    const fields = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const text =
      typeof fields.text === 'string'
        ? fields.text
            .replace(/\r\n?/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        : '';
    const linkText = typeof fields.linkText === 'string' ? fields.linkText.trim() : '';
    const problem = isValidLanguageCode(code) ? footerProblem(text, linkText) : 'not a supported language';

    if (problem) {
      errors.push(`${code.slice(0, 20)}: ${problem}`);
    } else {
      footers[code] = {text, linkText};
    }
  }

  return {
    footers,
    errors:
      errors.length > ERRORS_MAX ? [...errors.slice(0, ERRORS_MAX), `and ${errors.length - ERRORS_MAX} more`] : errors,
  };
}

/** Whether `footer` says just what Plunk's would in `language`, so it needs no footer of its own. */
export function isPlunkFooter(footer: ProjectFooter, language: string): boolean {
  const plunk = plunkFooterTemplate(language);
  return footer.text.trim() === plunk.text && footer.linkText.trim() === plunk.linkText;
}

/**
 * The language a contact's footer and pages are in: their locale as it is, regardless of case, or
 * its base language (es-ES, es_ES, ES → es); else the project's language; else English. Always one
 * of the supported codes, whatever the locale holds: it comes from contact data anyone with the
 * public key can write.
 */
export function resolveContactLanguage(locale: unknown, projectLanguage: string | null | undefined): string {
  const find = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const wanted = value.trim().toLowerCase().replace(/_/g, '-');
    return CODES.find(code => code.toLowerCase() === wanted) ?? CODES.find(code => code === wanted.split('-')[0]);
  };

  return find(locale) ?? find(projectLanguage) ?? DEFAULT_LANGUAGE;
}

// A project's own footer text with its link: escaped, the link where {link} is or else at the end,
// {projectName} replaced (after the link, as the name could itself hold "{link}"), line breaks kept
function customFooterParagraph(footer: ProjectFooter, projectName: string, href: string): string {
  const link = `<a href="${href}">${escapeHtml(footer.linkText)}</a>`;
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

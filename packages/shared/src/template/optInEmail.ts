import type {OptInText, OptInTexts} from '@plunk/types';

import {createTranslatorSync} from '../i18n/index.js';

import {BRAND_DEFAULTS, type EmailBrand} from './brand.js';
import {BUTTON_DEFAULTS, type ButtonStyle, buttonStyle} from './emailButton.js';
import {EMAIL_FONTS} from './emailFonts.js';
import {emailDocument} from './emailDocument.js';
import {escapeHtml} from './html.js';
import {countOccurrences, isVisibleLabel, plainText, readTextsByLanguage} from './unsubscribeFooter.js';

/**
 * The double opt-in email (Plunk Lite): what a contact receives to confirm a sign-up, shared by
 * sending (OptInService) and the dashboard's preview, so both show the same email.
 */

/** Plunk's own confirmation email in `language` (English when it has none). */
export function plunkOptInText(language: string): OptInText {
  const translator = createTranslatorSync(language);
  return {
    subject: translator.t('email.optin.subject'),
    text: translator.t('email.optin.text'),
    buttonText: translator.t('email.optin.button'),
  };
}

const SUBJECT_MAX = 200;
const TEXT_MAX = 2000;
const LINES_MAX = 20;
const BUTTON_MIN = 3;
const BUTTON_MAX = 60;
const NAMES_MAX = 3;

// The reason a confirmation email cannot be kept, or null. Sending runs Liquid over the email with
// the contact's data, which a sign-up form lets anyone write, so the texts hold none of its syntax
function optInProblem({subject, text, buttonText}: OptInText): string | null {
  if (subject.length < 1 || subject.length > SUBJECT_MAX) return `the subject needs 1 to ${SUBJECT_MAX} characters`;
  if (/\n/.test(subject)) return 'the subject must be on one line';
  if (text.length < 1 || text.length > TEXT_MAX) return `the text needs 1 to ${TEXT_MAX} characters`;
  if (countOccurrences(text, '\n') >= LINES_MAX) return `the text can have at most ${LINES_MAX} lines`;
  if ([subject, text, buttonText].some(value => /\p{Bidi_Control}/u.test(value))) {
    return 'the texts cannot hold characters that reorder them';
  }
  if ([subject, text, buttonText].some(value => /\{\{|\{%/.test(value))) {
    return 'the texts cannot hold template tags ({{ or {%); use {projectName} for the project name';
  }
  if (countOccurrences(subject, '{projectName}') + countOccurrences(text, '{projectName}') > NAMES_MAX) {
    return `the texts can name the project at most ${NAMES_MAX} times`;
  }
  if (!isVisibleLabel(buttonText, BUTTON_MIN, BUTTON_MAX)) {
    return `the button text needs ${BUTTON_MIN} to ${BUTTON_MAX} visible letters or digits, on one line`;
  }
  return null;
}

/**
 * A project's confirmation emails from untrusted data, keeping the valid ones, with the reasons the
 * others were left out (the first few). Line breaks are made plain and runs of blank lines kept to one.
 */
export function toOptInTexts(value: unknown): {texts: OptInTexts; errors: string[]} {
  return readTextsByLanguage(
    value,
    fields => ({
      subject: plainText(fields.subject),
      text: plainText(fields.text),
      buttonText: plainText(fields.buttonText),
    }),
    optInProblem,
  );
}

/** Whether `text` says just what Plunk's would in `language`, so it needs no text of its own */
export function isPlunkOptInText(text: OptInText, language: string): boolean {
  const plunk = plunkOptInText(language);
  return text.subject === plunk.subject && text.text === plunk.text && text.buttonText === plunk.buttonText;
}

// Escaped for HTML, with braces as entities: sending runs Liquid over the body, and a project name
// is not to be read as a template tag there
function escapeForBody(value: string): string {
  return escapeHtml(value).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

/**
 * The confirmation email for a contact in `language`: the project's own text in that language, or
 * else Plunk's, with the link to confirm as a button in the project's brand.
 */
export function optInEmail(params: {
  language: string;
  projectName: string;
  url: string;
  texts?: OptInTexts;
  brand?: EmailBrand & {button?: ButtonStyle};
}): {subject: string; body: string} {
  const own = params.texts && Object.hasOwn(params.texts, params.language) ? params.texts[params.language] : undefined;
  const {subject, text, buttonText} = own ?? plunkOptInText(params.language);
  const brand = params.brand ?? BRAND_DEFAULTS;
  const font = brand.font ? ` font-family: ${EMAIL_FONTS[brand.font]};` : '';
  const name = escapeForBody(params.projectName);

  const paragraphs = text
    .split(/\n{2,}/)
    .map(paragraph => {
      const html = paragraph
        .split('{projectName}')
        .map(part => escapeForBody(part).replace(/\n/g, '<br>'))
        .join(name);
      return `<p style="color: ${brand.textColor};${font}">${html}</p>`;
    })
    .join('\n    ');
  // Never through SES's click tracking: its event would keep the link, which confirms the sign-up
  const button = `<p><a href="${escapeHtml(params.url)}" ses:no-track style="${buttonStyle(params.brand?.button ?? BUTTON_DEFAULTS)}">${escapeForBody(buttonText)}</a></p>`;
  const ignore = `<p style="color: #6b7280; font-size: 12px;${font}">${escapeForBody(createTranslatorSync(params.language).t('email.optin.ignore'))}</p>`;

  return {
    // Sending runs Liquid over the subject too: a tag in the project's name stays text
    subject: subject.replaceAll('{projectName}', () => params.projectName.replace(/\{(?=[{%])/g, '{\u200b')),
    body: emailDocument(`${paragraphs}\n    ${button}\n    ${ignore}`, brand),
  };
}

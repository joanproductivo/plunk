import {describe, expect, it} from 'vitest';

import {SUPPORTED_LANGUAGES} from '../i18n/index.js';
import {isPlunkOptInText, optInEmail, plunkOptInText, renderTemplate, toOptInTexts} from '../template/index.js';

const valid = {subject: 'Confirm {projectName}', text: 'Hello.\n\nPlease confirm.', buttonText: 'Confirm'};

describe('toOptInTexts', () => {
  it('keeps valid texts by language and trims them', () => {
    const {texts, errors} = toOptInTexts({es: {...valid, text: '  Hola\r\n\r\n\r\n\r\nadiós  '}});
    expect(errors).toEqual([]);
    expect(texts.es).toEqual({...valid, text: 'Hola\n\nadiós'});
  });

  it.each([
    ['an unknown language', {xx: valid}, 'not a supported language'],
    ['an empty subject', {en: {...valid, subject: ''}}, 'subject'],
    ['a subject on two lines', {en: {...valid, subject: 'a\nb'}}, 'one line'],
    ['a Liquid tag', {en: {...valid, text: 'Hi {{ name }}'}}, 'template tags'],
    ['a Liquid block', {en: {...valid, subject: '{% if x %}'}}, 'template tags'],
    ['an invisible button', {en: {...valid, buttonText: '​​​'}}, 'button text'],
    ['characters that reorder text', {en: {...valid, text: 'a‮b'}}, 'reorder'],
  ])('refuses %s', (_, value, reason) => {
    const {texts, errors} = toOptInTexts(value);
    expect(Object.keys(texts)).toEqual([]);
    expect(errors[0]).toContain(reason);
  });
});

describe('optInEmail', () => {
  const url = 'https://app.example.com/confirm#token';

  it("uses Plunk's text in the contact's language when the project has none", () => {
    const {subject, body} = optInEmail({language: 'es', projectName: 'Vida', url});
    expect(subject).toBe('Confirma tu suscripción a Vida');
    expect(body).toContain('Gracias por apuntarte a los emails de Vida.');
    expect(body).toContain(`href="${url}"`);
    expect(body).toContain('Confirmar mi suscripción');
  });

  it("uses the project's own text in that language", () => {
    const {subject, body} = optInEmail({language: 'en', projectName: 'Vida', url, texts: {en: valid}});
    expect(subject).toBe('Confirm Vida');
    expect(body).toContain('<p style="color: #374151;">Hello.</p>');
  });

  it('escapes the texts and keeps Liquid from reading the project name when the email is sent', () => {
    const {body} = optInEmail({language: 'en', projectName: '<b>{{ email }}</b>', url, texts: {en: valid}});
    expect(body).not.toContain('<b>');
    // Sending renders the body with the contact's data, which a form can write
    expect(renderTemplate(body, {email: 'attacker@example.com'})).not.toContain('attacker@example.com');
  });

  it('keeps Liquid from reading the project name in the subject too, wherever it joins the text', () => {
    for (const [projectName, own] of [
      ['{{ email }}', 'Confirm {projectName}'],
      // A name ending in `{` meets the text that follows it
      ['Acme {', '{projectName}{ email }}'],
    ]) {
      const {subject} = optInEmail({
        language: 'en',
        projectName: projectName!,
        url,
        texts: {en: {...valid, subject: own!}},
      });
      expect(renderTemplate(subject, {email: 'attacker@example.com'})).not.toContain('attacker@example.com');
    }
  });

  it("keeps the confirmation link out of SES's click tracking", () => {
    expect(optInEmail({language: 'en', projectName: 'Vida', url}).body).toMatch(/<a href="[^"]+" ses:no-track /);
  });
});

describe('plunkOptInText', () => {
  it('gives a valid confirmation email in every language', () => {
    for (const {code} of SUPPORTED_LANGUAGES) {
      expect(toOptInTexts({[code]: plunkOptInText(code)}).errors).toEqual([]);
    }
  });
  it("tells Plunk's text from a project's own", () => {
    expect(isPlunkOptInText(plunkOptInText('es'), 'es')).toBe(true);
    expect(isPlunkOptInText({...plunkOptInText('es'), buttonText: 'Sí'}, 'es')).toBe(false);
  });
});

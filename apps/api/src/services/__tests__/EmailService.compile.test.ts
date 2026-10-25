import type {Contact, Project} from '@plunk/db';
import {describe, expect, it} from 'vitest';

import {EmailService} from '../EmailService';

const contact = {id: 'contact-1', email: 'ana@example.com', data: null} as unknown as Contact;
const project = {id: 'project-1', name: 'Acme', language: 'en', subscription: null} as unknown as Project;

describe('EmailService.compile', () => {
  it('adds the unsubscribe footer before </body> of a visual editor email', () => {
    const html = EmailService.compile({content: '<p>Hello</p>', contact, project});

    expect(html).toMatch(/<p[^>]*>Hello<\/p>[\s\S]*unsubscribe\/contact-1[\s\S]*<\/body>\s*<\/html>$/);
  });

  it('keeps the footer visible when contact data put a </body> inside the preheader', () => {
    // As Liquid leaves it after rendering {{name}} with name = "x</body>y"
    const content = '<!--plunk:preheader:Hi x</body>y--><p>Hello</p>';

    const html = EmailService.compile({content, contact, project});
    const footer = html.indexOf('unsubscribe/contact-1');
    const preheaderEnd = html.indexOf('</div>', html.indexOf('data-plunk-preheader'));

    expect(footer).toBeGreaterThan(preheaderEnd);
    expect(html.lastIndexOf('</body>')).toBeGreaterThan(footer);
  });
});

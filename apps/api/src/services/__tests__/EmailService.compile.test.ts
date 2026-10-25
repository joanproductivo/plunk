import type {Contact, Project} from '@plunk/db';
import {describe, expect, it} from 'vitest';

import {EmailService} from '../EmailService';
import {factories} from '../../../../../test/helpers';

/**
 * The visual editor serialises a centred or right-aligned image as a paragraph wrapping the
 * <img>, with inline margins (apps/web/src/components/EmailEditor/ResizableImage.tsx; the same
 * markup is pinned in its __tests__/ResizableImage.test.ts). That markup has to count as
 * visual-editor content here too, so the email is sent inside the same styled wrapper the
 * editor previews it in. Sending inlines the prose styles, so the image gains style
 * declarations, but its own alignment ones come last and win.
 */
describe('EmailService.compile — aligned images from the visual editor', () => {
  it.each([
    ['centred', 'center', 'margin-left: auto; margin-right: auto;'],
    ['right-aligned', 'right', 'margin-left: auto; margin-right: 0px;'],
  ])('sends a %s image inside the styled wrapper, keeping its alignment', async (_label, align, margins) => {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const image = `<p style="text-align: ${align};"><img src="https://example.com/logo.png" width="300" height="200" class="email-image" style="display: block; ${margins}"></p>`;

    const html = EmailService.compile({content: `<p>Hello</p>${image}`, contact, project, includeUnsubscribe: false});

    expect(html).toMatch(/<div class="prose prose-sm max-w-none" style="[^"]*">/);
    expect(html).toMatch(new RegExp(`<p style="[^"]*text-align: ${align};"><img src="https://example.com/logo.png"`));
    expect(html).toMatch(new RegExp(`class="email-image" style="[^"]*display: block; ${margins}"`));
  });
});

const contact = {id: 'contact-1', email: 'ana@example.com', data: null} as unknown as Contact;
const project = {id: 'project-1', name: 'Acme', language: 'en', subscription: null} as unknown as Project;

describe('EmailService.compile — unsubscribe footer', () => {
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

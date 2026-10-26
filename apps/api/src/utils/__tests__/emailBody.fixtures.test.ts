import {BUTTON_DEFAULTS, buttonStyle, joinEmailMarkers, spacerStyle, toEmailBrand} from '@plunk/shared';
import {describe, expect, it} from 'vitest';

import {renderBody} from '../emailBody.js';

/**
 * Emails exactly as they were sent before brands existed, kept as files. An email without a brand
 * marker must keep going out byte for byte the same, so any change here is a change every past
 * template and campaign would pick up on its next send.
 */
const button = (style = buttonStyle(BUTTON_DEFAULTS)) =>
  `<a class="email-button" href="https://example.com/?a=1&amp;b=2" style="${style}">Shop now</a>`;

const FIXTURES: Record<string, string> = {
  'text':
    '<h1>Welcome, {{firstName}}</h1><h2>What is new</h2><h3>Small print</h3>' +
    '<p>Text with <strong>bold</strong>, <em>italic</em>, <s>strike</s>, <code>code</code> and ' +
    '<a href="https://example.com">a link</a>.</p><p><span style="color: rgb(225, 29, 72);">Red</span> ' +
    'Imágenes 🎉 ñ &amp; &lt;b&gt; “x”<br>line</p><!-- note -->',
  'lists-and-quote':
    '<ul><li><p>One</p></li><li><p>Two</p><ol><li><p>Nested</p></li></ol></li></ul>' +
    '<blockquote><p>A quote</p></blockquote><pre><code>const a = 1;</code></pre>',
  'blocks':
    `<p style="text-align: center;">${button()}</p>` +
    `<p>${button(buttonStyle({...BUTTON_DEFAULTS, font: 'book-serif', shape: 'pill', fullWidth: true}))}</p>` +
    '<hr style="border-width: 4px 0px 0px; border-style: solid; border-color: rgb(225, 29, 72); margin: 16px 0px;">' +
    `<hr class="email-spacer" style="${spacerStyle(48)}">` +
    '<p style="text-align: center;"><img src="https://example.com/a.png" width="200" class="email-image" ' +
    'style="display: block; margin-left: auto; margin-right: auto;"></p>',
  'preheader': '<!--plunk:preheader:Hi there &amp; welcome--><p>Hello</p>',
  'custom-html': '<!--plunk:preheader:Hi--><table><tr><td style="color: red">Hi</td></tr></table>',
};

describe('renderBody without a brand', () => {
  for (const [name, body] of Object.entries(FIXTURES)) {
    it(`sends "${name}" exactly as before brands`, async () => {
      await expect(renderBody(body)).toMatchFileSnapshot(`./__fixtures__/renderBody/${name}.html`);
    });
  }
});

/**
 * Emails in a framed brand, kept as files from before boxes were sent as tables: sending boxes
 * rearranges a framed column only when it holds a full-width one, so these must keep going out the same.
 */
const FOOTER = '<p style="font-size: 12px;">Unsubscribe from Acme.</p>';
const BRANDED: Record<string, Parameters<typeof toEmailBrand>[0]> = {
  'framed': {backgroundColor: '#f3f4f6', contentWidth: 600, font: 'book-serif', linkColor: '#0a7c3e'},
  'framed-dark-column': {backgroundColor: '#111827', contentColor: '#1f2937', textColor: '#f9fafb'},
};

describe('renderBody in a framed brand', () => {
  for (const [name, brand] of Object.entries(BRANDED)) {
    it(`sends "${name}" as before editor boxes`, async () => {
      const content = joinEmailMarkers({
        preheader: 'Hi there',
        brand: toEmailBrand(brand),
        body: FIXTURES.text! + FIXTURES['lists-and-quote']! + FIXTURES.blocks!,
      });
      await expect(renderBody(content, undefined, FOOTER)).toMatchFileSnapshot(
        `./__fixtures__/renderBody/branded-${name}.html`,
      );
    });
  }
});

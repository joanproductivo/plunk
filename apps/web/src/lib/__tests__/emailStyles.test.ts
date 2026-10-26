// @vitest-environment happy-dom
import {BRAND_DEFAULTS, joinEmailMarkers, toEmailBrand} from '@plunk/shared';
import {describe, expect, it} from 'vitest';

import {wrapStoredEmail} from '../emailStyles';

describe('wrapStoredEmail', () => {
  it('shows a stored email in its brand, without its markers', () => {
    const stored = joinEmailMarkers({
      preheader: 'Hello',
      brand: toEmailBrand({linkColor: '#0a7c3e', backgroundColor: '#f3f4f6'}),
      body: '<p>Hi <a href="https://a.com">there</a></p>',
    });

    const html = wrapStoredEmail(stored);

    expect(html).not.toContain('plunk:brand');
    expect(html).not.toContain('plunk:preheader');
    expect(html).toContain('bgcolor="#f3f4f6"');
    expect(html).toContain('color: #0a7c3e;');
  });

  it('shows an email without a brand as it always looked, and custom HTML as it is', () => {
    expect(wrapStoredEmail('<p>Hi</p>')).toContain(`color: ${BRAND_DEFAULTS.linkColor};`);
    expect(wrapStoredEmail('<table><tr><td>Hi</td></tr></table>')).toBe('<table><tr><td>Hi</td></tr></table>');
  });
});

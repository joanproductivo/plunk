// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';

import {isLoneChildParagraph} from '../blockAlignment';

function paragraph(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.querySelector('p')!;
}

describe('isLoneChildParagraph', () => {
  it('claims a paragraph holding only the block, whatever text the block itself holds', () => {
    expect(isLoneChildParagraph(paragraph('<p><a class="email-button">Shop now</a></p>'), 'a.email-button')).toBe(true);
    expect(isLoneChildParagraph(paragraph('<p> <img src="x.png"> </p>'), 'img[src]')).toBe(true);
  });

  it('leaves a paragraph with text of its own around the block', () => {
    expect(isLoneChildParagraph(paragraph('<p>Hi <a class="email-button">Go</a></p>'), 'a.email-button')).toBe(false);
    // A non-breaking space is often a deliberate spacer
    expect(isLoneChildParagraph(paragraph('<p>&nbsp;<img src="x.png"></p>'), 'img[src]')).toBe(false);
  });

  it('leaves a paragraph whose only child is something else', () => {
    expect(isLoneChildParagraph(paragraph('<p><a href="x">Go</a></p>'), 'a.email-button')).toBe(false);
    expect(isLoneChildParagraph(paragraph('<p><img src="x.png"><img src="y.png"></p>'), 'img[src]')).toBe(false);
  });

  it('leaves the paragraph a list item opens with', () => {
    expect(isLoneChildParagraph(paragraph('<ul><li><p><img src="x.png"></p></li></ul>'), 'img[src]')).toBe(false);
  });
});

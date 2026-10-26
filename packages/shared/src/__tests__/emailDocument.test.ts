import {describe, expect, it} from 'vitest';
import {detectCustomHtmlPatterns, visualAttributeText} from '../template/index.js';

describe('detectCustomHtmlPatterns', () => {
  describe('empty / whitespace input', () => {
    it('returns false for empty string', () => {
      expect(detectCustomHtmlPatterns('')).toBe(false);
    });

    it('returns false for whitespace-only string', () => {
      expect(detectCustomHtmlPatterns('   \n\t  ')).toBe(false);
    });
  });

  describe('content TipTap can round-trip (should NOT be flagged as custom)', () => {
    it('returns false for a basic paragraph', () => {
      expect(detectCustomHtmlPatterns('<p>Hello</p>')).toBe(false);
    });

    it('returns false for headings, lists, blockquote, bold, italic', () => {
      expect(
        detectCustomHtmlPatterns(
          '<h1>Title</h1><p><strong>bold</strong> <em>italic</em></p><ul><li>one</li></ul><blockquote>quote</blockquote>',
        ),
      ).toBe(false);
    });

    it('returns false for <span> with inline color style (TipTap TextStyle output)', () => {
      expect(detectCustomHtmlPatterns('<span style="color: rgb(220, 38, 38)">red</span>')).toBe(false);
    });

    it('returns false for <span> with background-color: initial (TipTap export artifact)', () => {
      expect(detectCustomHtmlPatterns('<span style="background-color: initial">stuff</span>')).toBe(false);
    });

    it('returns false for <span> with background-color: transparent (TipTap export artifact)', () => {
      expect(detectCustomHtmlPatterns('<span style="background-color: transparent">stuff</span>')).toBe(false);
    });

    it('returns false for <a> with inline style (TipTap Link output)', () => {
      expect(detectCustomHtmlPatterns('<a href="https://example.com" style="color: red">link</a>')).toBe(false);
    });

    it('returns false for paragraph with inline text-align style', () => {
      expect(detectCustomHtmlPatterns('<p style="text-align: center">centered</p>')).toBe(false);
    });

    it('returns false when an href URL contains "id=" or "contactId=" (must not match custom-attr regex)', () => {
      expect(detectCustomHtmlPatterns('<a href="https://example.com/u?contactId=abc&id=123">unsub</a>')).toBe(false);
    });

    it('returns false for allowed class prefixes', () => {
      expect(detectCustomHtmlPatterns('<p class="prose">x</p>')).toBe(false);
      expect(detectCustomHtmlPatterns('<span class="variable-mention">x</span>')).toBe(false);
      expect(detectCustomHtmlPatterns('<img class="email-image" src="x" />')).toBe(false);
    });

    it('returns false for a TipTap-style colored span wrapped in a paragraph', () => {
      expect(detectCustomHtmlPatterns('<p>Hello <span style="color: rgb(220, 38, 38);">world</span>!</p>')).toBe(false);
    });
  });

  describe('content TipTap can NOT round-trip (should be flagged as custom)', () => {
    it('returns true for <div>', () => {
      expect(detectCustomHtmlPatterns('<div>stuff</div>')).toBe(true);
    });

    it('returns true for <table> markup (no TipTap Table extension loaded)', () => {
      expect(detectCustomHtmlPatterns('<table><tr><td>x</td></tr></table>')).toBe(true);
    });

    it('returns true for a single <table> tag', () => {
      expect(detectCustomHtmlPatterns('<table>x</table>')).toBe(true);
    });

    it('returns true for <style> tag', () => {
      expect(detectCustomHtmlPatterns('<style>p { color: red; }</style>')).toBe(true);
    });

    it('returns true for @media query inside a style block', () => {
      expect(detectCustomHtmlPatterns('@media (max-width: 600px) { ... }')).toBe(true);
    });

    it('returns true for custom data-* attribute', () => {
      expect(detectCustomHtmlPatterns('<p data-foo="bar">x</p>')).toBe(true);
    });

    it('returns true for aria-* attribute', () => {
      expect(detectCustomHtmlPatterns('<p aria-label="x">y</p>')).toBe(true);
    });

    it('returns true for role= attribute', () => {
      expect(detectCustomHtmlPatterns('<p role="presentation">x</p>')).toBe(true);
    });

    it('returns true for id= attribute on an element', () => {
      expect(detectCustomHtmlPatterns('<p id="main">x</p>')).toBe(true);
    });

    it('returns true for a disallowed CSS class', () => {
      expect(detectCustomHtmlPatterns('<p class="custom">x</p>')).toBe(true);
    });

    it('returns true for <section>, <article>, <header>, <footer>, <nav>, <aside>, <main>', () => {
      expect(detectCustomHtmlPatterns('<section>x</section>')).toBe(true);
      expect(detectCustomHtmlPatterns('<article>x</article>')).toBe(true);
      expect(detectCustomHtmlPatterns('<header>x</header>')).toBe(true);
      expect(detectCustomHtmlPatterns('<footer>x</footer>')).toBe(true);
      expect(detectCustomHtmlPatterns('<nav>x</nav>')).toBe(true);
      expect(detectCustomHtmlPatterns('<aside>x</aside>')).toBe(true);
      expect(detectCustomHtmlPatterns('<main>x</main>')).toBe(true);
    });

    it('returns true for form/input/button/iframe/svg', () => {
      expect(detectCustomHtmlPatterns('<form>x</form>')).toBe(true);
      expect(detectCustomHtmlPatterns('<input type="text" />')).toBe(true);
      expect(detectCustomHtmlPatterns('<button>x</button>')).toBe(true);
      expect(detectCustomHtmlPatterns('<iframe src="x"></iframe>')).toBe(true);
      expect(detectCustomHtmlPatterns('<svg><circle /></svg>')).toBe(true);
    });
  });
});

describe('detectCustomHtmlPatterns with a preview text', () => {
  it('still treats visual editor content with a preheader as visual', () => {
    expect(detectCustomHtmlPatterns('<!--plunk:preheader:Hello &amp; welcome--><p>Hello</p>')).toBe(false);
  });
});

describe('detectCustomHtmlPatterns with editor buttons', () => {
  const button = (inner: string, className = 'email-button') =>
    `<p style="text-align: center;"><a class="${className}" href="{{unsubscribeUrl}}" style="display: inline-block; padding: 12px 20px; font-family: 'Helvetica Neue', Arial, sans-serif;">${inner}</a></p>`;

  it('treats an editor button as visual editor content', () => {
    expect(detectCustomHtmlPatterns(button('Shop now'))).toBe(false);
  });

  it('treats look-alike classes as custom, since only the editor button is matched', () => {
    expect(detectCustomHtmlPatterns(button('Shop now', 'email-button-primary'))).toBe(true);
  });

  it('reads a < that is not a tag as text', () => {
    expect(detectCustomHtmlPatterns(button('I <3 this'))).toBe(false);
  });

  it('treats a button with markup inside as custom, since the editor keeps plain labels only', () => {
    expect(detectCustomHtmlPatterns(button('<strong>Shop</strong> now'))).toBe(true);
  });
});

describe('detectCustomHtmlPatterns with editor spacers', () => {
  it('treats an editor spacer as visual editor content', () => {
    expect(
      detectCustomHtmlPatterns(
        '<p>a</p><hr class="email-spacer" style="border-style: none; margin: 0px; height: 32px;">',
      ),
    ).toBe(false);
  });

  it('treats look-alike classes as custom, since only the editor spacer is matched', () => {
    expect(detectCustomHtmlPatterns('<p>a</p><hr class="email-spacer-big" style="height: 32px;">')).toBe(true);
  });
});

describe('detectCustomHtmlPatterns with editor videos', () => {
  const image =
    '<img class="email-image" src="https://files.example.com/youtube-abc.jpg" alt="The video" width="1280" height="720" style="display: block; width: 100%; border-radius: 12px;">';
  const video = (
    inner = image,
    href = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s',
    className = 'email-video',
  ) =>
    `<p style="text-align: center;"><a class="${className}" href="${href}" style="text-decoration: none;">${inner}</a></p>`;

  it('treats an editor video as visual editor content', () => {
    expect(detectCustomHtmlPatterns(video())).toBe(false);
    expect(detectCustomHtmlPatterns(video(image, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(false);
  });

  it('treats look-alike classes as custom, since only the editor video is matched', () => {
    expect(detectCustomHtmlPatterns(video(image, undefined, 'email-video-big'))).toBe(true);
  });

  it.each([
    ['a link that is not a watch page', 'https://example.com/watch?v=dQw4w9WgXcQ'],
    ['a short link', 'https://youtu.be/dQw4w9WgXcQ'],
    ['a Liquid link', '{{videoUrl}}'],
  ])('treats a video with %s as custom', (_, href) => {
    expect(detectCustomHtmlPatterns(video(image, href))).toBe(true);
  });

  it.each([
    ['text besides the image', `${image} Watch now`],
    ['two images', image + image],
    ['no image', 'Watch now'],
    ['an image without a source', '<img class="email-image" alt="x">'],
    ['other markup', `<span>${image}</span>`],
  ])('treats a video with %s as custom, since the editor would drop it', (_, inner) => {
    expect(detectCustomHtmlPatterns(video(inner))).toBe(true);
  });

  it.each([
    ['a second href after a safe one', `href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" href="javascript:alert(1)"`],
    [
      'an unsafe href before a safe one',
      `href='javascript:alert(1)' href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"`,
    ],
    ['a safe href hidden in another attribute', `title=' href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"' href="x"`],
    ['an href in single quotes', `href='https://www.youtube.com/watch?v=dQw4w9WgXcQ'`],
  ])('treats a video with %s as custom, since a browser would follow another link', (_, attributes) => {
    expect(detectCustomHtmlPatterns(`<p><a class="email-video" ${attributes}>${image}</a></p>`)).toBe(true);
  });

  it('goes on checking videos after an unclosed link', () => {
    expect(detectCustomHtmlPatterns(`<p>x <a ${video(`${image} Watch now`)}</p>`)).toBe(true);
  });

  it('reads a long run of videos quickly', () => {
    const html = video().repeat(5_000);
    const started = performance.now();
    expect(detectCustomHtmlPatterns(html)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('visualAttributeText', () => {
  const imageWithAlt = (alt: string) =>
    `<p><img class="email-image" src="https://files.example.com/a.jpg" alt="${alt.replace(/"/g, '&quot;')}"></p>`;

  it.each([
    'How to become data-driven in 2026',
    'Big DATA- explained',
    'Uso de aria-label',
    'Using role=button correctly',
    'Set id = 3 and class="big" or class=\'big\'',
    'Social @Media tips',
  ])('keeps an image with the alt text %s as visual editor content', alt => {
    expect(detectCustomHtmlPatterns(imageWithAlt(alt))).toBe(true);
    expect(detectCustomHtmlPatterns(imageWithAlt(visualAttributeText(alt)))).toBe(false);
  });

  it('reads the same, only without < and > and with runs of spaces folded', () => {
    expect(visualAttributeText('  Me at   the zoo  ')).toBe('Me at the zoo');
    expect(visualAttributeText('I <3 yoga > all')).toBe('I 3 yoga all');
    expect(visualAttributeText('data-driven')).toBe('data\u2011driven');
  });
});

describe('detectCustomHtmlPatterns with editor boxes', () => {
  const box = (
    inner = '<p>Inside</p>',
    attributes = 'class="email-box" style="background-color: #f3f4f6; color: #374151;"',
  ) => `<div ${attributes}>${inner}</div>`;

  it('treats an editor box, inset or full width, as visual editor content', () => {
    expect(detectCustomHtmlPatterns(`<p>a</p>${box()}<p>b</p>`)).toBe(false);
    expect(
      detectCustomHtmlPatterns(
        box(
          '<h2>Title</h2><ul><li><p>One</p></li></ul>',
          'class="email-box email-box-full" style="background-color: #111827; color: #ffffff;"',
        ),
      ),
    ).toBe(false);
    expect(detectCustomHtmlPatterns(box('<p>a</p>', 'class="email-box"'))).toBe(false);
  });

  it.each([
    ['without a class', ''],
    ['with another class', 'class="card"'],
    ['with a look-alike class', 'class="email-box-dark"'],
    ['with its classes the other way round', 'class="email-box-full email-box"'],
    ['in single quotes', "class='email-box'"],
    ['with another attribute', 'class="email-box" title="x"'],
    ['with the style first', 'style="color: #000000;" class="email-box"'],
    ['with a > in its style', 'class="email-box" style="background: url(a>b)"'],
  ])('treats a div %s as custom', (_, attributes) => {
    expect(detectCustomHtmlPatterns(box('<p>a</p>', attributes))).toBe(true);
  });

  it('treats a box inside a box, or any div inside one, as custom', () => {
    expect(detectCustomHtmlPatterns(box(box()))).toBe(true);
    expect(detectCustomHtmlPatterns(box('<div><p>a</p></div>'))).toBe(true);
  });

  it('treats an unclosed div tag, or one in a comment, as custom', () => {
    expect(detectCustomHtmlPatterns('<p>a</p><div class="email-box"')).toBe(true);
    expect(detectCustomHtmlPatterns(`<!-- <div> -->${box()}`)).toBe(true);
  });

  it('reads a long run of boxes quickly', () => {
    const html = box().repeat(5_000);
    const started = performance.now();
    expect(detectCustomHtmlPatterns(html)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

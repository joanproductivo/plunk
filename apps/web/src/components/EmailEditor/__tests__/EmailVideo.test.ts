// @vitest-environment happy-dom
import {detectCustomHtmlPatterns, videoImageStyle, type VideoSize} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import {Link} from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it} from 'vitest';

import {EmailButton} from '../EmailButton';
import {EmailTextAlign} from '../EmailTextAlign';
import {EmailVideo} from '../EmailVideo';
import {ResizableImage} from '../ResizableImage';

/**
 * Parsing and serialising run through the extensions the editor loads, so these pin the HTML a
 * video is saved, previewed and sent with. The video sits between paragraphs because the editor
 * appends an empty one after a trailing block.
 */
const HREF = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=90s';
const SRC = 'https://files.example.com/p/3-0123456789abcdef-youtube-dqw4w9wgxcq.jpg';
const image = (alt = 'Never gonna give you up', size: VideoSize = 'large') =>
  `<img class="email-image" src="${SRC}" alt="${alt}" width="1280" height="720" style="${videoImageStyle(size)}">`;
// A video's poster as the editor saved it before sizes
const SAVED_BEFORE_SIZES = `<img class="email-image" src="${SRC}" alt="Never gonna give you up" width="1280" height="720" style="display: block; width: 100%; height: auto; margin: 0px; border: 0px; border-radius: 12px;">`;
const video = (inner = image(), href = HREF) =>
  `<p style="text-align: center;"><a class="email-video" href="${href}" style="text-decoration: none;">${inner}</a></p>`;

let editor: Editor;

function createEditor(content: string) {
  editor = new Editor({
    extensions: [
      StarterKit.configure({heading: {levels: [1, 2, 3]}}),
      Link,
      EmailTextAlign,
      ResizableImage,
      EmailButton,
      EmailVideo,
    ],
    content,
  });
}

function videoNodes() {
  const nodes: Record<string, unknown>[] = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'video') nodes.push(node.attrs);
  });
  return nodes;
}

// Saving the email and opening it again.
function reopen(html: string) {
  editor.commands.setContent(html);
  return editor.getHTML();
}

afterEach(() => {
  editor.destroy();
});

describe('EmailVideo', () => {
  it('keeps a video exactly as saved, as visual-editor content', () => {
    const html = `<p>a</p>${video()}<p>b</p>`;
    createEditor(html);

    expect(editor.getHTML()).toBe(html);
    expect(detectCustomHtmlPatterns(editor.getHTML())).toBe(false);
    expect(videoNodes()).toEqual([
      {
        src: SRC,
        href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
        alt: 'Never gonna give you up',
        width: 1280,
        height: 720,
        size: 'large',
      },
    ]);
  });

  it.each(['small', 'medium'] as const)('keeps a %s video exactly as saved', size => {
    const html = `<p>a</p>${video(image('Never gonna give you up', size))}<p>b</p>`;
    createEditor(html);

    expect(editor.getHTML()).toBe(html);
    expect(videoNodes()[0]).toMatchObject({size});
  });

  it('reads a video saved before sizes as large, and saves it centred', () => {
    createEditor(`<p>a</p>${video(SAVED_BEFORE_SIZES)}<p>b</p>`);

    expect(videoNodes()[0]).toMatchObject({size: 'large'});
    expect(editor.getHTML()).toBe(`<p>a</p>${video()}<p>b</p>`);
  });

  it('reads a video link outside its paragraph, as pasted, and saves it in one', () => {
    createEditor(`<p>a</p><a class="email-video" href="${HREF}">${image()}</a><p>b</p>`);

    expect(videoNodes()).toHaveLength(1);
    expect(editor.getHTML()).toBe(`<p>a</p>${video()}<p>b</p>`);
  });

  it('inserts a video from its attributes', () => {
    createEditor('<p>a</p>');
    editor.commands.setTextSelection(2);

    // As useBlockDialog inserts a new one
    editor.commands.insertContent({
      type: 'video',
      attrs: {
        src: SRC,
        href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
        alt: 'Never gonna give you up',
        width: 1280,
        height: 720,
        size: 'large',
      },
    });

    expect(editor.getHTML()).toContain(video());
  });

  it.each([
    ['I &lt;3 yoga &gt; all', 'I 3 yoga all'],
    ['How to become data-driven', 'How to become data\u2011driven'],
    ['Social @media tips', 'Social @\u200bmedia tips'],
  ])('keeps the alt text %s from reading as custom HTML', (alt, kept) => {
    createEditor(`<p>a</p>${video(image(alt))}<p>b</p>`);

    expect(videoNodes()[0]).toMatchObject({alt: kept});
    expect(detectCustomHtmlPatterns(editor.getHTML())).toBe(false);
    // And it stays as it is from then on
    expect(reopen(editor.getHTML())).toBe(editor.getHTML());
  });

  it.each([
    ['a link that is not a YouTube watch page', video(image(), 'https://example.com/watch?v=dQw4w9WgXcQ')],
    ['text besides the image', video(`${image()} Watch now`)],
    ['two images', video(image() + image())],
  ])('leaves a video with %s, which reads as custom HTML instead', (_label, html) => {
    createEditor(`<p>a</p>${html}<p>b</p>`);

    expect(videoNodes()).toHaveLength(0);
    expect(detectCustomHtmlPatterns(html)).toBe(true);
  });

  it('is not taken for an ordinary linked image or link', () => {
    createEditor(`<p>See <a href="https://youtu.be/dQw4w9WgXcQ">this</a></p>`);

    expect(videoNodes()).toHaveLength(0);
    expect(editor.getHTML()).toContain('href="https://youtu.be/dQw4w9WgXcQ">this</a>');
  });

  it('is never aligned other than centred', () => {
    createEditor(`<p>a</p>${video()}<p>b</p>`);
    editor.commands.setNodeSelection(3);

    expect(editor.commands.setTextAlign('right')).toBe(false);
    expect(editor.getHTML()).toBe(`<p>a</p>${video()}<p>b</p>`);
  });
});

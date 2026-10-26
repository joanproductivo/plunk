// @vitest-environment happy-dom
import {BUTTON_DEFAULTS, buttonStyle, type ButtonStyle, detectCustomHtmlPatterns} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import {Link} from '@tiptap/extension-link';
import {NodeSelection} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it} from 'vitest';

import {EmailButton} from '../EmailButton';
import {EmailTextAlign} from '../EmailTextAlign';

/**
 * Parsing and serialising run through the extensions the editor loads, so these pin the HTML a
 * button is saved, previewed and sent with. The button sits between paragraphs because the
 * editor appends an empty one after a trailing block.
 */
const RED: ButtonStyle = {...BUTTON_DEFAULTS, backgroundColor: '#e11d48'};
const link = (style: ButtonStyle, text = 'Shop now', href = 'https://example.com') =>
  `<a class="email-button" href="${href}" style="${buttonStyle(style)}">${text}</a>`;
const LEFT = `<p>${link(RED)}</p>`;
const CENTERED = `<p style="text-align: center;">${link(RED)}</p>`;

let editor: Editor;

function createEditor(content: string) {
  editor = new Editor({
    extensions: [StarterKit.configure({heading: {levels: [1, 2, 3]}}), Link, EmailTextAlign, EmailButton],
    content,
  });
}

function buttonNodes() {
  const nodes: Record<string, unknown>[] = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'button') nodes.push(node.attrs);
  });
  return nodes;
}

function selectButton() {
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'button') position = pos;
  });
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)));
}

// Saving the email and opening it again.
function reopen(html: string) {
  editor.commands.setContent(html);
  return editor.getHTML();
}

afterEach(() => {
  editor.destroy();
});

describe('EmailButton', () => {
  it.each([
    ['left', LEFT],
    ['centred', CENTERED],
    ['right-aligned', `<p style="text-align: right;">${link(RED)}</p>`],
  ])('keeps a %s button exactly as saved, as visual-editor content', (_label, html) => {
    createEditor(`<p>a</p>${html}<p>b</p>`);

    expect(editor.getHTML()).toBe(`<p>a</p>${html}<p>b</p>`);
    expect(detectCustomHtmlPatterns(editor.getHTML())).toBe(false);
  });

  it('keeps its colours when the browser reports them as rgb()', () => {
    createEditor(
      '<p><a class="email-button" href="https://example.com" style="background-color: rgb(225, 29, 72); color: rgb(255, 255, 255); padding: 16px 32px; border-radius: 999px">Go</a></p>',
    );

    expect(buttonNodes()[0]).toMatchObject({
      backgroundColor: '#e11d48',
      textColor: '#ffffff',
      size: 'large',
      shape: 'pill',
    });
  });

  it('is not taken for an ordinary link, and leaves ordinary links alone', () => {
    createEditor(`<p>See <a href="https://a.com">this</a></p>${LEFT}`);

    expect(buttonNodes()).toHaveLength(1);
    expect(editor.getHTML()).toContain(
      '<a target="_blank" rel="noopener noreferrer nofollow" href="https://a.com">this</a>',
    );
  });

  it('keeps Liquid in its text and link', () => {
    const html = `<p>a</p><p>${link(RED, 'Hi {{name ?? "you"}}', '{{unsubscribeUrl}}')}</p><p>b</p>`;
    createEditor(html);

    expect(reopen(editor.getHTML())).toBe(html);
    expect(buttonNodes()[0]).toMatchObject({text: 'Hi {{name ?? "you"}}', href: '{{unsubscribeUrl}}'});
  });

  it('drops a javascript: link', () => {
    createEditor(`<p>${link(RED, 'Go', 'javascript:alert(1)')}</p>`);

    expect(buttonNodes()[0]).toMatchObject({href: ''});
    expect(editor.getHTML()).not.toContain('javascript');
  });

  it('takes a button out of a paragraph with text of its own, as ProseMirror splits it', () => {
    createEditor(`<p style="text-align: center">Hi ${link(RED)} there</p>`);

    expect(buttonNodes()).toHaveLength(1);
    expect(editor.getHTML()).toContain('<p style="text-align: center;">Hi</p>');
  });

  it('leaves a button with markup inside, which reads as custom HTML instead', () => {
    const html = `<p><a class="email-button" href="https://example.com" style="${buttonStyle(RED)}"><strong>Go</strong></a></p>`;
    createEditor(html);

    expect(buttonNodes()).toHaveLength(0);
    expect(detectCustomHtmlPatterns(html)).toBe(true);
  });

  it('aligns a selected button with the alignment commands, but never justifies it', () => {
    createEditor(`<p>a</p>${LEFT}<p>b</p>`);
    selectButton();

    expect(editor.commands.setTextAlign('center')).toBe(true);
    expect(editor.getHTML()).toBe(`<p>a</p>${CENTERED}<p>b</p>`);
    expect(editor.isActive({textAlign: 'center'})).toBe(true);

    expect(editor.commands.setTextAlign('justify')).toBe(false);
    editor.commands.setTextAlign('left');
    expect(editor.getHTML()).toBe(`<p>a</p>${LEFT}<p>b</p>`);
  });

  it('inserts a button from its options', () => {
    createEditor('<p>a</p>');
    editor.commands.setTextSelection(2);

    // As useBlockDialog inserts a new one
    editor.commands.insertContent({type: 'button', attrs: {...RED, text: 'Shop now', href: 'https://example.com'}});

    expect(editor.getHTML()).toContain(LEFT);
  });
});

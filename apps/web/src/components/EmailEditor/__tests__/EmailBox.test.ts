// @vitest-environment happy-dom
import {BOX_DEFAULTS, detectCustomHtmlPatterns} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import {Link} from '@tiptap/extension-link';
import {TextSelection} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it} from 'vitest';

import {boxAtSelection, unwrapBox, updateBox, wrapInBox} from '../boxCommands';
import {EmailBox, EmailDocument} from '../EmailBox';
import {EmailButton} from '../EmailButton';
import {EmailDivider} from '../EmailDivider';
import {EmailSpacer} from '../EmailSpacer';
import {EmailTextAlign} from '../EmailTextAlign';
import {EmailVideo} from '../EmailVideo';
import {ResizableImage} from '../ResizableImage';
import {insertBlockAfterSelection} from '../useBlockDialog';

/**
 * Parsing, serialising and the box's commands run through the extensions the editor loads, so
 * these pin the HTML a box is saved with and that editing never nests, splits or drops one.
 */
const DARK = {backgroundColor: '#111827', textColor: '#ffffff', fullWidth: false};
const box = (inner: string, className = 'email-box', style = 'background-color: #111827; color: #ffffff;') =>
  `<div class="${className}" style="${style}">${inner}</div>`;

let editor: Editor;

function createEditor(content: string) {
  editor = new Editor({
    extensions: [
      StarterKit.configure({document: false, heading: {levels: [1, 2, 3]}}),
      EmailDocument,
      Link,
      EmailTextAlign,
      ResizableImage,
      EmailButton,
      EmailDivider,
      EmailSpacer,
      EmailVideo,
      EmailBox,
    ],
    content,
  });
}

// The cursor at the start of the first text matching `text`
function placeCursorIn(text: string, offset = 0) {
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (position < 0 && node.isText && node.text!.includes(text)) position = pos + node.text!.indexOf(text) + offset;
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
}

function boxes() {
  const found: Record<string, unknown>[] = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'box') found.push(node.attrs);
  });
  return found;
}

function pressEnter() {
  editor.view.someProp('handleKeyDown', handle => handle(editor.view, new KeyboardEvent('keydown', {key: 'Enter'})));
}

afterEach(() => {
  editor.destroy();
});

describe('EmailBox', () => {
  it.each([
    ['inset', box('<h2>Title</h2><p>Text</p>')],
    ['full-width', box('<p>Text</p><ul><li><p>One</p></li></ul>', 'email-box email-box-full')],
  ])('keeps an %s box exactly as saved, as visual-editor content', (_, html) => {
    createEditor(`<p>a</p>${html}<p>b</p>`);

    expect(editor.getHTML()).toBe(`<p>a</p>${html}<p>b</p>`);
    expect(detectCustomHtmlPatterns(editor.getHTML())).toBe(false);
  });

  it('reads colours as a browser reports them, and anything else as the defaults', () => {
    createEditor(box('<p>a</p>', 'email-box', 'background-color: rgb(17, 24, 39); color: url(x)'));

    expect(boxes()).toEqual([{backgroundColor: '#111827', textColor: BOX_DEFAULTS.textColor, fullWidth: false}]);
  });

  it('keeps buttons, images, videos, dividers and spacers inside a box', () => {
    const inner =
      '<p style="text-align: center;"><a class="email-button" href="https://a.com" style="display: inline-block;">Go</a></p>' +
      '<hr>' +
      '<p><img src="https://x.example/a.png" class="email-image"></p>';
    createEditor(box(inner));

    expect(editor.getHTML()).toContain('<div class="email-box"');
    expect(editor.getHTML()).toContain('class="email-button"');
    expect(editor.getHTML()).toContain('<hr');
    expect(editor.getHTML()).toContain('<img');
  });

  describe('never nests', () => {
    it('reads a box inside a box as boxes side by side, keeping what each held', () => {
      createEditor(box(`<p>outer</p>${box('<p>inner</p>')}`));

      editor.state.doc.descendants((node, _pos, parent) => {
        if (node.type.name === 'box') expect(parent?.type.name).toBe('doc');
      });
      expect(editor.getHTML()).toContain('outer');
      expect(editor.getHTML()).toContain('inner');
    });

    it.each([
      ['a quote', `<blockquote>${box('<p>inside</p>')}</blockquote>`],
      ['a list', `<ul><li><p>one</p>${box('<p>inside</p>')}</li></ul>`],
    ])('keeps boxes out of %s', (_, html) => {
      createEditor(html);

      editor.state.doc.descendants((node, _pos, parent) => {
        if (node.type.name === 'box') expect(parent?.type.name).toBe('doc');
      });
      expect(editor.getHTML()).toContain('inside');
    });

    it('wraps nothing from inside a box', () => {
      createEditor(box('<p>inside</p>'));
      placeCursorIn('inside');

      expect(editor.commands.command(wrapInBox(DARK))).toBe(false);
      expect(boxes()).toHaveLength(1);
    });
  });

  describe('wrapInBox', () => {
    it('wraps the paragraph the cursor is in', () => {
      createEditor('<p>a</p><p>b</p>');
      placeCursorIn('b');

      expect(editor.commands.command(wrapInBox(DARK))).toBe(true);
      expect(editor.getHTML()).toBe(`<p>a</p>${box('<p>b</p>')}<p></p>`);
    });

    it('wraps a whole list from inside one of its items', () => {
      createEditor('<p>a</p><ul><li><p>one</p></li><li><p>two</p></li></ul>');
      placeCursorIn('two');

      editor.commands.command(wrapInBox(DARK));

      expect(editor.getHTML()).toBe(`<p>a</p>${box('<ul><li><p>one</p></li><li><p>two</p></li></ul>')}<p></p>`);
    });

    it('wraps every top-level block a selection touches, in one box', () => {
      createEditor('<p>first</p><blockquote><p>quote</p></blockquote><p>last</p>');
      editor.commands.setTextSelection({from: 2, to: editor.state.doc.content.size - 2});

      editor.commands.command(wrapInBox(DARK));

      expect(editor.getHTML()).toBe(`${box('<p>first</p><blockquote><p>quote</p></blockquote><p>last</p>')}<p></p>`);
    });
  });

  it('removes a box from inside any of its blocks, keeping them all, whole and in order', () => {
    createEditor(`<p>a</p>${box('<p>one</p><ul><li><p>two</p></li></ul><p>three</p>')}<p>b</p>`);
    placeCursorIn('two');

    editor.commands.command(unwrapBox(boxAtSelection(editor)!));

    expect(editor.getHTML()).toBe('<p>a</p><p>one</p><ul><li><p>two</p></li></ul><p>three</p><p>b</p>');
  });

  it('updates a box from inside it, leaving the cursor in the text', () => {
    createEditor(box('<p>inside</p>'));
    placeCursorIn('inside', 2);

    editor.commands.command(updateBox(boxAtSelection(editor)!, {...DARK, fullWidth: true}));

    expect(editor.getHTML()).toBe(`${box('<p>inside</p>', 'email-box email-box-full')}<p></p>`);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.from).toBe(4);
  });

  describe('Enter', () => {
    it('in the empty last paragraph of a box, moves out after it', () => {
      createEditor(`${box('<p>one</p><p></p>')}<p>after</p>`);
      editor.commands.setTextSelection(7);

      pressEnter();

      expect(editor.getHTML()).toBe(`${box('<p>one</p>')}<p></p><p>after</p>`);
      expect(boxAtSelection(editor)).toBeNull();
    });

    it('in an empty paragraph in the middle of a box, adds a paragraph without splitting the box', () => {
      createEditor(box('<p>one</p><p></p><p>two</p>'));
      editor.commands.setTextSelection(7);

      pressEnter();

      expect(boxes()).toHaveLength(1);
      expect(editor.getHTML()).toBe(`${box('<p>one</p><p></p><p></p><p>two</p>')}<p></p>`);
    });

    it('in the only, empty paragraph of a box, keeps the box and moves into the paragraph after it', () => {
      // The editor keeps an empty paragraph after a box that ends the email
      createEditor(box('<p></p>'));
      editor.commands.setTextSelection(2);

      pressEnter();

      expect(editor.getHTML()).toBe(`${box('<p></p>')}<p></p>`);
      expect(boxAtSelection(editor)).toBeNull();
    });
  });

  it('inserts blocks inside a box, and aligns its text', () => {
    createEditor(box('<p>inside</p>'));
    placeCursorIn('inside', 6);

    editor.commands.command(insertBlockAfterSelection('spacer'));
    placeCursorIn('inside');
    editor.commands.setTextAlign('center');

    expect(boxes()).toHaveLength(1);
    expect(editor.getHTML()).toMatch(
      /^<div class="email-box"[^>]*><p style="text-align: center;">inside<\/p><hr class="email-spacer"[^>]*><p><\/p><\/div>/,
    );
  });
});

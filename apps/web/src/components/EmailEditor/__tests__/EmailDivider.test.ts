// @vitest-environment happy-dom
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it} from 'vitest';

import {detectCustomHtmlPatterns} from '../../../lib/emailStyles';
import {DIVIDER_DEFAULTS, type DividerAttrs, dividerStyle, EmailDivider} from '../EmailDivider';

/**
 * Parsing and serialising run through the extensions the editor loads, so these pin the HTML a
 * divider is saved, previewed and sent with.
 */
const RED_THICK: DividerAttrs = {color: '#e11d48', thickness: 'thick', spacing: 'small'};

let editor: Editor;

function createEditor(content: string) {
  editor = new Editor({extensions: [StarterKit, EmailDivider], content});
  return editor;
}

function dividerAttrs(): DividerAttrs {
  let attrs: DividerAttrs | undefined;
  editor.state.doc.descendants(node => {
    if (node.type.name === 'horizontalRule') attrs = node.attrs as DividerAttrs;
  });
  return attrs!;
}

afterEach(() => editor?.destroy());

describe('dividerStyle', () => {
  it('leaves the default look as a plain <hr>', () => {
    expect(dividerStyle(DIVIDER_DEFAULTS)).toBeNull();
  });

  it('writes longhands with explicit units, and a margin only for a set spacing', () => {
    expect(dividerStyle(RED_THICK)).toBe(
      'border-width: 4px 0px 0px; border-style: solid; border-color: #e11d48; margin: 16px 0px;',
    );
    expect(dividerStyle({...DIVIDER_DEFAULTS, thickness: 'medium'})).toBe(
      'border-width: 2px 0px 0px; border-style: solid; border-color: #e5e7eb;',
    );
  });
});

describe('EmailDivider', () => {
  it('keeps a plain <hr> plain', () => {
    createEditor('<p>a</p><hr><p>b</p>');

    expect(dividerAttrs()).toEqual(DIVIDER_DEFAULTS);
    expect(editor.getHTML()).toBe('<p>a</p><hr><p>b</p>');
  });

  it('reads back the style it saves', () => {
    createEditor(`<p>a</p><hr style="${dividerStyle(RED_THICK)}"><p>b</p>`);

    expect(dividerAttrs()).toEqual(RED_THICK);
    const saved = editor.getHTML();
    expect(saved).toContain('border-width: 4px 0px 0px; border-style: solid;');
    expect(saved).toContain('margin: 16px 0px;');

    createEditor(saved);
    expect(dividerAttrs()).toEqual(RED_THICK);
  });

  it('reads the style as Chromium saves it, and a hand-written border-top', () => {
    createEditor(
      '<hr style="border-width: 4px medium medium; border-style: solid none none; border-color: rgb(225, 29, 72) currentcolor currentcolor; border-image: none; margin: 16px 0px;">',
    );
    expect(dividerAttrs()).toEqual(RED_THICK);

    createEditor('<hr style="border: none; border-top: 2px solid #e11d48; margin: 24px 0;">');
    expect(dividerAttrs()).toEqual({color: '#e11d48', thickness: 'medium', spacing: 'medium'});
  });

  it('falls back to the defaults for what it cannot tell', () => {
    createEditor('<hr style="border-top: 5px solid red; margin: 3em 0;">');

    expect(dividerAttrs()).toEqual({color: DIVIDER_DEFAULTS.color, thickness: 'thick', spacing: 'large'});
  });

  it('goes back to a plain <hr> when its options are reset', () => {
    createEditor(`<hr style="${dividerStyle(RED_THICK)}">`);

    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes('horizontalRule', DIVIDER_DEFAULTS);

    expect(editor.getHTML()).toMatch(/^<hr>/);
  });

  it('is inserted after the selection, not in its place', () => {
    createEditor('<p>hello world</p>');
    editor.commands.setTextSelection({from: 1, to: 6});

    // As useBlockDialog inserts a divider from the toolbar
    editor.chain().focus().setTextSelection(editor.state.selection.to).setHorizontalRule().run();

    expect(editor.getHTML()).toBe('<p>hello</p><hr><p> world</p>');
    expect(editor.state.selection.empty).toBe(true);
  });

  it('is visual editor content, not custom HTML', () => {
    expect(detectCustomHtmlPatterns(`<p>a</p><hr style="${dividerStyle(RED_THICK)}">`)).toBe(false);
  });
});

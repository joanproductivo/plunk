// @vitest-environment happy-dom
import {spacerStyle} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it} from 'vitest';

import {EmailDivider} from '../EmailDivider';
import {EmailSpacer} from '../EmailSpacer';
import {continueAfterBlock} from '../useBlockDialog';

/**
 * Parsing and serialising run through the extensions the editor loads, so these pin the HTML a
 * spacer is saved, previewed and sent with.
 */
const spacer = (height: number) => `<hr class="email-spacer" style="${spacerStyle(height)}">`;

let editor: Editor;

function createEditor(content: string) {
  editor = new Editor({extensions: [StarterKit, EmailDivider, EmailSpacer], content});
  return editor;
}

// As useBlockDialog inserts a spacer from the toolbar
function insertSpacer() {
  editor
    .chain()
    .focus()
    .setTextSelection(editor.state.selection.to)
    .insertContent({type: 'spacer'})
    .command(continueAfterBlock)
    .run();
}

afterEach(() => editor?.destroy());

describe('EmailSpacer', () => {
  it('reads back the style it saves, ahead of the horizontal rule', () => {
    createEditor(`<p>a</p>${spacer(48)}<p>b</p>`);

    expect(editor.state.doc.child(1).type.name).toBe('spacer');
    expect(editor.state.doc.child(1).attrs.height).toBe(48);
    expect(editor.getHTML()).toBe(`<p>a</p>${spacer(48)}<p>b</p>`);
  });

  it('reads the style as Chromium saves it, and keeps a hand-written height', () => {
    createEditor(
      '<hr class="email-spacer" style="border-width: medium; border-style: none; border-color: currentcolor; border-image: none; margin: 0px; height: 64px;"><hr class="email-spacer" style="height: 100px">',
    );

    expect(editor.state.doc.child(0).attrs.height).toBe(64);
    expect(editor.state.doc.child(1).attrs.height).toBe(100);
  });

  it('leaves look-alike classes to the horizontal rule', () => {
    createEditor('<hr class="email-spacer-big">');

    expect(editor.state.doc.child(0).type.name).toBe('horizontalRule');
  });

  it('is inserted after the selection, not in its place, and leaves the cursor in the text after it', () => {
    createEditor('<p>hello world</p>');
    editor.commands.setTextSelection({from: 1, to: 6});

    insertSpacer();

    expect(editor.getHTML()).toBe(`<p>hello</p>${spacer(32)}<p> world</p>`);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe(' world');
  });

  it('leaves the cursor in a new paragraph when nothing can take text after it', () => {
    createEditor(`<p>hello</p>${spacer(16)}`);
    editor.commands.setTextSelection(6);

    insertSpacer();
    editor.commands.insertContent('typed');

    // The editor keeps an empty paragraph after a trailing block
    expect(editor.getHTML()).toBe(`<p>hello</p>${spacer(32)}<p>typed</p>${spacer(16)}<p></p>`);
  });

  it('keeps an existing block when a divider is inserted before it', () => {
    createEditor(`<p>hello</p>${spacer(16)}`);
    editor.commands.setTextSelection(6);

    editor
      .chain()
      .focus()
      .setTextSelection(editor.state.selection.to)
      .setHorizontalRule()
      .command(continueAfterBlock)
      .run();
    editor.commands.insertContent('typed');

    expect(editor.getHTML()).toContain(spacer(16));
    expect(editor.getHTML()).toContain('typed');
  });
});

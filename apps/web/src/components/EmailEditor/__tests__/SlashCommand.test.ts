// @vitest-environment happy-dom
import {spacerStyle} from '@plunk/shared';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {EmailButton} from '../EmailButton';
import {EmailDivider} from '../EmailDivider';
import {EmailSpacer} from '../EmailSpacer';
import {LogicMention} from '../LogicMention';
import {SlashCommand, slashItems} from '../SlashCommand';
import {subscribeSuggestionOpen} from '../suggestionPopup';
import {VariableMention} from '../VariableMention';

/**
 * The menu as the editor loads it, with the `{{` and `{%` menus alongside, driven the way an
 * author does: typing, then a key.
 */
let editor: Editor;
let images = true;

function createEditor(content: string) {
  // Destroying an editor closes its open menu, as leaving the page does
  editor?.destroy();
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit,
      EmailButton,
      EmailDivider,
      EmailSpacer,
      VariableMention,
      LogicMention,
      SlashCommand.configure({canInsertImages: () => images}),
    ],
    content,
  });
  editor.commands.focus('end');
  return editor;
}

// As typing does: input rules and suggestion triggers first, then the character itself
function type(text: string) {
  const view = editor.view;
  for (const char of text) {
    const {from, to} = view.state.selection;
    const handled = view.someProp('handleTextInput', handle =>
      handle(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

function press(key: string): boolean {
  const event = new KeyboardEvent('keydown', {key});
  return Boolean(editor.view.someProp('handleKeyDown', handle => handle(editor.view, event)));
}

// Suggestion items resolve asynchronously
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Whether a suggestion menu is open, as the editor's Liquid check sees it
let menuOpen = false;
subscribeSuggestionOpen(open => (menuOpen = open));

async function pick(query: string) {
  type(`/${query}`);
  await tick();
  expect(menuOpen).toBe(true);
  press('Enter');
}

const labels = (query = '') => slashItems(editor, query, {canInsertImages: () => images}).map(item => item.label);

afterEach(() => {
  editor?.destroy();
  images = true;
});

describe('slashItems', () => {
  it('offers headings, lists, quote, blocks, variables and logic in a paragraph', () => {
    createEditor('<p></p>');

    expect(labels()).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'Quote',
      'Button',
      'Image',
      'Divider',
      'Spacer',
      'Variable',
      'Show or hide content',
    ]);
  });

  it('finds rows by their aliases, with names that start with the query first', () => {
    createEditor('<p></p>');

    expect(labels('line')).toEqual(['Divider']);
    // Names or aliases starting with "h" first ("hr"), then any containing it ("photo", "show or hide")
    expect(labels('h')).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Divider', 'Image', 'Show or hide content']);
    expect(labels('zzz')).toEqual([]);
  });

  it('only offers rows that apply where it is opened', () => {
    createEditor('<ul><li><p>a</p></li></ul>');
    expect(labels()).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Numbered list',
      'Quote',
      'Variable',
      'Show or hide content',
    ]);

    createEditor('<h2>a</h2>');
    expect(labels()).toContain('Text');

    images = false;
    createEditor('<p></p>');
    expect(labels()).not.toContain('Image');
  });
});

describe('SlashCommand', () => {
  it('turns an empty line into a divider or spacer, leaving no empty line above', async () => {
    createEditor('<p>a</p><p></p>');
    await pick('div');
    type('X');
    expect(editor.getHTML()).toBe('<p>a</p><hr><p>X</p>');

    createEditor('<p>a</p><p></p>');
    await pick('spa');
    expect(editor.getHTML()).toBe(`<p>a</p><hr class="email-spacer" style="${spacerStyle(32)}"><p></p>`);
  });

  it('adds a block after the text the slash follows', async () => {
    createEditor('<p></p>');
    type('Hello ');
    await pick('divider');

    expect(editor.getHTML()).toBe('<p>Hello </p><hr><p></p>');
  });

  it('turns the line into a heading, list or quote', async () => {
    createEditor('<p></p>');
    type('Hello ');
    await pick('h2');
    // The editor keeps an empty paragraph after a trailing heading
    expect(editor.getHTML()).toBe('<h2>Hello </h2><p></p>');

    await pick('text');
    expect(editor.getHTML()).toBe('<p>Hello </p><p></p>');

    await pick('bul');
    expect(editor.getHTML()).toBe('<ul><li><p>Hello </p></li></ul><p></p>');

    createEditor('<p></p>');
    type('Hello ');
    await pick('quote');
    expect(editor.getHTML()).toBe('<blockquote><p>Hello </p></blockquote><p></p>');
  });

  it('brings the /query back on undo, however fast the row was picked', async () => {
    createEditor('<p></p>');
    type('Hello ');
    await pick('div');

    editor.commands.undo();

    expect(editor.getHTML()).toBe('<p>Hello /div</p>');
  });

  it('asks the editor component for the blocks that need a dialog', async () => {
    createEditor('<p></p>');
    const asked = vi.fn();
    editor.on('newBlock', asked);

    await pick('button');
    await pick('image');

    expect(asked.mock.calls.map(([event]) => event.type)).toEqual(['button', 'image']);
    expect(editor.getHTML()).toBe('<p></p>');
  });

  it('hands over to the {{ and {% menus by writing their trigger', async () => {
    createEditor('<p></p>');
    await pick('variable');
    await tick();
    expect(editor.getText()).toBe('{{');
    expect(menuOpen).toBe(true);

    createEditor('<p></p>');
    await pick('if');
    await tick();
    expect(editor.getText()).toBe('{%');
    expect(menuOpen).toBe(true);
  });

  it('opens after a space, a non-breaking space or at the start, and not inside a word, a URL or code', async () => {
    const opens = async (content: string, typed: string) => {
      createEditor(content);
      type(typed);
      await tick();
      return menuOpen;
    };

    expect(await opens('<p></p>', '/')).toBe(true);
    expect(await opens('<p>a</p>', ' /')).toBe(true);
    expect(await opens('<p>a&nbsp;</p>', '/')).toBe(true);
    expect(await opens('<p>and</p>', '/')).toBe(false);
    expect(await opens('<p>see https:</p>', '//')).toBe(false);
    expect(await opens('<pre><code>a</code></pre>', ' /')).toBe(false);
  });

  it('leaves Enter to the editor when nothing matches', async () => {
    createEditor('<p></p>');
    type('10 /month');
    await tick();

    press('Enter');

    expect(editor.getHTML()).toBe('<p>10 /month</p><p></p>');
  });
});

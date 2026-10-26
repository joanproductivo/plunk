import {type ChainedCommands, type Editor, Extension, type Range} from '@tiptap/core';
import {closeHistory} from '@tiptap/pm/history';
import {type EditorState, PluginKey} from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';

import {createSuggestionRenderer, SuggestionMenu, type SuggestionRow} from './suggestionPopup';
import {insertBlockAfterSelection} from './useBlockDialog';

export interface SlashCommandOptions {
  /** Whether images can be added; read each time the menu opens, as the config loads late. */
  canInsertImages: () => boolean;
}

export interface SlashItem extends SuggestionRow {
  /** Other words the row is found by. */
  aliases: string[];
  /** Whether the row applies where the menu was opened. */
  offered: (editor: Editor, options: SlashCommandOptions) => boolean;
  run: (editor: Editor, range: Range) => void;
}

// The menu's own key: the `{%` menu already has Suggestion's default one.
const SLASH_KEY = new PluginKey('slashCommand');

/**
 * The start of every row's command: removes the `/query`, after closing the undo group so that
 * undoing brings it back, however fast the row was picked.
 */
function replaceQuery(editor: Editor, range: Range): ChainedCommands {
  return editor
    .chain()
    .focus()
    .command(({tr}) => {
      closeHistory(tr);
      return true;
    })
    .deleteRange(range);
}

// Blocks would land inside a list item or a quote, so they are only offered outside them.
const takesBlocks = (editor: Editor) =>
  !editor.isActive('bulletList') && !editor.isActive('orderedList') && !editor.isActive('blockquote');

const always = () => true;

function heading(level: 1 | 2 | 3): SlashItem {
  return {
    label: `Heading ${level}`,
    syntax: `${'#'.repeat(level)}␣`,
    aliases: ['title', `h${level}`],
    offered: always,
    run: (editor, range) => replaceQuery(editor, range).setHeading({level}).run(),
  };
}

// Rows whose block needs a dialog of the editor component (see useBlockDialog and EmailEditor).
function opensDialog(type: string) {
  return (editor: Editor, range: Range) => {
    replaceQuery(editor, range).run();
    editor.emit('newBlock', {type});
  };
}

function block(type: string) {
  return (editor: Editor, range: Range) => replaceQuery(editor, range).command(insertBlockAfterSelection(type)).run();
}

/** Every row, in menu order. Shortcuts show `␣` where Markdown wants a space. */
export const SLASH_ITEMS: SlashItem[] = [
  heading(1),
  heading(2),
  heading(3),
  {
    label: 'Bulleted list',
    syntax: '-␣',
    aliases: ['ul', 'bullet'],
    offered: editor => !editor.isActive('bulletList'),
    run: (editor, range) => replaceQuery(editor, range).toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    syntax: '1.␣',
    aliases: ['ol'],
    offered: editor => !editor.isActive('orderedList'),
    run: (editor, range) => replaceQuery(editor, range).toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    syntax: '>␣',
    aliases: ['blockquote'],
    offered: editor => !editor.isActive('blockquote'),
    run: (editor, range) => replaceQuery(editor, range).toggleBlockquote().run(),
  },
  {label: 'Button', aliases: ['cta', 'link'], offered: takesBlocks, run: opensDialog('button')},
  {
    label: 'Image',
    aliases: ['picture', 'photo'],
    offered: (editor, options) => takesBlocks(editor) && options.canInsertImages(),
    run: opensDialog('image'),
  },
  {
    label: 'Divider',
    syntax: '---',
    aliases: ['line', 'separator', 'rule', 'hr'],
    offered: takesBlocks,
    run: block('horizontalRule'),
  },
  {label: 'Spacer', aliases: ['space', 'gap'], offered: takesBlocks, run: block('spacer')},
  // Writing a trigger opens its own menu, as if typed
  {
    label: 'Variable',
    syntax: '{{',
    aliases: ['field', 'name'],
    offered: always,
    run: (editor, range) => replaceQuery(editor, range).insertContent('{{').run(),
  },
  {
    label: 'Show or hide content',
    syntax: '{%',
    aliases: ['if', 'logic', 'condition'],
    offered: always,
    run: (editor, range) => replaceQuery(editor, range).insertContent('{%').run(),
  },
  // Back from a heading; in a paragraph it would do nothing, and in a list it would leave the list
  {
    label: 'Text',
    aliases: ['paragraph'],
    offered: editor => editor.isActive('heading'),
    run: (editor, range) => replaceQuery(editor, range).setParagraph().run(),
  },
];

/** The rows offered where the menu is open, those whose name starts with the query first. */
export function slashItems(editor: Editor, query: string, options: SlashCommandOptions): SlashItem[] {
  const offered = SLASH_ITEMS.filter(item => item.offered(editor, options));
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) {
    return offered;
  }

  const names = (item: SlashItem) => [item.label.toLowerCase(), ...item.aliases];
  const starting = offered.filter(item => names(item).some(name => name.startsWith(lowerQuery)));
  const containing = offered.filter(
    item => !starting.includes(item) && names(item).some(name => name.includes(lowerQuery)),
  );
  return [...starting, ...containing];
}

// Not inside code, where a slash is code.
function outsideCode(state: EditorState, range: Range): boolean {
  if (state.doc.resolve(range.from).parent.type.spec.code) return false;
  const code = state.schema.marks.code;
  return !code || !state.doc.rangeHasMark(range.from, range.to, code);
}

/**
 * Typing `/` at the start of a line or after a space opens a menu of blocks to insert or turn the
 * line into, filtered by what follows. It shares the popup and keys of the `{{` and `{%` menus,
 * and hands over to them for variables and logic.
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {canInsertImages: () => true};
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: SLASH_KEY,
        char: '/',
        // Pasted and imported HTML often has a non-breaking space where a space would be
        allowedPrefixes: [' ', ' '],
        allow: ({state, range}) => outsideCode(state, range),
        items: ({editor, query}) => slashItems(editor, query, options),
        command: ({editor, range, props}) => props.run(editor, range),
        render: createSuggestionRenderer(props => new SuggestionMenu<SlashItem>(props, 'No matching block')),
      }),
    ];
  },
});

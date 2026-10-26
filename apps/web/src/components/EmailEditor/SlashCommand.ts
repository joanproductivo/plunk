import {type ChainedCommands, type Editor, Extension, type Range} from '@tiptap/core';
import {closeHistory} from '@tiptap/pm/history';
import {type EditorState, PluginKey} from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';

import {createSuggestionRenderer, SuggestionMenu, type SuggestionRow} from './suggestionPopup';
import {insertBlockAfterSelection} from './useBlockDialog';

export interface SlashCommandOptions {
  /** Whether images can be added; read as the menu updates, since the config loads late. */
  canInsertImages: () => boolean;
}

interface SlashItem extends SuggestionRow {
  /** Other words the row is found by. */
  aliases: string[];
  /** Whether the row applies where the menu was opened. */
  offered: (editor: Editor, options: SlashCommandOptions) => boolean;
  run: (editor: Editor, range: Range) => void;
}

/** The menu's own key: the `{%` menu already has Suggestion's default one. */
export const SlashCommandPluginKey = new PluginKey('slashCommand');

/** Shown where Markdown wants a space after a shortcut. */
const SPACE = '\u2423';

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

/**
 * Inside a list or a quote only rows that change text are offered: a block would land inside the
 * item or the quote, and turning an item into a heading or quote would take it out of the list.
 */
const inList = (editor: Editor) => editor.isActive('bulletList') || editor.isActive('orderedList');
const takesBlocks = (editor: Editor) => !inList(editor) && !editor.isActive('blockquote');

const always = () => true;

function heading(level: 1 | 2 | 3): SlashItem {
  return {
    label: `Heading ${level}`,
    syntax: `${'#'.repeat(level)}${SPACE}`,
    aliases: ['title', `h${level}`],
    offered: editor => !inList(editor) && !editor.isActive('heading', {level}),
    run: (editor, range) => replaceQuery(editor, range).setHeading({level}).run(),
  };
}

/** Rows whose block needs a dialog of the editor component (see useBlockDialog and EmailEditor). */
function opensDialog(type: string) {
  return (editor: Editor, range: Range) => {
    replaceQuery(editor, range).run();
    editor.emit('newBlock', {type});
  };
}

function block(type: string) {
  return (editor: Editor, range: Range) => replaceQuery(editor, range).command(insertBlockAfterSelection(type)).run();
}

/** Every row, in menu order. */
const SLASH_ITEMS: SlashItem[] = [
  heading(1),
  heading(2),
  heading(3),
  {
    label: 'Bulleted list',
    syntax: `-${SPACE}`,
    aliases: ['ul', 'bullet'],
    offered: editor => !editor.isActive('bulletList'),
    run: (editor, range) => replaceQuery(editor, range).toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    syntax: `1.${SPACE}`,
    aliases: ['ol'],
    offered: editor => !editor.isActive('orderedList'),
    run: (editor, range) => replaceQuery(editor, range).toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    syntax: `>${SPACE}`,
    aliases: ['blockquote'],
    offered: takesBlocks,
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

/** Below this length a query only matches the start of a name, so words in prose rarely match. */
const MIN_CONTAINS_QUERY = 3;

/**
 * The rows offered where the menu is open: those whose name or alias starts with the query, then,
 * for longer queries, those that contain it.
 */
export function slashItems(editor: Editor, query: string, options: SlashCommandOptions): SuggestionRow[] {
  const offered = SLASH_ITEMS.filter(item => item.offered(editor, options));
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) {
    return offered;
  }

  const names = (item: SlashItem) => [item.label.toLowerCase(), ...item.aliases];
  const starting = offered.filter(item => names(item).some(name => name.startsWith(lowerQuery)));
  if (lowerQuery.length < MIN_CONTAINS_QUERY) {
    return starting;
  }

  const containing = offered.filter(
    item => !starting.includes(item) && names(item).some(name => name.includes(lowerQuery)),
  );
  return [...starting, ...containing];
}

/** Not inside code, where a slash is code. */
function outsideCode(state: EditorState, range: Range): boolean {
  if (state.doc.resolve(range.from).parent.type.spec.code) return false;
  const code = state.schema.marks.code;
  return !code || !state.doc.rangeHasMark(range.from, range.to, code);
}

/**
 * Typing `/` at the start of a line or after a space opens a menu of blocks to insert or turn the
 * line into, filtered by what follows. It shares the popup and keys of the `{{` and `{%` menus,
 * and hands over to them for variables and logic. Unlike them it never holds back the Liquid
 * check: what follows a slash is not Liquid, and a slash in prose would otherwise silence it.
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
        pluginKey: SlashCommandPluginKey,
        char: '/',
        // Pasted and imported HTML often has a non-breaking space where a space would be
        allowedPrefixes: [' ', '\u00a0'],
        allow: ({state, range}) => outsideCode(state, range),
        items: ({editor, query}) => slashItems(editor, query, options) as SlashItem[],
        command: ({editor, range, props}) => props.run(editor, range),
        render: createSuggestionRenderer(props => new SuggestionMenu<SlashItem>(props, 'No matching block'), {
          holdsValidation: false,
        }),
      }),
    ];
  },
});

import type {BoxStyle} from '@plunk/shared';
import type {CommandProps, Editor} from '@tiptap/core';
import {NodeRange, type ResolvedPos} from '@tiptap/pm/model';
import {TextSelection} from '@tiptap/pm/state';
import {findWrapping} from '@tiptap/pm/transform';

/**
 * Commands of the email editor's box (see EmailBox). Boxes only sit at the top of the document,
 * so wrapping takes whole top-level blocks, and removing a box keeps all it held in its place.
 */

export const BOX = 'box';

/** The depth of the box `$pos` is in, or null outside one. */
export function boxDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === BOX) return depth;
  }
  return null;
}

/** The position of the box the selection is in, or null outside one. */
export function boxAtSelection(editor: Editor): number | null {
  const {$from} = editor.state.selection;
  const depth = boxDepth($from);
  return depth === null ? null : $from.before(depth);
}

/**
 * Wraps the top-level blocks the selection touches (paragraphs, lists, quotes, buttons, images…)
 * in a box with `attrs`. Inside a box there is nothing to wrap: boxes do not nest.
 */
export function wrapInBox(attrs: BoxStyle) {
  return ({state, tr, dispatch}: CommandProps): boolean => {
    const {$from, $to} = tr.selection;
    if (boxDepth($from) !== null || boxDepth($to) !== null) return false;

    const start = $from.depth > 0 ? $from.before(1) : $from.pos;
    const end = $to.depth > 0 ? $to.after(1) : $to.pos;
    if (end <= start) return false;
    const range = new NodeRange(tr.doc.resolve(start), tr.doc.resolve(end), 0);
    const wrapping = findWrapping(range, state.schema.nodes[BOX]!, attrs);
    if (!wrapping) return false;
    if (dispatch) tr.wrap(range, wrapping);
    return true;
  };
}

/** Sets the box at `pos` to `attrs`, leaving the cursor where it was. */
export function updateBox(pos: number, attrs: BoxStyle) {
  return ({tr, dispatch}: CommandProps): boolean => {
    if (tr.doc.nodeAt(pos)?.type.name !== BOX) return false;
    if (dispatch) tr.setNodeMarkup(pos, undefined, attrs);
    return true;
  };
}

/** Removes the box at `pos`, all it held staying in its place, whole. */
export function unwrapBox(pos: number) {
  return ({tr, dispatch}: CommandProps): boolean => {
    const box = tr.doc.nodeAt(pos);
    if (box?.type.name !== BOX) return false;
    if (dispatch) tr.replaceWith(pos, pos + box.nodeSize, box.content);
    return true;
  };
}

/**
 * Enter in an empty paragraph of a box: at its end, the cursor moves out after the box, into the
 * empty paragraph there or a new one, the empty paragraph leaving the box unless it is all the box
 * holds; anywhere else, a new paragraph, where ProseMirror would split the box in two. Lists and
 * other blocks inside a box keep their own Enter.
 */
export function enterInBox({editor}: {editor: Editor}): boolean {
  const {selection} = editor.state;
  const {$from} = selection;
  const depth = boxDepth($from);
  const paragraph = $from.parent;
  if (
    depth === null ||
    !selection.empty ||
    $from.depth !== depth + 1 ||
    paragraph.type.name !== 'paragraph' ||
    paragraph.content.size > 0
  ) {
    return false;
  }

  const box = $from.node(depth);
  if ($from.index(depth) < box.childCount - 1) return editor.commands.splitBlock();

  return editor.commands.command(({tr, dispatch}) => {
    if (!dispatch) return true;
    const after = $from.after(depth);
    const next = tr.doc.resolve(after).nodeAfter;
    // A box keeps at least one block: its only empty paragraph stays
    if (box.childCount > 1) tr.delete($from.before(), $from.after());
    const outside = tr.mapping.map(after);
    if (!(next?.type.name === 'paragraph' && next.content.size === 0)) {
      tr.insert(outside, editor.schema.nodes.paragraph!.create());
    }
    tr.setSelection(TextSelection.create(tr.doc, outside + 1)).scrollIntoView();
    return true;
  });
}

import type {CommandProps, Editor as CoreEditor} from '@tiptap/core';
import {NodeSelection, TextSelection, type Transaction} from '@tiptap/pm/state';
import type {Editor} from '@tiptap/react';
import {useEffect, useState} from 'react';

declare module '@tiptap/core' {
  interface EditorEvents {
    /** A block in the editor was double-clicked, to open its dialog (see useBlockDialog). */
    editBlock: {pos: number};
    /** A new block of `type` was asked for outside the toolbar, such as from the slash menu. */
    newBlock: {type: string};
  }
}

/** Opens the dialog of the block at `getPos()`, from a node view's double-click. */
export function emitEditBlock(editor: CoreEditor, getPos: () => number | undefined): void {
  const pos = getPos();
  if (typeof pos === 'number') editor.emit('editBlock', {pos});
}

/**
 * After inserting a block: a block left selected would be replaced by the next keystroke, so the
 * cursor moves to the text after it, or to a new paragraph when none follows.
 */
function continueAfterBlock({tr, state, dispatch}: CommandProps): boolean {
  if (!(tr.selection instanceof NodeSelection)) return true;
  if (dispatch) {
    const after = tr.selection.to;
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) {
      tr.insert(after, state.schema.nodes.paragraph!.create());
    }
    tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
  }
  return true;
}

/**
 * A command that inserts a block of `type` after the selection, rather than in its place, and
 * leaves the cursor in the text after the new block (inserting at the end of the selection leaves
 * the new block selected, never a block that was already there). It reads the selection from the
 * transaction, so it can follow other commands in a chain, such as deleting the slash menu's query.
 */
export function insertBlockAfterSelection(type: string, attrs?: Record<string, unknown>) {
  return (props: CommandProps): boolean =>
    props.commands.insertContentAt(props.tr.selection.to, {type, attrs}) && continueAfterBlock(props);
}

/** Inserts a block of `type` after the selection (see insertBlockAfterSelection). */
export function insertBlock(editor: CoreEditor, type: string, attrs?: Record<string, unknown>): boolean {
  return editor.chain().focus().command(insertBlockAfterSelection(type, attrs)).run();
}

/** What a block's dialog receives from useBlockDialog. */
export interface BlockDialogProps<Attrs> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The block being edited, or null to fill in a new one. */
  initial: Attrs | null;
  onSubmit: (attrs: Attrs) => void;
}

/**
 * Wires a block's dialog to an editor. The toolbar edits the selected block of `type`; with none
 * selected, it inserts one with its defaults (`insertDirectly`, for blocks that need nothing
 * filled in) or opens the dialog to fill in a new one, as it does when the slash menu asks for
 * one (`newBlock`). Double-clicking a block of `type` opens the dialog for it. New blocks go
 * after the selection (see insertBlockAfterSelection).
 */
export function useBlockDialog<Attrs extends object>(editor: Editor | null, type: string, insertDirectly = false) {
  // The dialog edits the block at `pos`, or fills in a new one when it is null
  const [state, setState] = useState<{open: boolean; pos: number | null}>({open: false, pos: null});

  useEffect(() => {
    if (!editor) return;
    const edit = ({pos}: {pos: number}) => {
      if (editor.state.doc.nodeAt(pos)?.type.name === type) setState({open: true, pos});
    };
    // A new block asked for outside the toolbar (the slash menu only asks for blocks that need a dialog)
    const add = ({type: asked}: {type: string}) => {
      if (asked === type) setState({open: true, pos: null});
    };
    editor.on('editBlock', edit);
    editor.on('newBlock', add);
    return () => {
      editor.off('editBlock', edit);
      editor.off('newBlock', add);
    };
  }, [editor, type]);

  // While its dialog is open, the block being edited follows changes to the document (a content
  // update from outside, say); the dialog closes if the block is gone.
  const editing = state.open ? state.pos : null;
  useEffect(() => {
    if (!editor || editing === null) return;
    const follow = ({transaction}: {transaction: Transaction}) => {
      const mapped = transaction.mapping.mapResult(editing);
      if (mapped.deleted) {
        setState({open: false, pos: null});
      } else if (mapped.pos !== editing) {
        setState({open: true, pos: mapped.pos});
      }
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [editor, editing]);

  const onToolbar = () => {
    if (!editor) return;
    const selection = editor.state.selection;
    const selected = selection instanceof NodeSelection && selection.node.type.name === type ? selection.from : null;
    if (selected === null && insertDirectly) {
      insertBlock(editor, type);
    } else {
      setState({open: true, pos: selected});
    }
  };

  const initial = state.pos === null ? null : ((editor?.state.doc.nodeAt(state.pos)?.attrs as Attrs) ?? null);

  const onSubmit = (submitted: Attrs) => {
    const attrs = submitted as Record<string, unknown>;
    if (!editor) return;
    if (state.pos === null) {
      insertBlock(editor, type, attrs);
    } else if (editor.state.doc.nodeAt(state.pos)?.type.name === type) {
      editor.chain().focus().setNodeSelection(state.pos).updateAttributes(type, attrs).run();
    }
    setState({open: false, pos: null});
  };

  return {
    onToolbar,
    dialogProps: {
      open: state.open,
      onOpenChange: (open: boolean) => setState(prev => ({...prev, open})),
      initial,
      onSubmit,
    } satisfies BlockDialogProps<Attrs>,
  };
}

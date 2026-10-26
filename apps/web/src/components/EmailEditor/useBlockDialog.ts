import type {ChainedCommands, CommandProps} from '@tiptap/core';
import {NodeSelection, TextSelection} from '@tiptap/pm/state';
import type {Editor} from '@tiptap/react';
import {useEffect, useState} from 'react';

declare module '@tiptap/core' {
  interface EditorEvents {
    /** A block in the editor was double-clicked, to open its dialog (see useBlockDialog). */
    editBlock: {pos: number};
  }
}

/**
 * After inserting a block: a block left selected would be replaced by the next keystroke, so the
 * cursor moves to the text after it, or to a new paragraph when none follows.
 */
export function continueAfterBlock({tr, state, dispatch}: CommandProps): boolean {
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
 * selected, it runs `insert` when given (blocks with a usable default) or opens the dialog to fill
 * in a new one. Double-clicking a block of `type` opens the dialog for it. New blocks go after the
 * selection, rather than in its place.
 */
export function useBlockDialog<Attrs extends object>(
  editor: Editor | null,
  type: string,
  insert?: (chain: ChainedCommands) => ChainedCommands,
) {
  // The dialog edits the block at `pos`, or fills in a new one when it is null
  const [state, setState] = useState<{open: boolean; pos: number | null}>({open: false, pos: null});

  useEffect(() => {
    if (!editor) return;
    const edit = ({pos}: {pos: number}) => {
      if (editor.state.doc.nodeAt(pos)?.type.name === type) setState({open: true, pos});
    };
    editor.on('editBlock', edit);
    return () => {
      editor.off('editBlock', edit);
    };
  }, [editor, type]);

  const atSelectionEnd = () => editor!.chain().focus().setTextSelection(editor!.state.selection.to);

  const onToolbar = () => {
    if (!editor) return;
    const selection = editor.state.selection;
    const selected = selection instanceof NodeSelection && selection.node.type.name === type ? selection.from : null;
    if (selected === null && insert) {
      insert(atSelectionEnd()).command(continueAfterBlock).run();
    } else {
      setState({open: true, pos: selected});
    }
  };

  const initial = state.pos === null ? null : ((editor?.state.doc.nodeAt(state.pos)?.attrs as Attrs) ?? null);

  const onSubmit = (submitted: Attrs) => {
    const attrs = submitted as Record<string, unknown>;
    if (state.pos === null) {
      atSelectionEnd().insertContent({type, attrs}).command(continueAfterBlock).run();
    } else {
      editor?.chain().focus().setNodeSelection(state.pos).updateAttributes(type, attrs).run();
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

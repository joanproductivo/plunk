import {NodeSelection} from '@tiptap/pm/state';
import type {Editor} from '@tiptap/react';
import {useEffect, useState} from 'react';

import type {ButtonDialogProps} from './ButtonDialog';
import type {ButtonAttrs} from './EmailButton';

/**
 * Wires the button dialog to an editor: the toolbar opens it for the selected button or a new
 * one, and double-clicking a button in the editor opens it for that button.
 */
export function useButtonDialog(editor: Editor | null) {
  // The dialog edits the button at `pos`, or inserts one when it is null
  const [state, setState] = useState<{open: boolean; pos: number | null}>({open: false, pos: null});

  useEffect(() => {
    if (!editor) return;
    const edit = ({pos}: {pos: number}) => setState({open: true, pos});
    editor.on('editButton', edit);
    return () => {
      editor.off('editButton', edit);
    };
  }, [editor]);

  const openButtonDialog = () => {
    const selection = editor?.state.selection;
    const selected = selection instanceof NodeSelection && selection.node.type.name === 'button';
    setState({open: true, pos: selected ? selection.from : null});
  };

  const initial = state.pos === null ? null : ((editor?.state.doc.nodeAt(state.pos)?.attrs as ButtonAttrs) ?? null);

  const onSubmit = (attrs: ButtonAttrs) => {
    if (state.pos === null) {
      // After whatever is selected, rather than in its place
      editor?.chain().focus().setTextSelection(editor.state.selection.to).setButton(attrs).run();
    } else {
      editor?.chain().focus().setNodeSelection(state.pos).updateAttributes('button', attrs).run();
    }
    setState({open: false, pos: null});
  };

  return {
    openButtonDialog,
    buttonDialogProps: {
      open: state.open,
      onOpenChange: (open: boolean) => setState(prev => ({...prev, open})),
      initial,
      onSubmit,
    } satisfies ButtonDialogProps,
  };
}

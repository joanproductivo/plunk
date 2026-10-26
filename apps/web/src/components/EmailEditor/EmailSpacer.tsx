import {readSpacerHeight, SPACER_DEFAULT_HEIGHT, spacerStyle} from '@plunk/shared';
import {Node} from '@tiptap/core';
import {NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer} from '@tiptap/react';

import {emitEditBlock} from './useBlockDialog';

export interface SpacerAttrs {
  height: number;
}

// In the editor a spacer shows its outline and height; in the email it is empty space.
function SpacerView({node, editor, getPos}: ReactNodeViewProps) {
  const {height} = node.attrs as SpacerAttrs;

  return (
    <NodeViewWrapper>
      <div
        title="Double-click to edit"
        onDoubleClick={() => emitEditBlock(editor, getPos)}
        className="flex select-none items-center justify-center rounded border border-dashed border-neutral-300 text-[11px] text-neutral-400"
        style={{height, cursor: 'pointer'}}
      >
        Spacer · {height}px
      </div>
    </NodeViewWrapper>
  );
}

/**
 * Empty vertical space, saved as an invisible <hr class="email-spacer"> with its height inline
 * (see @plunk/shared emailBlocks): an <hr> is a block the visual editor keeps, where a <div> would
 * make the whole body custom HTML. Sending turns it into a spacer every client keeps (see the
 * API's emailBody).
 */
export const EmailSpacer = Node.create({
  name: 'spacer',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      height: {
        default: SPACER_DEFAULT_HEIGHT,
        parseHTML: element => readSpacerHeight(element.getAttribute('style')),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // Ahead of the horizontal rule's own `hr` rule (default priority 50)
    return [{tag: 'hr.email-spacer', priority: 60}];
  },

  renderHTML({node}) {
    return ['hr', {class: 'email-spacer', style: spacerStyle((node.attrs as SpacerAttrs).height)}];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SpacerView);
  },
});

import {
  BOX_DEFAULTS,
  BOX_RADIUS,
  boxClass,
  boxPadding,
  boxStyle,
  type BoxStyle,
  isFullWidthBox,
  readBoxColors,
} from '@plunk/shared';
import {Node} from '@tiptap/core';
import {NodeViewContent, NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer} from '@tiptap/react';
import {Palette} from 'lucide-react';

import {BOX, enterInBox} from './boxCommands';
import {emitEditBlock} from './useBlockDialog';

// Everything a box can hold: every block but another box (see @plunk/shared emailBox)
const BOX_CONTENT =
  '(paragraph | heading | bulletList | orderedList | blockquote | codeBlock | horizontalRule | image | button | spacer | video)+';

/**
 * The editor's document: blocks and boxes, boxes only at the top. Lists and quotes hold blocks, so
 * keeping boxes out of the `block` group is what stops them nesting, however they are inserted.
 */
export const EmailDocument = Node.create({name: 'doc', topNode: true, content: '(block | box)+'});

function BoxView({node, editor, getPos}: ReactNodeViewProps) {
  const attrs = node.attrs as BoxStyle;

  return (
    <NodeViewWrapper
      data-box=""
      style={{
        position: 'relative',
        backgroundColor: attrs.backgroundColor,
        color: attrs.textColor,
        padding: boxPadding(attrs.fullWidth),
        borderRadius: attrs.fullWidth ? 0 : BOX_RADIUS,
        // Across the column, past the editor's own side padding (px-4)
        margin: attrs.fullWidth ? '1em -1rem' : '1em 0',
      }}
    >
      <button
        type="button"
        contentEditable={false}
        title="Box settings"
        aria-label="Box settings"
        onMouseDown={e => e.preventDefault()}
        onClick={() => emitEditBlock(editor, getPos)}
        className="box-settings absolute right-2 top-2 rounded bg-white/90 p-1 text-neutral-700 shadow-sm"
      >
        <Palette className="h-3.5 w-3.5" />
      </button>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

/**
 * A box with a background holding other blocks, inset with rounded corners or across the whole
 * column. Saved as <div class="email-box[ email-box-full]" style="background-color: …; color: …;">,
 * read back only from that exact div, as the custom-HTML check expects; sending turns it into a
 * table (see the API's emailBoxes).
 */
export const EmailBox = Node.create({
  name: BOX,
  group: 'box',
  content: BOX_CONTENT,
  defining: true,

  addAttributes() {
    return {
      backgroundColor: {
        default: BOX_DEFAULTS.backgroundColor,
        parseHTML: element => readBoxColors(element.getAttribute('style')).backgroundColor,
        renderHTML: () => ({}),
      },
      textColor: {
        default: BOX_DEFAULTS.textColor,
        parseHTML: element => readBoxColors(element.getAttribute('style')).textColor,
        renderHTML: () => ({}),
      },
      fullWidth: {
        default: BOX_DEFAULTS.fullWidth,
        parseHTML: element => isFullWidthBox(element.getAttribute('class')),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{tag: 'div.email-box', priority: 60}];
  },

  renderHTML({node}) {
    const attrs = node.attrs as BoxStyle;
    return ['div', {class: boxClass(attrs.fullWidth), style: boxStyle(attrs)}, 0];
  },

  addKeyboardShortcuts() {
    return {Enter: enterInBox};
  },

  addNodeView() {
    return ReactNodeViewRenderer(BoxView);
  },
});

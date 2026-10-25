import {TextAlign} from '@tiptap/extension-text-align';

import {parseBlockAlignment} from './blockAlignment';

// Blocks aligned through the paragraph that wraps them (see blockAlignment), not their own style.
const BLOCK_TYPES = ['image', 'button'];

/**
 * TextAlign as the email editor uses it. Images and buttons take part too (see ResizableImage
 * and EmailButton), so the alignment buttons and shortcuts align a selected block, or every
 * block in a selection. A block only keeps centre or right: left is how it renders anyway, so it
 * is stored as no alignment, and justify is not applied to it at all — otherwise justifying a
 * selection would silently pull every centred block in it back to the left.
 */
export const EmailTextAlign = TextAlign.extend({
  addGlobalAttributes() {
    return [
      // TextAlign's own `text-align` attribute, for text.
      ...(this.parent?.() ?? []).map(attributes => ({
        ...attributes,
        types: this.options.types.filter(type => !BLOCK_TYPES.includes(type)),
      })),
      // A block's alignment lives on the paragraph that wraps it, which the block renders;
      // `text-align` on the block itself would do nothing.
      {
        types: BLOCK_TYPES,
        attributes: {
          textAlign: {default: null, parseHTML: parseBlockAlignment, renderHTML: () => ({})},
        },
      },
    ];
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setTextAlign:
        (alignment: string) =>
        ({commands}) => {
          if (!this.options.alignments.includes(alignment)) {
            return false;
          }

          return this.options.types
            .map(type => {
              if (!BLOCK_TYPES.includes(type)) {
                return commands.updateAttributes(type, {textAlign: alignment});
              }
              if (alignment === 'justify') {
                return false;
              }
              return commands.updateAttributes(type, {textAlign: alignment === 'left' ? null : alignment});
            })
            .some(response => response);
        },
    };
  },
}).configure({
  types: ['heading', 'paragraph', ...BLOCK_TYPES],
  alignments: ['left', 'center', 'right', 'justify'],
});

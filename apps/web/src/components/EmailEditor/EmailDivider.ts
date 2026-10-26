import {closestOption, normalizeHexColor} from '@plunk/shared';
import {Extension} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';

export type DividerThickness = 'thin' | 'medium' | 'thick';
export type DividerSpacing = 'small' | 'medium' | 'large';

export interface DividerAttrs {
  color: string;
  thickness: DividerThickness;
  spacing: DividerSpacing;
}

/** The look of a plain <hr> in the email's prose styles, which a divider left as is keeps. */
export const DIVIDER_DEFAULTS: DividerAttrs = {color: '#e5e7eb', thickness: 'thin', spacing: 'large'};

export const DIVIDER_THICKNESS: Record<DividerThickness, number> = {thin: 1, medium: 2, thick: 4};

/** Space above and below, in px; `large` is the prose styles' own 3em (about 42px). */
export const DIVIDER_SPACING: Record<DividerSpacing, number> = {small: 16, medium: 24, large: 42};

// The widths browsers give border keywords.
const BORDER_KEYWORDS: Record<string, number> = {thin: 1, medium: 3, thick: 5};

/**
 * A divider's options from its <hr>, read through the CSSOM: the editor saves styles through it,
 * so a browser may hand back longhands and rgb() colours, or a hand-written border-top shorthand.
 * Anything it cannot tell falls back to the defaults.
 */
function readDivider(element: HTMLElement): DividerAttrs {
  const width = BORDER_KEYWORDS[element.style.borderTopWidth] ?? parseFloat(element.style.borderTopWidth);
  const margin = /^(\d+(?:\.\d+)?)px$/.exec(element.style.marginTop);

  return {
    color: normalizeHexColor(element.style.borderTopColor) ?? DIVIDER_DEFAULTS.color,
    thickness: Number.isNaN(width) ? DIVIDER_DEFAULTS.thickness : closestOption(DIVIDER_THICKNESS, width),
    spacing: margin ? closestOption(DIVIDER_SPACING, Number(margin[1])) : DIVIDER_DEFAULTS.spacing,
  };
}

/**
 * The inline style a divider is saved with, or null for the default look (a plain <hr>, as before
 * dividers had options). Longhands with explicit units, which browsers serialise unchanged but for
 * the colour; the prose styles' margin stays unless the spacing is set.
 */
export function dividerStyle(divider: DividerAttrs): string | null {
  // Values outside the options (only code can set them) count as the defaults
  const color = normalizeHexColor(divider.color) ?? DIVIDER_DEFAULTS.color;
  const thickness = Object.hasOwn(DIVIDER_THICKNESS, divider.thickness)
    ? divider.thickness
    : DIVIDER_DEFAULTS.thickness;
  const spacing = Object.hasOwn(DIVIDER_SPACING, divider.spacing) ? divider.spacing : DIVIDER_DEFAULTS.spacing;
  if (
    color === DIVIDER_DEFAULTS.color &&
    thickness === DIVIDER_DEFAULTS.thickness &&
    spacing === DIVIDER_DEFAULTS.spacing
  ) {
    return null;
  }

  const margin = spacing === 'large' ? '' : ` margin: ${DIVIDER_SPACING[spacing]}px 0px;`;
  return `border-width: ${DIVIDER_THICKNESS[thickness]}px 0px 0px; border-style: solid; border-color: ${color};${margin}`;
}

/**
 * Options for StarterKit's horizontal rule, so `---` and existing <hr>s keep working: colour,
 * thickness and spacing, saved in the rule's inline style (see dividerStyle). Double-clicking a
 * rule opens its dialog (see useBlockDialog). Sending needs nothing more: the inline style wins
 * over the prose styles once they are inlined.
 */
export const EmailDivider = Extension.create({
  name: 'emailDivider',

  addGlobalAttributes() {
    const fromStyle = <K extends keyof DividerAttrs>(key: K) => ({
      default: DIVIDER_DEFAULTS[key],
      parseHTML: (element: HTMLElement) => readDivider(element)[key],
      renderHTML: () => ({}),
    });

    return [
      {
        types: ['horizontalRule'],
        attributes: {
          // One attribute writes the style for all three
          color: {
            ...fromStyle('color'),
            renderHTML: (attributes: Record<string, unknown>) => {
              const style = dividerStyle(attributes as unknown as DividerAttrs);
              return style ? {style} : {};
            },
          },
          thickness: fromStyle('thickness'),
          spacing: fromStyle('spacing'),
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey('emailDividerDoubleClick'),
        props: {
          handleDoubleClickOn: (_view, _pos, node, nodePos) => {
            if (node.type.name !== 'horizontalRule') return false;
            editor.emit('editBlock', {pos: nodePos});
            return true;
          },
        },
      }),
    ];
  },
});

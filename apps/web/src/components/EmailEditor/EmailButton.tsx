import {
  BUTTON_DEFAULTS,
  BUTTON_PADDING,
  BUTTON_RADIUS,
  buttonStyle,
  type ButtonStyle,
  EMAIL_FONTS,
  isSafeButtonHref,
  readButtonStyle,
} from '@plunk/shared';
import {Node} from '@tiptap/core';
import {NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer} from '@tiptap/react';
import type {HTMLAttributes} from 'react';

import {blockAlignment, isLoneChildParagraph} from './blockAlignment';
import {emitEditBlock} from './useBlockDialog';

export interface ButtonAttrs extends ButtonStyle {
  text: string;
  href: string;
}

// A button's label is plain text; one with markup inside is custom HTML (see emailStyles).
const BUTTON = 'a.email-button';

// The attributes live on the <a>: the matched element itself, or the only child of the paragraph.
function buttonElement(element: HTMLElement): HTMLElement {
  return element.matches('a') ? element : (element.firstElementChild as HTMLElement);
}

// Read from the raw attribute: through the CSSOM a browser reports colours as rgb().
function styleOf(element: HTMLElement): ButtonStyle {
  return readButtonStyle(buttonElement(element).getAttribute('style'));
}

/** How a button looks in the dashboard: in the editor and in its dialog's preview. */
export function ButtonFace({
  button,
  text,
  style,
  ...props
}: {button: ButtonStyle; text: string} & HTMLAttributes<HTMLSpanElement>) {
  const [vertical, horizontal] = BUTTON_PADDING[button.size];

  return (
    <span
      {...props}
      style={{
        display: button.fullWidth ? 'block' : 'inline-block',
        textAlign: 'center',
        padding: `${vertical}px ${horizontal}px`,
        backgroundColor: button.backgroundColor,
        color: button.textColor,
        fontWeight: 600,
        lineHeight: 1.2,
        borderRadius: BUTTON_RADIUS[button.shape],
        fontFamily: button.font ? EMAIL_FONTS[button.font] : undefined,
        ...style,
      }}
    >
      {text || 'Button'}
    </span>
  );
}

function ButtonView({node, editor, getPos}: ReactNodeViewProps) {
  const attrs = node.attrs as ButtonAttrs & {textAlign: string | null};

  return (
    <NodeViewWrapper style={{textAlign: blockAlignment(attrs.textAlign) ?? 'left', margin: '1em 0'}}>
      {/* A span, not a link: the editor is no place to follow it. */}
      <ButtonFace
        button={attrs}
        text={attrs.text}
        title="Double-click to edit"
        onDoubleClick={() => emitEditBlock(editor, getPos)}
        style={{cursor: 'pointer'}}
      />
    </NodeViewWrapper>
  );
}

/**
 * A call-to-action button, saved as <p style="text-align: …"><a class="email-button" …>Label</a></p>
 * with its look in the inline style (see @plunk/shared emailButton). Sending adds the spacers
 * Outlook needs (see the API's emailBody).
 */
export const EmailButton = Node.create({
  name: 'button',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    const fromStyle = <K extends keyof ButtonStyle>(key: K) => ({
      default: BUTTON_DEFAULTS[key],
      parseHTML: (element: HTMLElement) => styleOf(element)[key],
      renderHTML: () => ({}),
    });

    return {
      text: {
        default: '',
        parseHTML: element => buttonElement(element).textContent ?? '',
        renderHTML: () => ({}),
      },
      href: {
        default: '',
        parseHTML: element => {
          const href = buttonElement(element).getAttribute('href') ?? '';
          return isSafeButtonHref(href) ? href : '';
        },
        renderHTML: () => ({}),
      },
      backgroundColor: fromStyle('backgroundColor'),
      textColor: fromStyle('textColor'),
      shape: fromStyle('shape'),
      size: fromStyle('size'),
      fullWidth: fromStyle('fullWidth'),
      font: fromStyle('font'),
    };
  },

  parseHTML() {
    return [
      // Ahead of the Link mark's `a[href]` (default priority 50).
      {tag: BUTTON, priority: 60, getAttrs: element => (element.childElementCount === 0 ? null : false)},
      // Ahead of Paragraph's own `p` rule (default priority 50).
      {
        tag: 'p',
        priority: 51,
        getAttrs: element =>
          isLoneChildParagraph(element, BUTTON) && element.firstElementChild!.childElementCount === 0 ? null : false,
      },
    ];
  },

  renderHTML({node}) {
    const attrs = node.attrs as ButtonAttrs & {textAlign: string | null};
    const href = attrs.href.trim();
    const link = [
      'a',
      {class: 'email-button', ...(isSafeButtonHref(href) ? {href} : {}), style: buttonStyle(attrs)},
      attrs.text,
    ] as const;
    const alignment = blockAlignment(attrs.textAlign);

    return alignment ? ['p', {style: `text-align: ${alignment}`}, link] : ['p', {}, link];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ButtonView);
  },
});

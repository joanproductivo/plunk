import {EMAIL_COLUMN_RADIUS, isSafeVideoHref, visualAttributeText} from '@plunk/shared';
import {Node} from '@tiptap/core';
import {NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer} from '@tiptap/react';

import {isLoneChildParagraph} from './blockAlignment';
import {emitEditBlock} from './useBlockDialog';

export interface VideoAttrs {
  /** The poster with its play button, uploaded to the project's storage. */
  src: string;
  /** The video's watch page (see @plunk/shared emailVideo). */
  href: string;
  alt: string;
  /** The poster's own size, which sending scales to the column (see the API's emailBody). */
  width: number | null;
  height: number | null;
}

const VIDEO = 'a.email-video';

// Rounded like a framed email's column, which Outlook for Windows squares. Written as browsers
// serialise it, so a video reads back exactly as it was saved.
const IMAGE_STYLE = `display: block; width: 100%; height: auto; margin: 0px; border: 0px; border-radius: ${EMAIL_COLUMN_RADIUS}px;`;

// A video is a watch link holding one image with a source and nothing else, so reading it as a
// block never drops anything; any other a.email-video stays custom HTML (see emailDocument).
function isVideoLink(element: Element | null): element is HTMLAnchorElement {
  return (
    !!element &&
    isSafeVideoHref(element.getAttribute('href')) &&
    element.childElementCount === 1 &&
    element.firstElementChild!.matches('img[src]') &&
    !/[^ \t\n\r\f]/.test(element.textContent ?? '')
  );
}

// The attributes live on the link and its image: the matched link, or the paragraph's only child.
function linkOf(element: HTMLElement): Element {
  return element.matches('a') ? element : element.firstElementChild!;
}

function imageOf(element: HTMLElement): HTMLImageElement {
  return linkOf(element).firstElementChild as HTMLImageElement;
}

function readSize(value: string | null): number | null {
  const size = Number(value);
  return Number.isInteger(size) && size > 0 ? size : null;
}

function VideoView({node, editor, getPos}: ReactNodeViewProps) {
  const attrs = node.attrs as VideoAttrs;

  return (
    <NodeViewWrapper style={{margin: '1em 0'}}>
      {/* An image, not a link: the editor is no place to follow it. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a poster in the project's storage */}
      <img
        src={attrs.src}
        alt={attrs.alt}
        title="Double-click to edit"
        draggable={false}
        onDoubleClick={() => emitEditBlock(editor, getPos)}
        style={{
          display: 'block',
          width: '100%',
          height: 'auto',
          margin: 0,
          borderRadius: EMAIL_COLUMN_RADIUS,
          cursor: 'pointer',
        }}
      />
    </NodeViewWrapper>
  );
}

/**
 * A YouTube video: its poster, with a play button drawn on it, linking to the video. Saved as
 * <p style="text-align: center;"><a class="email-video" href="…"><img class="email-image" …></a></p>,
 * always centred at the column's width: the link only when it is a safe watch page, the image
 * with the poster's own width and height and its alt text kept visual (see visualAttributeText).
 */
export const EmailVideo = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: {default: '', parseHTML: element => imageOf(element).getAttribute('src') ?? '', renderHTML: () => ({})},
      href: {
        default: '',
        parseHTML: element => linkOf(element).getAttribute('href'),
        renderHTML: () => ({}),
      },
      alt: {
        default: '',
        parseHTML: element => visualAttributeText(imageOf(element).getAttribute('alt') ?? ''),
        renderHTML: () => ({}),
      },
      width: {
        default: null,
        parseHTML: element => readSize(imageOf(element).getAttribute('width')),
        renderHTML: () => ({}),
      },
      height: {
        default: null,
        parseHTML: element => readSize(imageOf(element).getAttribute('height')),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      // Ahead of the Link mark's `a[href]` (default priority 50).
      {tag: VIDEO, priority: 60, getAttrs: element => (isVideoLink(element) ? null : false)},
      // Ahead of Paragraph's own `p` rule (default priority 50).
      {
        tag: 'p',
        priority: 51,
        getAttrs: element =>
          isLoneChildParagraph(element, VIDEO) && isVideoLink(element.firstElementChild) ? null : false,
      },
    ];
  },

  renderHTML({node}) {
    const attrs = node.attrs as VideoAttrs;
    const size = attrs.width && attrs.height ? {width: String(attrs.width), height: String(attrs.height)} : {};
    const image = [
      'img',
      {class: 'email-image', src: attrs.src, alt: visualAttributeText(attrs.alt), ...size, style: IMAGE_STYLE},
    ];
    const link = [
      'a',
      {
        class: 'email-video',
        ...(isSafeVideoHref(attrs.href) ? {href: attrs.href} : {}),
        style: 'text-decoration: none;',
      },
      image,
    ];

    return ['p', {style: 'text-align: center;'}, link];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoView);
  },
});

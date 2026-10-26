import {
  EMAIL_COLUMN_RADIUS,
  isSafeVideoHref,
  readVideoSize,
  VIDEO_DEFAULT_SIZE,
  VIDEO_SIZES,
  videoImageStyle,
  videoMaxWidth,
  type VideoSize,
  visualAttributeText,
} from '@plunk/shared';
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
  /** The poster's own size, which sending scales to the video's (see the API's emailBody). */
  width: number | null;
  height: number | null;
  /** How wide the video is shown (see @plunk/shared emailVideoSize). */
  size: VideoSize;
}

const VIDEO = 'a.email-video';

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
    // At its size, centred, so its selection outline is the video's too
    <NodeViewWrapper
      style={{
        margin: '1em auto',
        // As sent in an email without a brand width (see @plunk/shared videoImageStyle)
        width: `${VIDEO_SIZES[attrs.size]}%`,
        maxWidth: videoMaxWidth(attrs.size),
      }}
    >
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
 * centred at its size (see @plunk/shared emailVideoSize): the link only when it is a safe watch
 * page, the image with the poster's own width and height and its alt text kept visual (see
 * visualAttributeText). A video saved before sizes reads as large.
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
      size: {
        default: VIDEO_DEFAULT_SIZE,
        parseHTML: element => readVideoSize(imageOf(element).getAttribute('style')),
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
      {
        class: 'email-image',
        src: attrs.src,
        alt: visualAttributeText(attrs.alt),
        ...size,
        style: videoImageStyle(attrs.size),
      },
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

import {
  BOX_RADIUS,
  boxPadding,
  EMAIL_COLUMN_PADDING,
  type EmailBrand,
  emailFontFamily,
  isFramedBrand,
  isFullWidthBox,
  readBoxColors,
} from '@plunk/shared';
import type {CheerioAPI} from 'cheerio/slim';

/**
 * Editor boxes as every client can draw them (see @plunk/shared emailBox). Outlook for Windows
 * pads only table cells and ignores negative margins, as Gmail and Yahoo do, so a box goes out as
 * a one-cell table, and a full-width box in a framed brand takes the column's side padding over
 * from it. Colours are written as read from the box, never copied from the body.
 */

// Without a brand width, emails are drawn as 600 px wide, as sizeVideos does
const DEFAULT_WIDTH = 600;

// What the prose styles colour, and a box gives its own text colour instead
const RECOLOURED = 'h1, h2, h3, h4, strong, code, blockquote';

// `style` with `property` set to `value`, any earlier value of it dropped
function setDeclaration(style: string | undefined, property: string, value: string): string {
  const others = (style ?? '')
    .split(';')
    .map(declaration => declaration.trim())
    .filter(declaration => declaration && declaration.split(':')[0]!.trim().toLowerCase() !== property);
  return [...others, `${property}: ${value}`].join('; ');
}

/**
 * Gives what the prose styles colour inside a box (headings, bold text, code, quotes and their
 * border) the box's text colour, written out, as Outlook does not take `inherit`. Runs on the
 * inlined styles, before quotes become divs.
 */
export function recolourBoxes($: CheerioAPI): void {
  $('div.email-box').each((_, element) => {
    const {textColor} = readBoxColors($(element).attr('style'));
    $(element)
      .find(RECOLOURED)
      .each((__, child) => {
        const node = $(child);
        let style = setDeclaration(node.attr('style'), 'color', textColor);
        if (child.tagName === 'blockquote') style = setDeclaration(style, 'border-left-color', textColor);
        node.attr('style', style);
      });
  });
}

// The width the content of a box has in Outlook for Windows, which sizes images by their width
// attribute: the column's text, less the box's padding; a full-width box in a framed brand spans
// the column's own padding too
function contentWidth(brand: EmailBrand, fullWidth: boolean): number {
  const column = brand.contentWidth ? brand.contentWidth - 2 * EMAIL_COLUMN_PADDING : DEFAULT_WIDTH;
  const across = fullWidth && isFramedBrand(brand) ? 2 * EMAIL_COLUMN_PADDING : 0;
  return column + across - 2 * boxPadding(fullWidth);
}

// Images wider than `width`, sized by the editor for the column, made to fit the box
function fitImages($: CheerioAPI, box: ReturnType<CheerioAPI>, width: number): void {
  box.find('img').each((_, element) => {
    const image = $(element);
    const [imageWidth, imageHeight] = [Number(image.attr('width')), Number(image.attr('height'))];
    if (!(imageWidth > width)) return;
    image.attr('width', String(width));
    if (imageHeight > 0) image.attr('height', String(Math.round((imageHeight * width) / imageWidth)));
  });
}

/**
 * Turns each box into a one-cell table: background on the cell as an attribute and a style,
 * padding and rounding on the cell, and the email's font written on it, as Word does not always
 * inherit it. Its blocks move into the cell as they are.
 */
export function convertBoxes($: CheerioAPI, brand: EmailBrand): void {
  const font = emailFontFamily(brand).replace(/"/g, "'");
  $('div.email-box').each((_, element) => {
    const box = $(element);
    const {backgroundColor, textColor} = readBoxColors(box.attr('style'));
    const fullWidth = isFullWidthBox(box.attr('class'));
    fitImages($, box, contentWidth(brand, fullWidth));

    const cell = $(
      `<td bgcolor="${backgroundColor}" style="background-color: ${backgroundColor}; color: ${textColor}; ` +
        `padding: ${boxPadding(fullWidth)}px; border-radius: ${fullWidth ? 0 : BOX_RADIUS}px; ` +
        `font-family: ${font}; font-size: 14px; line-height: 1.7142857;"></td>`,
    );
    cell.append(box.contents());
    const table = $(
      `<table role="presentation" data-plunk-box="${fullWidth ? 'full' : 'inset'}" width="100%" cellpadding="0" ` +
        `cellspacing="0" border="0" style="margin: 16px 0; border-collapse: separate;"><tr></tr></table>`,
    );
    table.find('tr').append(cell);
    box.replaceWith(table);
  });
}

/**
 * In a framed brand with a full-width box, the column's side padding moves onto what sits between
 * full-width boxes and onto the footer, so those boxes reach the column's edges in every client.
 * The column keeps its padding unless this completes; without full-width boxes nothing changes.
 */
export function spanFullWidthBoxes($: CheerioAPI, brand: EmailBrand): void {
  if (!isFramedBrand(brand)) return;
  const prose = $('div.prose').first();
  const isFull = (node: Parameters<CheerioAPI>[0]) => $(node).is('table[data-plunk-box="full"]');
  if (!prose.children().toArray().some(isFull)) return;

  const column = prose.parent();
  // Runs of anything but full-width boxes, inside the content and after it (the footer's slot)
  const runs: ReturnType<CheerioAPI>[][] = [];
  for (const parent of [prose, column]) {
    let run: ReturnType<CheerioAPI>[] = [];
    for (const node of parent.contents().toArray()) {
      if (node === prose[0]) continue;
      if (isFull(node)) {
        runs.push(run);
        run = [];
      } else if (!(node.type === 'text' && !$(node).text().trim())) {
        run.push($(node));
      }
    }
    runs.push(run);
  }

  // Rewritten as HTML: cheerio moves elements, but not comments such as the footer's slot
  for (const run of runs.filter(nodes => nodes.length > 0)) {
    const html = run.map(node => $.html(node)).join('');
    run[0]!.replaceWith(`<div style="padding: 0 ${EMAIL_COLUMN_PADDING}px;">${html}</div>`);
    for (const node of run.slice(1)) node.remove();
  }
  column.attr('style', setDeclaration(column.attr('style'), 'padding', `${EMAIL_COLUMN_PADDING}px 0`));
}

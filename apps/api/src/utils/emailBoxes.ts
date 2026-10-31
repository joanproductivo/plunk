import {
  BOX_INHERITED_COLOUR,
  BOX_RADIUS,
  boxPadding,
  columnTextWidth,
  declarations,
  EMAIL_COLUMN_PADDING,
  type EmailBrand,
  isFramedBrand,
  isFullWidthBox,
  normalizeHexColor,
  readBoxColors,
  readPixels,
  withDeclaration,
} from '@plunk/shared';
import type {CheerioAPI} from 'cheerio/slim';

/**
 * Editor boxes as every client can draw them (see @plunk/shared emailBox). Outlook for Windows
 * pads only table cells and ignores negative margins, as Gmail and Yahoo do, so a box goes out as
 * a one-cell table, and a full-width box in a framed brand takes the column's side padding over
 * from it. Colours are written as read from the box, never copied from the body.
 */

type Selection = ReturnType<CheerioAPI>;

// The colour an element has written on it, unless it inherits one
function ownColour(element: Selection): string | null {
  return normalizeHexColor(declarations(element.attr('style')).get('color'));
}

/**
 * Writes out the colour headings, bold text, code and quotes inside a box take where the prose
 * styles give them `color: inherit` (see @plunk/shared emailProseCss), as Outlook does not take
 * it: the colour of the nearest element around them that has one, such as a link or a code block,
 * or else the box's text colour. A quote's border takes it too. Runs on the inlined styles, before
 * quotes become divs, outer elements before the ones inside them.
 */
export function recolourBoxes($: CheerioAPI): void {
  $('div.email-box').each((_, box) => {
    const {textColor} = readBoxColors($(box).attr('style'));
    $(box)
      .find(BOX_INHERITED_COLOUR.join(', '))
      .each((__, element) => {
        const node = $(element);
        if (declarations(node.attr('style')).get('color') !== 'inherit') return;

        let colour = textColor;
        for (let parent = node.parent(); parent.length > 0 && parent[0] !== box; parent = parent.parent()) {
          const found = ownColour(parent);
          if (found) {
            colour = found;
            break;
          }
        }
        let style = withDeclaration(node.attr('style'), 'color', colour);
        if (element.tagName === 'blockquote') style = withDeclaration(style, 'border-left-color', colour);
        node.attr('style', style);
      });
  });
}

// The width of a box's content in Outlook for Windows, which sizes images by their width
// attribute: the email's text less the box's padding; a full-width box in a framed brand spans the
// column's own padding too
function boxContentWidth(brand: EmailBrand, fullWidth: boolean): number {
  const across = fullWidth && isFramedBrand(brand) ? 2 * EMAIL_COLUMN_PADDING : 0;
  return columnTextWidth(brand) + across - 2 * boxPadding(fullWidth);
}

// Images wider than `width`, sized by the editor for the column, made to fit the box
function fitImages($: CheerioAPI, box: Selection, width: number): void {
  box.find('img').each((_, element) => {
    const image = $(element);
    const [imageWidth, imageHeight] = [readPixels(image.attr('width')), readPixels(image.attr('height'))];
    if (imageWidth <= width) return;
    image.attr('width', String(width));
    if (imageHeight > 0) image.attr('height', String(Math.round((imageHeight * width) / imageWidth)));
  });
}

/**
 * Turns each box into a one-cell table: background on the cell as an attribute and a style,
 * padding and rounding on the cell, and the email's type (font, size and line height, as inlined
 * on the content) written on it, as Word does not always inherit it. Its blocks move into the cell
 * as they are.
 */
export function convertBoxes($: CheerioAPI, brand: EmailBrand): void {
  const prose = declarations($('div.prose').first().attr('style'));
  const type = ['font-family', 'font-size', 'line-height']
    .filter(property => prose.has(property))
    .map(property => `${property}: ${prose.get(property)}; `)
    .join('');

  $('div.email-box').each((_, element) => {
    const box = $(element);
    const {backgroundColor, textColor} = readBoxColors(box.attr('style'));
    const fullWidth = isFullWidthBox(box.attr('class'));
    fitImages($, box, boxContentWidth(brand, fullWidth));

    const cell = $(
      `<td bgcolor="${backgroundColor}" style="background-color: ${backgroundColor}; color: ${textColor}; ` +
        `padding: ${boxPadding(fullWidth)}px; border-radius: ${fullWidth ? 0 : BOX_RADIUS}px; ${type.trim()}"></td>`,
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
 * Everything is worked out before the document changes; without full-width boxes nothing does.
 */
export function spanFullWidthBoxes($: CheerioAPI, brand: EmailBrand): void {
  if (!isFramedBrand(brand)) return;
  const prose = $('div.prose').first();
  const isFull = (node: Parameters<CheerioAPI>[0]) => $(node).is('table[data-plunk-box="full"]');
  if (!prose.children().toArray().some(isFull)) return;

  const column = prose.parent();
  // Runs of anything but full-width boxes, inside the content and after it (the footer's slot)
  const runs: Selection[][] = [];
  for (const parent of [prose, column]) {
    let run: Selection[] = [];
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
  const wrapped = runs
    .filter(nodes => nodes.length > 0)
    .map(nodes => ({
      nodes,
      html: `<div style="padding: 0 ${EMAIL_COLUMN_PADDING}px;">${nodes.map(node => $.html(node)).join('')}</div>`,
    }));
  const columnStyle = withDeclaration(column.attr('style'), 'padding', `${EMAIL_COLUMN_PADDING}px 0`);

  for (const {nodes, html} of wrapped) {
    nodes[0]!.replaceWith(html);
    for (const node of nodes.slice(1)) node.remove();
  }
  column.attr('style', columnStyle);
}

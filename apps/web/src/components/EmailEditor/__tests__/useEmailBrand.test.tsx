// @vitest-environment happy-dom
import {
  BRAND_DEFAULTS,
  BUTTON_DEFAULTS,
  type EmailBrand,
  EMAIL_FONT_FAMILY,
  EMAIL_FONTS,
  type ProjectBrand,
} from '@plunk/shared';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {SWRConfig} from 'swr';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {brandOnChange, canvasStyle, editorAttributes, isEmptyBody, useEmailBrand} from '../useEmailBrand';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: EmailBrand = {...BRAND_DEFAULTS, font: 'book-serif', textColor: '#222222', backgroundColor: '#f3f4f6'};
const OWN: EmailBrand = {...BRAND_DEFAULTS, linkColor: '#0a7c3e'};

describe('brandOnChange', () => {
  it('gives an email that was empty the project brand', () => {
    expect(brandOnChange(null, '', PROJECT)).toEqual(PROJECT);
    expect(brandOnChange(null, '<p></p>', PROJECT)).toEqual(PROJECT);
  });

  it('keeps the brand an email already has', () => {
    expect(brandOnChange(OWN, '', PROJECT)).toEqual(OWN);
    expect(brandOnChange(OWN, '<p>Hi</p>', PROJECT)).toEqual(OWN);
  });

  it('leaves an email written before brands without one, however its body arrived', () => {
    // An existing campaign whose body loads after the editor mounted: the change that loads it
    // already has the body, so it is not taken for a new email
    expect(brandOnChange(null, '<p>Hi</p>', PROJECT)).toBeNull();
  });

  it('writes no brand while the project brand has not loaded', () => {
    expect(brandOnChange(null, '', null)).toBeNull();
  });
});

describe('isEmptyBody', () => {
  it('only takes nothing, or the empty paragraph the editor leaves, for empty', () => {
    expect(isEmptyBody('')).toBe(true);
    expect(isEmptyBody(' <p></p> ')).toBe(true);
    expect(isEmptyBody('<p> </p>')).toBe(false);
    expect(isEmptyBody('<hr>')).toBe(false);
  });
});

describe('editor styles', () => {
  it('sets the prose colours and font on the editor itself, without a text colour class', () => {
    const {class: className, style} = editorAttributes(PROJECT);

    expect(className).not.toContain('text-neutral');
    expect(style).toContain('--tw-prose-body: #222222');
    expect(style).toContain('--tw-prose-headings: #111827');
    expect(style).toContain('--tw-prose-links: #3b82f6');
    expect(style).toContain(`font-family: ${EMAIL_FONTS['book-serif']}`);
    expect(editorAttributes(BRAND_DEFAULTS).style).toContain(`font-family: ${EMAIL_FONT_FAMILY}`);
  });

  it('frames the editor only for a brand with a background or a width', () => {
    expect(canvasStyle(BRAND_DEFAULTS)).toEqual({outer: {backgroundColor: undefined, padding: undefined}, inner: {}});
    expect(canvasStyle({...BRAND_DEFAULTS, contentWidth: 600})).toEqual({
      outer: {backgroundColor: undefined, padding: 16},
      inner: {maxWidth: 600, margin: '0 auto', backgroundColor: '#ffffff'},
    });
  });
});

describe('useEmailBrand', () => {
  let root: Root;
  let container: HTMLDivElement;
  const stored = vi.fn(async (): Promise<ProjectBrand> => ({...PROJECT, button: {...BUTTON_DEFAULTS, shape: 'pill'}}));

  // Renders what the hook returns, for the test to read
  function Probe({brand, body}: {brand: EmailBrand | null; body: string}) {
    return <pre>{JSON.stringify(useEmailBrand('project-1', brand, body))}</pre>;
  }

  const result = (): ReturnType<typeof useEmailBrand> => JSON.parse(container.textContent ?? '');

  async function render(brand: EmailBrand | null, body: string) {
    await act(async () => {
      root.render(
        <SWRConfig value={{fetcher: stored, provider: () => new Map(), dedupingInterval: 0}}>
          <Probe brand={brand} body={body} />
        </SWRConfig>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllMocks();
  });

  it('shows a new email in the project brand, without offering to apply it', async () => {
    await render(null, '');

    expect(stored).toHaveBeenCalledWith('/projects/project-1/brand');
    expect(result().look).toEqual(PROJECT);
    expect(result().differs).toBe(false);
    expect(result().button?.shape).toBe('pill');
  });

  it('shows an email written before brands as it is sent, and offers the project brand', async () => {
    await render(null, '<p>Hi</p>');

    expect(result().look).toEqual(BRAND_DEFAULTS);
    expect(result().differs).toBe(true);
  });

  it('shows an email in its own brand, and stops offering once it has the project one', async () => {
    await render(OWN, '<p>Hi</p>');
    expect(result().look).toEqual(OWN);
    expect(result().differs).toBe(true);

    await render(PROJECT, '<p>Hi</p>');
    expect(result().differs).toBe(false);
  });
});

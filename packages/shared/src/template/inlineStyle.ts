/**
 * `property: value` pairs of an inline style, with lower-case property names. Values never
 * contain `;` in the styles the editor writes (font names are quoted without one), so splitting
 * on it is enough.
 */
export function declarations(style: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const declaration of (style ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) {
      result.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim());
    }
  }
  return result;
}

/** `style` with `property` set to `value`, after the declarations it had, any earlier value of it dropped. */
export function withDeclaration(style: string | null | undefined, property: string, value: string): string {
  const others = [...declarations(style)].filter(([name]) => name !== property.toLowerCase());
  return [...others, [property, value]].map(([name, given]) => `${name}: ${given}`).join('; ');
}

/** A size attribute as the editor writes it, a whole number of pixels, or 0 for anything else. */
export function readPixels(value: string | null | undefined): number {
  return value && /^\d{1,5}$/.test(value) ? Number(value) : 0;
}

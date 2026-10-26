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

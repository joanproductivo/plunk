/**
 * A name as lowercase ASCII words joined by hyphens, at most `maxLength` characters long: accents
 * are dropped (`café` → `cafe`) and anything else becomes a separator. Empty when nothing is left.
 */
export function slugify(text: string, maxLength = 40): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, '');
}

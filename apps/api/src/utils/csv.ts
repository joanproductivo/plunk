/**
 * CSV encoding for the contacts export (RFC 4180).
 *
 * Spreadsheets run a cell that starts with `=`, `+`, `-` or `@` as a formula, and contact data
 * can come from anyone (the public `/v1/track` endpoint writes free-form `data`), so text cells
 * that would be read as a formula get a leading apostrophe. Numbers and phone numbers start
 * with `+`/`-` legitimately and are left alone. The contact import strips the apostrophe again
 * (`unescapeCsvFormula`), so an exported file re-imports to the same values.
 */

/** Always a formula trigger, whatever follows. */
const FORMULA_START = /^[=@\t\r]/;
/** A leading sign, which is only harmless on a number or a phone number. */
const SIGN_START = /^[+-]/;
const NUMBER_OR_PHONE = /^[+-]?[\d\s().-]+$/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/**
 * Whether a value gets an apostrophe: a formula (some spreadsheets trim leading spaces before
 * evaluating, so those are looked past), or a value that already starts with apostrophes in
 * front of one -- escaped again so the import can tell the two apart.
 */
function needsApostrophe(value: string): boolean {
  const isFormula = [value, value.trimStart()].some(
    text => FORMULA_START.test(text) || (SIGN_START.test(text) && !NUMBER_OR_PHONE.test(text)),
  );
  return isFormula || (value.startsWith("'") && needsApostrophe(value.slice(1)));
}

export function neutraliseFormula(value: string): string {
  return needsApostrophe(value) ? `'${value}` : value;
}

/** Inverse of `neutraliseFormula`, applied by the contact import. */
export function unescapeCsvFormula(value: string): string {
  return value.startsWith("'") && needsApostrophe(value.slice(1)) ? value.slice(1) : value;
}

export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) {
    text = '';
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'object') {
    text = neutraliseFormula(JSON.stringify(value));
  } else if (typeof value === 'string') {
    text = neutraliseFormula(value);
  } else {
    text = String(value);
  }

  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

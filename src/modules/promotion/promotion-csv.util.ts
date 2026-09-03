/**
 * CSV rendering for the redemption export (`promotions.export`).
 *
 * A deliberate, self-contained COPY of `modules/payment`'s `payment-csv.util.ts`
 * rather than an import of it. `backend/README.md` §2: "Each module exposes one
 * public surface, `<domain>.facade.ts`. No deep imports" — and a CSV helper is
 * not on `PaymentFacade`, nor should it be, because it is not part of what
 * payments offers other modules.
 *
 * Promoting it to `src/shared` was the other option and was rejected for now:
 * `shared` is meant for primitives every module needs, three copies is not yet a
 * pattern, and adding a shared file while four worktrees are in flight is a
 * merge conflict in the one directory all four touch. IF A THIRD MODULE NEEDS
 * THIS, MOVE ALL THREE TO `src/shared/csv/` IN ONE CHANGE — do not add a fourth
 * copy.
 */

/**
 * *** CSV INJECTION (a.k.a. formula injection). ***
 *
 * An export of financial data gets opened in Excel or Sheets, and a cell
 * beginning `=`, `+`, `-`, `@`, tab or CR is interpreted as a FORMULA by both.
 * A coupon LABEL of `=HYPERLINK("http://evil","click")` would execute in the
 * admin's spreadsheet — and unlike a payment's gateway text, a coupon label is
 * typed by a human into an admin form, so this is a first-class stored-XSS-shaped
 * risk here rather than a defensive nicety.
 *
 * Every field is prefixed with a single quote when it starts with one of those
 * characters. The value is unchanged as data; the spreadsheet just stops
 * treating it as code. OWASP's recommended mitigation, one comparison.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/** One field, escaped per RFC 4180 and defused against formula injection. */
export function toCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = value instanceof Date ? value.toISOString() : String(value);

  if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    text = `'${text}`;
  }

  // RFC 4180: a field containing a comma, a quote or a newline is quoted, and
  // an embedded quote is doubled.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** One row. */
export function toCsvRow(values: readonly unknown[]): string {
  return values.map(toCsvField).join(',');
}

/**
 * A whole document: header plus rows, CRLF-terminated per RFC 4180.
 *
 * A UTF-8 BOM is prepended because Excel on Windows otherwise reads a UTF-8 CSV
 * as the system codepage, and every rupee sign turns to mojibake. The BOM is
 * what makes it open correctly by double-click, which is how an admin will
 * actually use this.
 */
export function toCsvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  return `﻿${lines.join('\r\n')}\r\n`;
}

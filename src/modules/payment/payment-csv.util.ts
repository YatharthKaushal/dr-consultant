/**
 * CSV rendering for the transaction and refund exports — FR-18.4 ("payment and
 * refund management: transactions, doctor payouts, refunds and CSV export")
 * and SRS 6.7 ("payments, refunds and payouts are exportable as CSV").
 *
 * Small and hand-written rather than a dependency, because the only hard parts
 * are the two below and both are one line each.
 */

/**
 * *** CSV INJECTION (a.k.a. formula injection). ***
 *
 * An export of financial data gets opened in Excel or Sheets, and a cell
 * beginning `=`, `+`, `-`, `@`, tab or CR is interpreted as a FORMULA by both.
 * A refund reason of `=HYPERLINK("http://evil","click")` — or worse, a `=cmd|`
 * DDE payload — would execute in the admin's spreadsheet.
 *
 * Every field that can contain user- or gateway-supplied text is therefore
 * prefixed with a single quote when it starts with one of those characters.
 * The value is unchanged as data; the spreadsheet just stops treating it as
 * code. This is the OWASP-recommended mitigation and it costs one comparison.
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
 * A UTF-8 BOM is prepended because Excel on Windows otherwise reads a UTF-8
 * CSV as the system codepage, and every rupee sign and non-ASCII doctor name
 * turns to mojibake. The BOM is what makes it open correctly by double-click,
 * which is how an admin will actually use this.
 */
export function toCsvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  return `﻿${lines.join('\r\n')}\r\n`;
}

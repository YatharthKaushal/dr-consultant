/**
 * CSV rendering shared by every admin export in the codebase.
 *
 * *** THIS IS THE MOVE THE PREVIOUS THREE COPIES' HEADERS ASKED FOR. ***
 * `modules/payment/payment-csv.util.ts` was first, `modules/promotion
 * /promotion-csv.util.ts` was a deliberate second copy (its own header:
 * "IF A THIRD MODULE NEEDS THIS, MOVE ALL THREE TO `src/shared/csv/` IN ONE
 * CHANGE — do not add a fourth copy"), and `modules/governance
 * /governance-csv.util.ts` was the third, whose header named the NEXT
 * module that needs a CSV export as the one that should finally do this
 * move. M-21 (Audit, Compliance and Data Rights) is that module — its own
 * log/CSV export would otherwise have been a fourth byte-for-byte copy — so
 * this consolidation happens here, folding all four call sites onto one
 * implementation instead of adding a fourth.
 *
 * `modules/payment`, `modules/promotion` and `modules/governance` now import
 * this file instead of keeping their own copy; nothing about their CSV
 * output changed, only where the code that renders it lives. This does not
 * violate `backend/README.md` §2's "no deep imports" rule — that rule is
 * about not reaching into another MODULE's internals through the back door.
 * `src/shared` is exactly the place primitives every module needs are meant
 * to live (see `shared/audit`, `shared/app-config`), and a CSV field escaper
 * has no domain logic of its own to hide behind a facade.
 */

/**
 * *** CSV INJECTION (a.k.a. formula injection). ***
 *
 * An export gets opened in Excel or Sheets, and a cell beginning `=`, `+`,
 * `-`, `@`, tab or CR is interpreted as a FORMULA by both. A refund reason,
 * a coupon label, a clinician-authored alert reason, or an audit
 * `entity_type`/`metadata` string can all be human-typed text that ends up
 * in an export — and unlike output the admin never sees typed by anyone
 * else, that is a first-class stored-XSS-shaped risk here rather than a
 * defensive nicety.
 *
 * Every field is prefixed with a single quote when it starts with one of
 * those characters. The value is unchanged as data; the spreadsheet just
 * stops treating it as code. OWASP's recommended mitigation, one comparison.
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
 * CSV as the system codepage, and every rupee sign and non-ASCII name turns
 * to mojibake. The BOM is what makes it open correctly by double-click,
 * which is how an admin will actually use this.
 */
export function toCsvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  return `﻿${lines.join('\r\n')}\r\n`;
}

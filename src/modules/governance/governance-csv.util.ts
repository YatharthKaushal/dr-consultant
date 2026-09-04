/**
 * CSV rendering for governance's working-queue exports (`governance.export`,
 * FR-18.5/FR-18.6, SRS 6.7).
 *
 * *** THIS IS THE THIRD COPY. *** `modules/payment`'s `payment-csv.util.ts`
 * and `modules/promotion`'s `promotion-csv.util.ts` are byte-for-byte
 * identical to this file, and `promotion-csv.util.ts`'s own header already
 * says: "IF A THIRD MODULE NEEDS THIS, MOVE ALL THREE TO `src/shared/csv/` IN
 * ONE CHANGE — do not add a fourth copy." This build is that third module,
 * and the consolidation was NOT done here: this worktree's guardrails scope
 * its edits to `modules/governance` plus the small additive reads named in
 * its build task on `booking`/`clinical`/`followup`/`clarification`/`doctor`
 * — `modules/payment` and `modules/promotion` are outside that scope, and
 * moving three files at once while other worktrees may be touching either of
 * the first two is exactly the merge-conflict risk that header was written to
 * avoid. Flagged here and in this module's build report for the coordinator:
 * the next module that needs a CSV export should be the one that finally does
 * the `src/shared/csv/` move, folding all three (now four) copies into one.
 *
 * Self-contained rather than an import of either sibling for the same reason
 * `promotion-csv.util.ts` gives: `backend/README.md` §2 — "Each module
 * exposes one public surface, `<domain>.facade.ts`. No deep imports" — and a
 * CSV helper is not on `PaymentFacade`/`PromotionFacade`, nor should it be.
 */

/**
 * *** CSV INJECTION (a.k.a. formula injection). ***
 *
 * A queue export gets opened in Excel or Sheets, and a cell beginning `=`,
 * `+`, `-`, `@`, tab or CR is interpreted as a FORMULA by both. A safety
 * alert's clinician-authored `reason` text is exactly the kind of free-form
 * field this risk targets — unlike a payment's gateway text, it is typed by a
 * human, so this is a first-class stored-XSS-shaped risk here rather than a
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
 * CSV as the system codepage, and every non-ASCII doctor or patient name
 * turns to mojibake. The BOM is what makes it open correctly by
 * double-click, which is how an admin will actually use this.
 */
export function toCsvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  return `﻿${lines.join('\r\n')}\r\n`;
}

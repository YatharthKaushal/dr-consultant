/**
 * `governance-csv.util.ts` is a self-contained copy of `payment-csv.util.ts`
 * (see that file's own header for why) — this spec mirrors
 * `payment-csv.util.spec.ts`'s coverage against this copy, so a divergence
 * introduced here is caught the same way.
 */
import { toCsvDocument, toCsvField, toCsvRow } from './governance-csv.util';

describe('governance CSV rendering', () => {
  describe('toCsvField', () => {
    it('passes a plain value through', () => {
      expect(toCsvField('open')).toBe('open');
      expect(toCsvField(42)).toBe('42');
      expect(toCsvField(true)).toBe('true');
    });

    it('renders null and undefined as empty', () => {
      expect(toCsvField(null)).toBe('');
      expect(toCsvField(undefined)).toBe('');
    });

    it('renders a Date as ISO 8601', () => {
      expect(toCsvField(new Date('2026-09-01T10:00:00.000Z'))).toBe('2026-09-01T10:00:00.000Z');
    });

    it('quotes a field containing a comma, and doubles an embedded quote', () => {
      expect(toCsvField('Missed check-in, red flag')).toBe('"Missed check-in, red flag"');
      expect(toCsvField('Doctor said "urgent"')).toBe('"Doctor said ""urgent"""');
    });

    /** A clinician-authored `reason` is exactly the free-text field this defence targets — see the util's own header. */
    describe('formula injection defusing', () => {
      it.each([
        ['=HYPERLINK("http://evil.example","click")'],
        ['+1234'],
        ['-1234'],
        ['@SUM(A1:A9)'],
        ['\tstarts with tab'],
      ])('prefixes %s with a quote so a spreadsheet treats it as text', (dangerous) => {
        const rendered = toCsvField(dangerous);
        expect(rendered.replace(/^"|"$/g, '').startsWith("'")).toBe(true);
      });

      it('leaves harmless text alone', () => {
        expect(toCsvField('Patient reported thoughts of self-harm.')).toBe('Patient reported thoughts of self-harm.');
      });
    });
  });

  describe('toCsvRow', () => {
    it('joins fields with commas and preserves empty columns positionally', () => {
      expect(toCsvRow(['a', null, 'c'])).toBe('a,,c');
    });
  });

  describe('toCsvDocument', () => {
    it('renders a header and rows, CRLF-terminated, with a leading UTF-8 BOM', () => {
      const doc = toCsvDocument(['consultation_id', 'risk_category'], [['c1', 'high']]);
      expect(doc.charCodeAt(0)).toBe(0xfeff);
      expect(doc.slice(1)).toBe('consultation_id,risk_category\r\nc1,high\r\n');
    });

    it('renders a header-only document for an empty result set', () => {
      expect(toCsvDocument(['id'], []).slice(1)).toBe('id\r\n');
    });
  });
});

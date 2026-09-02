import { toCsvDocument, toCsvField, toCsvRow } from './payment-csv.util';

describe('payment CSV rendering', () => {
  describe('toCsvField', () => {
    it('passes a plain value through', () => {
      expect(toCsvField('paid')).toBe('paid');
      expect(toCsvField('708.00')).toBe('708.00');
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

    describe('RFC 4180 escaping', () => {
      it('quotes a field containing a comma', () => {
        expect(toCsvField('Cancelled, refunded')).toBe('"Cancelled, refunded"');
      });

      it('quotes and doubles an embedded quote', () => {
        expect(toCsvField('He said "no"')).toBe('"He said ""no"""');
      });

      it('quotes a field containing a newline', () => {
        expect(toCsvField('line one\nline two')).toBe('"line one\nline two"');
        expect(toCsvField('line one\r\nline two')).toBe('"line one\r\nline two"');
      });
    });

    /**
     * *** CSV / FORMULA INJECTION. ***
     *
     * A financial export gets opened in Excel or Sheets, and a cell beginning
     * `=`, `+`, `-`, `@`, tab or CR is interpreted as a FORMULA. A refund
     * reason is free text typed by an admin — or, on other rows, text that
     * originated at the gateway — so it is an injection vector straight into
     * the finance team's spreadsheet.
     */
    describe('formula injection defusing', () => {
      it.each([
        ['=HYPERLINK("http://evil.example","click")'],
        ['=1+1'],
        ['+1234'],
        ['-1234'],
        ['@SUM(A1:A9)'],
        ['\tstarts with tab'],
        ['\rstarts with CR'],
      ])('prefixes %s with a quote so a spreadsheet treats it as text', (dangerous) => {
        const rendered = toCsvField(dangerous);
        // The value survives as DATA; it just stops being CODE.
        expect(rendered.replace(/^"|"$/g, '').startsWith("'")).toBe(true);
      });

      it('defuses the classic DDE command payload', () => {
        const rendered = toCsvField('=cmd|\' /C calc\'!A0');
        expect(rendered).toContain("'=cmd");
      });

      it('leaves a harmless leading character alone', () => {
        expect(toCsvField('normal text')).toBe('normal text');
        expect(toCsvField('708.00')).toBe('708.00');
      });

      /** A negative money value would otherwise be silently quoted — worth knowing it is, and that it is still readable. */
      it('prefixes a negative number, which is the documented trade-off', () => {
        expect(toCsvField('-100.00')).toBe("'-100.00");
      });

      it('defuses AND escapes when a value is both dangerous and comma-bearing', () => {
        expect(toCsvField('=A1,B2')).toBe('"\'=A1,B2"');
      });
    });
  });

  describe('toCsvRow', () => {
    it('joins fields with commas', () => {
      expect(toCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
    });

    it('preserves empty columns positionally', () => {
      expect(toCsvRow(['a', null, 'c'])).toBe('a,,c');
    });
  });

  describe('toCsvDocument', () => {
    it('renders a header and rows, CRLF-terminated', () => {
      const doc = toCsvDocument(['id', 'amount'], [['p1', '708.00'], ['p2', '354.00']]);
      // Strip the BOM for the comparison.
      expect(doc.slice(1)).toBe('id,amount\r\np1,708.00\r\np2,354.00\r\n');
    });

    /** Excel on Windows otherwise reads a UTF-8 CSV as the system codepage and mangles every non-ASCII name. */
    it('starts with a UTF-8 BOM so Excel opens it correctly by double-click', () => {
      expect(toCsvDocument(['id'], [['p1']]).charCodeAt(0)).toBe(0xfeff);
    });

    it('renders a header-only document for an empty result set', () => {
      expect(toCsvDocument(['id', 'amount'], []).slice(1)).toBe('id,amount\r\n');
    });

    it('round-trips a realistic transactions row', () => {
      const doc = toCsvDocument(
        ['payment_id', 'status', 'consultation_fee', 'convenience_fee', 'gst_amount', 'total_payable', 'doctor_earning', 'platform_deduction'],
        [['e1f7a8d0', 'paid', '500.00', '100.00', '108.00', '708.00', '500.00', '0.00']],
      );
      // FR-7.3 and FR-7.4 both readable straight off the export.
      expect(doc).toContain('500.00,100.00,108.00,708.00,500.00,0.00');
    });
  });
});

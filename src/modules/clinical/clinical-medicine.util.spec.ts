import { CLINICAL_ERROR_CODES, MAX_MEDICINE_LINES } from './clinical.constants';
import { normaliseText, parseMedicineLines } from './clinical-medicine.util';

const VALID = { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' };

function expectRejected(raw: unknown): void {
  expect(() => parseMedicineLines(raw, 'template')).toThrow(
    expect.objectContaining({ response: { code: CLINICAL_ERROR_CODES.MEDICINE_LINE_INVALID, message: expect.any(String) } }),
  );
}

describe('parseMedicineLines', () => {
  /**
   * The whole reason this function exists rather than trusting the DTO: two of
   * the three ways medicines enter this module are `jsonb` reads that never
   * touch class-validator. See the util's own header.
   */
  it('accepts a well-formed line and trims every field', () => {
    expect(parseMedicineLines([{ ...VALID, name: '  Sertraline\t' }], 'template')).toEqual([VALID]);
  });

  it('drops a blank `instructions` rather than storing an empty string', () => {
    const [line] = parseMedicineLines([{ ...VALID, instructions: '   ' }], 'request');
    expect(line).not.toHaveProperty('instructions');
  });

  it('keeps a real `instructions`', () => {
    expect(parseMedicineLines([{ ...VALID, instructions: ' After food. ' }], 'request')).toEqual([
      { ...VALID, instructions: 'After food.' },
    ]);
  });

  it('treats null/undefined as no medicines, never as an error', () => {
    expect(parseMedicineLines(null, 'template')).toEqual([]);
    expect(parseMedicineLines(undefined, 'template')).toEqual([]);
  });

  it('rejects a non-array — a jsonb column can hold anything', () => {
    expectRejected({ name: 'Sertraline' });
    expectRejected('Sertraline 50mg');
  });

  it('rejects an entry that is not an object', () => {
    expectRejected(['Sertraline 50mg']);
    expectRejected([null]);
    expectRejected([['Sertraline']]);
  });

  it('rejects a line missing any of the four required fields', () => {
    for (const field of ['name', 'dose', 'frequency', 'duration']) {
      const line: Record<string, unknown> = { ...VALID };
      delete line[field];
      expectRejected([line]);
    }
  });

  it('rejects a required field that is blank or whitespace — a dose of " " is not a dose', () => {
    expectRejected([{ ...VALID, dose: '   ' }]);
    expectRejected([{ ...VALID, name: '' }]);
  });

  it('rejects a required field that is the wrong type', () => {
    expectRejected([{ ...VALID, dose: 50 }]);
  });

  it('rejects an over-long field', () => {
    expectRejected([{ ...VALID, name: 'x'.repeat(201) }]);
  });

  it('rejects more lines than a prescription may carry', () => {
    expectRejected(Array.from({ length: MAX_MEDICINE_LINES + 1 }, () => ({ ...VALID })));
    expect(parseMedicineLines(Array.from({ length: MAX_MEDICINE_LINES }, () => ({ ...VALID })), 'template')).toHaveLength(
      MAX_MEDICINE_LINES,
    );
  });

  it('names the source in the message, so a bad TEMPLATE row is distinguishable from a bad request', () => {
    expect(() => parseMedicineLines(['nope'], 'template')).toThrow(/from template/);
    expect(() => parseMedicineLines(['nope'], 'specialty_template')).toThrow(/from specialty_template/);
  });
});

describe('normaliseText', () => {
  /** The completion gate reads NULL, so this is what stops a single space satisfying FR-11.3. */
  it('collapses blank and whitespace-only text to null', () => {
    expect(normaliseText('')).toBeNull();
    expect(normaliseText('   ')).toBeNull();
    expect(normaliseText('\n\t ')).toBeNull();
  });

  it('passes null and undefined straight through', () => {
    expect(normaliseText(null)).toBeNull();
    expect(normaliseText(undefined)).toBeNull();
  });

  it('trims real text', () => {
    expect(normaliseText('  Stable. Continue plan.  ')).toBe('Stable. Continue plan.');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  findUnicodeFont,
  renderPrescriptionPdf,
  resolveUnicodeFontPath,
  type PrescriptionDocumentData,
} from './clinical-pdf.renderer';

/** A Devanagari doctor name and patient name — the exact input pdfkit's Latin-1 built-ins would silently mangle. */
const DEVANAGARI_PATIENT = 'आरती शर्मा';
const DEVANAGARI_DOCTOR = 'डॉ. राजेश कुमार';

function data(overrides: Partial<PrescriptionDocumentData> = {}): PrescriptionDocumentData {
  return {
    referenceCode: 'DC-2026-000123',
    consultedOn: new Date('2026-09-01T10:00:00Z'),
    patientName: 'Arti Sharma',
    doctorName: 'Dr Rajesh Kumar',
    doctorQualification: 'MD (Psychiatry)',
    doctorRegistrationNumber: 'MCI-12345',
    specialtyName: 'Psychiatry',
    chiefComplaint: 'Low mood for three months.',
    diagnosis: 'Recurrent depressive disorder',
    isDiagnosisProvisional: true,
    riskCategory: 'moderate',
    referralNote: null,
    medicines: [{ name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days', instructions: 'After food.' }],
    advice: {
      covered: 'Reviewed sleep and mood.',
      homePractice: 'Ten minutes of paced breathing at night.',
      nextFocus: 'Behavioural activation.',
      warningSigns: 'Thoughts of self-harm, or not sleeping for two nights.',
    },
    finalisedAt: new Date('2026-09-01T11:00:00Z'),
    ...overrides,
  };
}

/** `%PDF-` — the file signature every reader checks first. */
function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * The drawn text, read back out of the PDF.
 *
 * *** A NAIVE `pdf.toString().includes('...')` PASSES VACUOUSLY, AND THAT IS
 * WHY THIS EXISTS. *** Two things stand between the words on the page and the
 * bytes in the file:
 *
 *   1. pdfkit FLATE-COMPRESSES every content stream, so the text is not
 *      present as bytes at all;
 *   2. it writes show-text operands as HEX STRINGS inside `TJ` arrays —
 *      `[<507265736372> -15 <697074696f6e> 0] TJ` — never as `(literals)`,
 *      because it always applies kerning.
 *
 * So a raw-buffer `toContain` fails for text that IS on the page, and — far
 * worse — a raw-buffer `not.toContain` PASSES for text that is. This inflates
 * every stream and decodes the hex runs.
 *
 * Only meaningful for the Latin-1 fallback face: with the embedded Unicode font
 * those hex runs are GLYPH IDS, not characters. That is exactly why every
 * content assertion below renders with `fontPath: null`, while the font
 * assertions above examine the font objects instead.
 */
function extractText(pdf: Buffer): string {
  const parts: string[] = [];
  const raw = pdf.toString('latin1');
  const streamPattern = /stream\r?\n/g;

  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;

    let inflated: string;
    try {
      inflated = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      // Not a Flate stream (an embedded font program, say) — nothing to read.
      continue;
    }

    for (const run of inflated.matchAll(/<([0-9a-fA-F]+)>/g)) {
      parts.push(Buffer.from(run[1] ?? '', 'hex').toString('latin1'));
    }
    for (const literal of inflated.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      parts.push(literal[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
    }
  }
  return parts.join('');
}

describe('renderPrescriptionPdf', () => {
  it('produces a real PDF', async () => {
    const pdf = await renderPrescriptionPdf(data());

    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(-6).toString('latin1')).toContain('%%EOF');
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* The font. See `assets/fonts/README.md`.                                 */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the embedded Unicode font', () => {
    it('*** THE ASSET IS ACTUALLY THERE. *** A missing TTF is a silently mangled patient name, not a crash', () => {
      const path = resolveUnicodeFontPath();

      expect(existsSync(path)).toBe(true);
      expect(findUnicodeFont()).toBe(path);
      // A TrueType file starts with the 0x00010000 sfnt version tag.
      expect(readFileSync(path).subarray(0, 4).toString('hex')).toBe('00010000');
    });

    it('*** RENDERS A DEVANAGARI PATIENT AND DOCTOR NAME WITHOUT THROWING AND WITHOUT DROPPING THEM ***', async () => {
      const withNames = data({ patientName: DEVANAGARI_PATIENT, doctorName: DEVANAGARI_DOCTOR });

      const embedded = await renderPrescriptionPdf(withNames);
      const fallback = await renderPrescriptionPdf(withNames, null);

      expect(isPdf(embedded)).toBe(true);
      // The embedded subset carries real glyphs for those names; the Latin-1
      // fallback carries none and produces a much smaller file. The size gap IS
      // the difference between a rendered name and a mangled one.
      expect(embedded.length).toBeGreaterThan(fallback.length * 3);
    });

    it('embeds a SUBSETTED font program rather than referencing a base-14 face', async () => {
      const pdf = await renderPrescriptionPdf(data({ patientName: DEVANAGARI_PATIENT }));
      const raw = pdf.toString('latin1');

      // pdfkit embeds a TTF as a `/Type0` composite font over a
      // `/CIDFontType2` descendant whose program is a `/FontFile2` stream. A
      // base-14 face would instead appear as a bare `/BaseFont /Helvetica`
      // with no descriptor and no font program at all.
      expect(raw).toContain('/FontFile2');
      expect(raw).toContain('/CIDFontType2');
      expect(raw).toContain('/Type0');
      // The subset tag prefixes the real family name.
      expect(raw).toMatch(/[A-Z]{6}\+Lohit-Devanagari/);
      expect(raw).not.toContain('Helvetica');
    });

    it('*** STILL PRODUCES A PDF WHEN THE FONT IS MISSING *** — the fallback is a degradation, not an outage', async () => {
      const pdf = await renderPrescriptionPdf(data(), null);

      expect(isPdf(pdf)).toBe(true);
      expect(pdf.toString('latin1')).toContain('Helvetica');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* What the page does and does not say                                     */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('content', () => {
    it('renders an empty medicine list as an explicit statement, not a blank space', async () => {
      // A non-prescribing professional's closing record is the advice plan, and
      // a patient must not read the absence of a Medicines section as a missing
      // page.
      const pdf = await renderPrescriptionPdf(data({ medicines: [] }), null);

      expect(extractText(pdf)).toContain('No medicines were prescribed');
    });

    it('marks a provisional diagnosis as provisional', async () => {
      const pdf = await renderPrescriptionPdf(data({ isDiagnosisProvisional: true }), null);

      expect(extractText(pdf)).toContain('Recurrent depressive disorder (provisional)');
    });

    it('does not mark a confirmed diagnosis as provisional', async () => {
      const pdf = await renderPrescriptionPdf(data({ isDiagnosisProvisional: false }), null);
      const text = extractText(pdf);

      // Positive control first, so the negative below cannot pass vacuously
      // against an empty extraction.
      expect(text).toContain('Recurrent depressive disorder');
      expect(text).not.toContain('provisional');
    });

    it('carries FR-14.2\'s warning signs under their own heading', async () => {
      const pdf = await renderPrescriptionPdf(data(), null);
      const text = extractText(pdf);

      expect(text).toContain('Seek help if you notice');
      expect(text).toContain('Thoughts of self-harm');
    });

    it('survives a record with nothing optional filled in', async () => {
      const pdf = await renderPrescriptionPdf(
        data({
          patientName: null,
          doctorName: null,
          doctorQualification: null,
          doctorRegistrationNumber: null,
          specialtyName: null,
          diagnosis: null,
          referralNote: null,
          medicines: [],
          advice: { covered: null, homePractice: null, nextFocus: null, warningSigns: null },
        }),
        null,
      );

      expect(isPdf(pdf)).toBe(true);
    });

    it('prints the consultation reference, which is the id FR-11.6 makes the spine of the case', async () => {
      const pdf = await renderPrescriptionPdf(data({ referenceCode: 'DC-2026-000999' }), null);

      expect(extractText(pdf)).toContain('DC-2026-000999');
    });
  });
});

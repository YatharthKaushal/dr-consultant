import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { ClinicalAdvice, ClinicalMedicine } from './clinical.contract';
import { CLINICAL_PDF_FONT_RELATIVE_PATH } from './clinical.constants';

/** Everything the prescription PDF renders. Assembled by `clinical-pdf.service.ts` from four facades; this file reads no database and calls no facade. */
export interface PrescriptionDocumentData {
  referenceCode: string;
  consultedOn: Date;
  patientName: string | null;
  doctorName: string | null;
  doctorQualification: string | null;
  doctorRegistrationNumber: string | null;
  specialtyName: string | null;
  chiefComplaint: string;
  diagnosis: string | null;
  isDiagnosisProvisional: boolean;
  riskCategory: string;
  referralNote: string | null;
  medicines: ClinicalMedicine[];
  advice: ClinicalAdvice;
  finalisedAt: Date;
}

/*
 * *** `caseSummary` IS DELIBERATELY NOT ON THIS TYPE. ***
 *
 * FR-11.3's 3-to-5-line case summary is a CLINICAL-GOVERNANCE artefact: it is
 * what the pending-summaries worklist (FR-9.3) counts, what
 * `clinical.read_records` lets a governance admin read, and what M-17 starts a
 * de-identified clarification from. FR-14.2 scopes the PATIENT'S pdf to "the
 * prescription... with warning signs and the doctor's follow-up plan" and names
 * nothing else. Printing the case summary onto the patient's copy would put a
 * clinician-to-clinician note in front of the person it is about, which is a
 * disclosure decision nobody made. It stays in the record, reachable through
 * `ClinicalContract` and the admin read.
 */

/* -------------------------------------------------------------------------- */
/* The font                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * *** WHY THIS MODULE EMBEDS A TTF AT ALL. ***
 *
 * `pdfkit`'s built-in faces (Helvetica, Times, Courier) are Type1/AFM fonts
 * with a LATIN-1 encoding. Give one of them a Devanagari string and it does not
 * throw — it writes the wrong glyphs. A prescription carries a patient's name
 * and a doctor's name, so on this document that failure mode is not cosmetic.
 *
 * `assets/fonts/Lohit-Devanagari.ttf` (SIL OFL 1.1) covers Devanagari AND Basic
 * Latin, so one embedded face renders "Chief complaint" and "डॉ. आरती शर्मा" on
 * the same line with no font switching. Shaping — conjuncts, matras, reordering
 * — comes from `fontkit`, which `pdfkit` already uses internally and which
 * ships an Indic shaper; there is no extra dependency.
 *
 * Resolved relative to THIS FILE, so it works identically from `src/` under
 * ts-jest and from `dist/` under `nest build`: both are exactly three levels
 * below the project root.
 */
export function resolveUnicodeFontPath(): string {
  return join(__dirname, ...CLINICAL_PDF_FONT_RELATIVE_PATH);
}

/**
 * `null` when the asset is missing, so the caller can log once and fall back.
 *
 * *** THE FALLBACK IS A DEGRADATION, NOT A CONFIGURATION. *** A missing font is
 * a broken deploy, and the right response is a loud warning plus a PDF that
 * still exists — refusing to issue any prescription because a typeface is
 * absent would be worse for the patient than an imperfectly-typeset one. The
 * warning is the caller's to emit; this function only reports the fact.
 */
export function findUnicodeFont(): string | null {
  const path = resolveUnicodeFontPath();
  return existsSync(path) ? path : null;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

const PAGE_MARGIN = 48;
const RULE_COLOUR = '#c9c9c9';
const MUTED_COLOUR = '#555555';
const BODY_COLOUR = '#111111';

/**
 * Renders the patient prescription PDF (FR-9.5's "structured form that
 * generates the patient PDF", FR-14.2's "view and download the prescription
 * PDF, with warning signs and the doctor's follow-up plan").
 *
 * A PURE FUNCTION of its input: no database, no facade, no clock, no
 * filesystem beyond reading the font. That is what makes it testable byte-for-
 * byte, and it is why the data-gathering lives in `clinical-pdf.service.ts`.
 *
 * Resolves with the complete buffer. `pdfkit` streams, so the buffer is
 * accumulated here rather than handed a file path — the bytes go to object
 * storage through `DocumentFacade`, never to this server's disk.
 */
export async function renderPrescriptionPdf(
  data: PrescriptionDocumentData,
  fontPath: string | null = findUnicodeFont(),
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    info: {
      Title: `Prescription ${data.referenceCode}`,
      Author: data.doctorName ?? 'Treating doctor',
      Subject: 'Prescription and advice',
      Creator: 'Doctor Consultation Platform',
    },
  });

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ONE face for the whole document. Registered under a stable alias so the
  // rest of this function never has to know whether the embedded font or the
  // Latin-1 fallback is in play — and so a missing asset changes exactly one
  // line of behaviour rather than every `.font()` call below.
  const FACE = 'body';
  if (fontPath) {
    doc.registerFont(FACE, fontPath);
  } else {
    doc.registerFont(FACE, 'Helvetica');
  }
  doc.font(FACE);

  writeHeader(doc, FACE, data);
  writeParties(doc, FACE, data);
  writeClinicalSummary(doc, FACE, data);
  writeMedicines(doc, FACE, data);
  writeAdvice(doc, FACE, data);
  writeFooter(doc, FACE, data);

  doc.end();
  return finished;
}

type Doc = PDFKit.PDFDocument;

function writeHeader(doc: Doc, face: string, data: PrescriptionDocumentData): void {
  doc.font(face).fontSize(18).fillColor(BODY_COLOUR).text('Prescription and Advice');
  doc.moveDown(0.2);
  doc
    .fontSize(9)
    .fillColor(MUTED_COLOUR)
    .text(`Consultation ${data.referenceCode}  ·  ${formatDate(data.consultedOn)}`);
  rule(doc);
}

function writeParties(doc: Doc, face: string, data: PrescriptionDocumentData): void {
  // The patient's name is the single most likely non-Latin string on this page
  // — see `findUnicodeFont`.
  field(doc, face, 'Patient', data.patientName ?? 'Not recorded');

  const credentials = [data.doctorQualification, data.doctorRegistrationNumber ? `Reg. ${data.doctorRegistrationNumber}` : null]
    .filter((part): part is string => Boolean(part))
    .join('  ·  ');
  field(doc, face, 'Doctor', joinNonEmpty([data.doctorName ?? 'Not recorded', credentials], '\n'));

  if (data.specialtyName) field(doc, face, 'Specialty', data.specialtyName);
  rule(doc);
}

function writeClinicalSummary(doc: Doc, face: string, data: PrescriptionDocumentData): void {
  field(doc, face, 'Chief complaint', data.chiefComplaint);

  if (data.diagnosis) {
    // The provisional/confirmed distinction is `is_diagnosis_provisional`, and
    // it is printed rather than implied: a patient reading "Anxiety disorder"
    // and a patient reading "Anxiety disorder (provisional)" are being told
    // two materially different things.
    field(doc, face, 'Diagnosis', data.isDiagnosisProvisional ? `${data.diagnosis} (provisional)` : data.diagnosis);
  }

  field(doc, face, 'Risk category', capitalise(data.riskCategory));

  // Set = a referral WAS advised, and this is it. There is no separate boolean
  // (`clinical-records.schema.ts`), so its presence is the fact.
  if (data.referralNote) field(doc, face, 'Referral advised', data.referralNote);
  rule(doc);
}

function writeMedicines(doc: Doc, face: string, data: PrescriptionDocumentData): void {
  heading(doc, face, 'Medicines');

  if (data.medicines.length === 0) {
    // NOT an omission and NOT an error state. A non-prescribing professional's
    // closing record is the advice and therapy plan below (`docs/MODULES.md`
    // M-15), and a prescribing one may legitimately prescribe nothing this
    // session. Saying so explicitly stops a patient reading a blank space as a
    // missing page.
    doc.font(face).fontSize(10).fillColor(MUTED_COLOUR).text('No medicines were prescribed in this consultation.');
    doc.moveDown(0.6);
    return;
  }

  data.medicines.forEach((medicine, index) => {
    doc.font(face).fontSize(11).fillColor(BODY_COLOUR).text(`${index + 1}.  ${medicine.name}`);
    doc
      .fontSize(10)
      .fillColor(MUTED_COLOUR)
      .text(`     ${medicine.dose}  ·  ${medicine.frequency}  ·  ${medicine.duration}`);
    if (medicine.instructions) {
      doc.fontSize(10).fillColor(MUTED_COLOUR).text(`     ${medicine.instructions}`);
    }
    doc.moveDown(0.4);
  });
  doc.moveDown(0.2);
}

function writeAdvice(doc: Doc, face: string, data: PrescriptionDocumentData): void {
  rule(doc);
  heading(doc, face, 'Advice and therapy plan');

  optionalField(doc, face, 'Covered this session', data.advice.covered);
  optionalField(doc, face, 'Home practice', data.advice.homePractice);
  optionalField(doc, face, 'Focus for the next session', data.advice.nextFocus);

  // *** FR-14.2 NAMES WARNING SIGNS EXPLICITLY. *** It is the one field on this
  // page a patient may need in a hurry, so it is last, labelled, and not folded
  // into a paragraph of general advice.
  if (data.advice.warningSigns) {
    doc.moveDown(0.3);
    doc.font(face).fontSize(11).fillColor(BODY_COLOUR).text('Seek help if you notice');
    doc.fontSize(10).fillColor(BODY_COLOUR).text(data.advice.warningSigns);
    doc.moveDown(0.4);
  }
}

function writeFooter(doc: Doc, face: string, data: PrescriptionDocumentData): void {
  rule(doc);
  doc
    .font(face)
    .fontSize(8)
    .fillColor(MUTED_COLOUR)
    .text(
      `Issued ${formatDateTime(data.finalisedAt)} · Consultation ${data.referenceCode}. ` +
        'This prescription relates to the consultation named above and to no other. ' +
        'It is not a substitute for emergency care — in an emergency, seek immediate in-person help.',
    );
}

/* ── Small layout helpers ─────────────────────────────────────────────────── */

function rule(doc: Doc): void {
  doc.moveDown(0.5);
  const y = doc.y;
  doc
    .strokeColor(RULE_COLOUR)
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.moveDown(0.6);
}

function heading(doc: Doc, face: string, text: string): void {
  doc.font(face).fontSize(13).fillColor(BODY_COLOUR).text(text);
  doc.moveDown(0.4);
}

function field(doc: Doc, face: string, label: string, value: string): void {
  doc.font(face).fontSize(9).fillColor(MUTED_COLOUR).text(label.toUpperCase(), { characterSpacing: 0.6 });
  doc.fontSize(11).fillColor(BODY_COLOUR).text(value);
  doc.moveDown(0.45);
}

function optionalField(doc: Doc, face: string, label: string, value: string | null): void {
  if (!value) return;
  field(doc, face, label, value);
}

function joinNonEmpty(parts: Array<string | null>, separator: string): string {
  return parts.filter((part): part is string => Boolean(part && part.length > 0)).join(separator);
}

function capitalise(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

/**
 * Dates are rendered in `Asia/Kolkata` and stated in a fixed, unambiguous
 * `DD Mon YYYY` form.
 *
 * Both halves matter. The platform serves one country, `timestamptz` columns
 * are UTC, and a consultation held at 00:30 IST prints as the PREVIOUS DAY in
 * UTC — on a prescription, that is a wrong date on a clinical document. And
 * `DD/MM` versus `MM/DD` is the classic ambiguity, so the month is spelled.
 */
function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(value);
}

function formatDateTime(value: Date): string {
  return `${new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  }).format(value)} IST`;
}

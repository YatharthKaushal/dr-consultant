import { BadRequestException } from '@nestjs/common';
import { CLINICAL_ERROR_CODES, MAX_MEDICINE_LINES, MEDICINE_FIELD_LIMITS } from './clinical.constants';
import type { ClinicalMedicine } from './clinical.contract';

/**
 * *** WHY THIS EXISTS WHEN `clinical.dto.ts` ALREADY VALIDATES MEDICINES. ***
 *
 * `medicines` reaches this module by THREE routes, and only one of them passes
 * through a DTO:
 *
 *   1. `PUT /consultations/:id/clinical-record` — a `MedicineLineDto[]`,
 *      validated by class-validator. This is the route people think of.
 *   2. Applying a `doctor_clinical_templates` row — `jsonb`, typed
 *      `$type<unknown[]>()`, read straight out of Postgres. NO DTO, and the
 *      row may predate any tightening of the rules above.
 *   3. Applying `specialties.prescription_template` (M-06, admin-authored) —
 *      `jsonb` again, written by a different module entirely.
 *
 * `backend/README.md` §2 puts the rules in the service, not the HTTP layer, and
 * routes 2 and 3 are exactly why: a validator that only guards the controller
 * guards one of three doors. This function is the one all three go through.
 *
 * It also NORMALISES: trims every field, and drops `instructions` when it is
 * blank rather than storing `""`, so a record and a template built from the
 * same lines are byte-identical in `jsonb` and the PDF never renders an empty
 * instruction line.
 */
export function parseMedicineLines(raw: unknown, source: 'request' | 'template' | 'specialty_template'): ClinicalMedicine[] {
  if (raw === null || raw === undefined) return [];

  if (!Array.isArray(raw)) {
    throw invalidMedicineLine(`medicines must be an array (from ${source}).`);
  }
  if (raw.length > MAX_MEDICINE_LINES) {
    throw invalidMedicineLine(`A prescription may not carry more than ${MAX_MEDICINE_LINES} medicine lines.`);
  }

  return raw.map((entry, index) => parseOne(entry, index, source));
}

function parseOne(entry: unknown, index: number, source: string): ClinicalMedicine {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw invalidMedicineLine(`medicines[${index}] must be an object (from ${source}).`);
  }

  const record = entry as Record<string, unknown>;
  const line: ClinicalMedicine = {
    name: requiredField(record.name, 'name', index, MEDICINE_FIELD_LIMITS.NAME, source),
    dose: requiredField(record.dose, 'dose', index, MEDICINE_FIELD_LIMITS.DOSE, source),
    frequency: requiredField(record.frequency, 'frequency', index, MEDICINE_FIELD_LIMITS.FREQUENCY, source),
    duration: requiredField(record.duration, 'duration', index, MEDICINE_FIELD_LIMITS.DURATION, source),
  };

  const instructions = optionalField(record.instructions, 'instructions', index, MEDICINE_FIELD_LIMITS.INSTRUCTIONS, source);
  if (instructions !== null) line.instructions = instructions;

  return line;
}

function requiredField(value: unknown, field: string, index: number, max: number, source: string): string {
  if (typeof value !== 'string') {
    throw invalidMedicineLine(`medicines[${index}].${field} is required and must be a string (from ${source}).`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidMedicineLine(`medicines[${index}].${field} must not be blank (from ${source}).`);
  }
  if (trimmed.length > max) {
    throw invalidMedicineLine(`medicines[${index}].${field} must be ${max} characters or fewer (from ${source}).`);
  }
  return trimmed;
}

function optionalField(value: unknown, field: string, index: number, max: number, source: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalidMedicineLine(`medicines[${index}].${field} must be a string when present (from ${source}).`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw invalidMedicineLine(`medicines[${index}].${field} must be ${max} characters or fewer (from ${source}).`);
  }
  return trimmed;
}

export function invalidMedicineLine(message: string): BadRequestException {
  return new BadRequestException({ code: CLINICAL_ERROR_CODES.MEDICINE_LINE_INVALID, message });
}

/**
 * Trims free text and collapses "" / "   " to `null`.
 *
 * *** THE COMPLETION GATE DEPENDS ON THIS. *** `case_summary` and the four
 * `advice_*` columns are all nullable text, so without normalisation a doctor
 * could satisfy FR-11.3 by submitting a single space — the field would be
 * non-null, the gate would pass, and the record would close with a blank
 * summary. Blank is stored as NULL, and NULL is what the gate refuses.
 */
export function normaliseText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

import type { ClinicalRecordRow } from '../../schema/clinical-records.schema';
import type { DoctorClinicalTemplateRow } from '../../schema/doctor-clinical-templates.schema';
import type { ConsultationAuditRow } from './clinical.repository';
import type {
  ClinicalAdvice,
  ClinicalAuditEntryView,
  ClinicalCarePlanView,
  ClinicalMedicine,
  ClinicalRecordView,
} from './clinical.contract';
import { parseMedicineLines } from './clinical-medicine.util';

/**
 * One doctor's saved template, as returned to that doctor.
 *
 * `doctorId` is deliberately NOT copied out: every route that can produce one
 * of these is already scoped to `@CurrentUser()`, and echoing an account id
 * into a response body is how one leaks — the same reasoning
 * `instant.mapper.ts` gives for keeping `doctorId` out of a stream payload.
 */
export interface ClinicalTemplateView {
  id: string;
  specialtyId: string | null;
  name: string;
  medicines: ClinicalMedicine[];
  advice: ClinicalAdvice;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `clinical_records` row -> the public view.
 *
 * The four flat `advice_*` columns are folded into ONE `advice` object. They
 * are stored flat because `doctor_clinical_templates` is deliberately a
 * field-for-field subset of this table (see that schema's header) and a nested
 * jsonb column would have broken that; they are RETURNED nested because every
 * consumer — the PDF, M-16's Care Plan, the doctor's form — treats them as one
 * therapy plan rather than four unrelated strings.
 *
 * `medicines` is re-parsed rather than cast. It is `jsonb` typed
 * `$type<unknown[]>()`, so what comes back from Postgres is genuinely unknown
 * at the type level, and a row written before a rule tightened is exactly the
 * case a cast would hide. See `clinical-medicine.util.ts`.
 */
export function toClinicalRecordView(row: ClinicalRecordRow): ClinicalRecordView {
  return {
    id: row.id,
    consultationId: row.consultationId,
    chiefComplaint: row.chiefComplaint,
    clinicalHistory: row.clinicalHistory,
    diagnosis: row.diagnosis,
    isDiagnosisProvisional: row.isDiagnosisProvisional,
    riskCategory: row.riskCategory,
    referralNote: row.referralNote,
    medicines: parseMedicineLines(row.medicines, 'template'),
    advice: toClinicalAdvice(row),
    caseSummary: row.caseSummary,
    finalisedAt: row.finalisedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The Care Plan projection M-16 reads. `null` for a draft — see `ClinicalCarePlanView`. */
export function toClinicalCarePlanView(row: ClinicalRecordRow): ClinicalCarePlanView | null {
  if (!row.finalisedAt) return null;
  return {
    consultationId: row.consultationId,
    medicines: parseMedicineLines(row.medicines, 'template'),
    advice: toClinicalAdvice(row),
    finalisedAt: row.finalisedAt,
  };
}

export function toClinicalTemplateView(row: DoctorClinicalTemplateRow): ClinicalTemplateView {
  return {
    id: row.id,
    specialtyId: row.specialtyId,
    name: row.name,
    medicines: parseMedicineLines(row.medicines, 'template'),
    advice: toClinicalAdvice(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The shared shape between a record and a template — the "field-for-field
 * subset" `doctor-clinical-templates.schema.ts` describes, expressed once so
 * applying a template really is a copy with no mapping layer.
 */
export function toClinicalAdvice(row: {
  adviceCovered: string | null;
  adviceHomePractice: string | null;
  adviceNextFocus: string | null;
  adviceWarningSigns: string | null;
}): ClinicalAdvice {
  return {
    covered: row.adviceCovered,
    homePractice: row.adviceHomePractice,
    nextFocus: row.adviceNextFocus,
    warningSigns: row.adviceWarningSigns,
  };
}

/** `audit_log` row -> the FR-11.6 trail view. `ipAddress` is dropped here, not selected and then deleted — see `ClinicalAuditEntryView`. */
export function toClinicalAuditEntryView(row: ConsultationAuditRow): ClinicalAuditEntryView {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

import type { PatientFileCategory } from '../../schema/enums.schema';

/** One `patient_files` row, as seen from OUTSIDE this module — never carries `storageKey` (`patient-files.schema.ts`: "never exposed to the client", which applies equally to another module reaching through the facade). */
export interface PatientFileView {
  id: string;
  fileCategory: PatientFileCategory;
  patientId: string | null;
  uploadedByDoctorId: string | null;
  consultationId: string | null;
  reportRequestId: string | null;
  clarificationCaseId: string | null;
  fileName: string;
  createdAt: Date;
}

/**
 * Document's public surface — deliberately ONE method today, same restraint
 * as `catalogue.contract.ts`/`availability.contract.ts`: `getPatientFileById`
 * is the read a near-term consumer would plausibly need first — M-15
 * (clinical records) or M-11 (booking) resolving a document reference by id
 * without needing to know this module's internal row shape or storage key.
 *
 * Nothing else is exposed. In particular, no write method exists here yet
 * for "a future M-15 will write [prescription_pdf] through your facade, not
 * through HTTP" (`docs/MODULES.md`'s M-10 section) — that is a documented
 * INTENTION for when M-15 exists and has a real, specific shape to ask for,
 * not something to build speculatively now. Same restraint this module
 * applies to the de-identified clarification-attachment path; see
 * `report-request.service.ts`'s header comment.
 */
export interface DocumentContract {
  /** One file by id, or `null` if it does not exist or is soft-deleted. No ownership check — this is a trusted module-to-module call; the CALLING module is responsible for its own authorization before deciding to call it, same as `AvailabilityContract`'s methods carry no auth checks either. */
  getPatientFileById(fileId: string): Promise<PatientFileView | null>;
}

/** `audit_log.entity_type` values this module writes. */
export const DOCTOR_AUDIT_ENTITY_TYPES = {
  DOCTOR: 'doctor',
  DOCTOR_SPECIALTY: 'doctor_specialty',
  DOCTOR_DOCUMENT: 'doctor_document',
} as const;

export const DOCTOR_ERROR_CODES = {
  DOCTOR_NOT_FOUND: 'DOCTOR_NOT_FOUND',
  MOBILE_NUMBER_TAKEN: 'MOBILE_NUMBER_TAKEN',
  REGISTRATION_NUMBER_TAKEN: 'REGISTRATION_NUMBER_TAKEN',
  SPECIALTY_NOT_FOUND: 'SPECIALTY_NOT_FOUND',
  DOCTOR_SPECIALTY_NOT_FOUND: 'DOCTOR_SPECIALTY_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  /** Structural enforcement of "an unapproved doctor cannot use the doctor experience" (MODULES.md M-05 done-when bar). */
  CANNOT_LIST_UNVERIFIED_DOCTOR: 'CANNOT_LIST_UNVERIFIED_DOCTOR',
  REJECTION_REASON_REQUIRED: 'REJECTION_REASON_REQUIRED',
} as const;
export type DoctorErrorCode = (typeof DOCTOR_ERROR_CODES)[keyof typeof DOCTOR_ERROR_CODES];

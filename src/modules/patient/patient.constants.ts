/** `audit_log.entity_type` values this module writes. */
export const PATIENT_AUDIT_ENTITY_TYPES = {
  PATIENT: 'patient',
} as const;

export const PATIENT_ERROR_CODES = {
  PATIENT_NOT_FOUND: 'PATIENT_NOT_FOUND',
} as const;
export type PatientErrorCode = (typeof PATIENT_ERROR_CODES)[keyof typeof PATIENT_ERROR_CODES];

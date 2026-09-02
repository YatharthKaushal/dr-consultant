/** `audit_log.entity_type` values this module writes. */
export const CATALOGUE_AUDIT_ENTITY_TYPES = {
  SPECIALTY: 'specialty',
  CONCERN: 'concern',
} as const;

export const CATALOGUE_ERROR_CODES = {
  SPECIALTY_NOT_FOUND: 'SPECIALTY_NOT_FOUND',
  SPECIALTY_CODE_TAKEN: 'SPECIALTY_CODE_TAKEN',
  /** `specialties_prescription_template_check` — flipping `canPrescribe` to false while `prescriptionTemplate` is still set is refused, not auto-cleared. See `specialty.service.ts`. */
  CANNOT_DISABLE_PRESCRIBING_WITH_TEMPLATE_SET: 'CANNOT_DISABLE_PRESCRIBING_WITH_TEMPLATE_SET',
  /** Same CHECK constraint, the other direction: a non-null `prescriptionTemplate` on a specialty whose `canPrescribe` is currently false. */
  TEMPLATE_REQUIRES_PRESCRIBING: 'TEMPLATE_REQUIRES_PRESCRIBING',
  CONCERN_NOT_FOUND: 'CONCERN_NOT_FOUND',
  CONCERN_CODE_TAKEN: 'CONCERN_CODE_TAKEN',
} as const;
export type CatalogueErrorCode = (typeof CATALOGUE_ERROR_CODES)[keyof typeof CATALOGUE_ERROR_CODES];

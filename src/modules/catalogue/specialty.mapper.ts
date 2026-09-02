import type { SpecialtyRow } from '../../schema/specialties.schema';
import type { PublicSpecialty } from './catalogue.contract';

/**
 * Strips `prescriptionTemplate`/`adviceTemplate` (admin-authored clinical
 * starter content for a doctor documenting a consultation — not something a
 * browsing patient/doctor or another module's "what can I book" read needs)
 * and the `createdAt`/`updatedAt` audit columns. The admin surface
 * (`specialty-admin.controller.ts`) returns the full `SpecialtyRow` instead —
 * an admin editing templates needs to see them.
 */
export function toPublicSpecialty(row: SpecialtyRow): PublicSpecialty {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    canPrescribe: row.canPrescribe,
    intakeForm: row.intakeForm,
    firstConsultForm: row.firstConsultForm,
    requiredDocuments: row.requiredDocuments,
    isActive: row.isActive,
  };
}

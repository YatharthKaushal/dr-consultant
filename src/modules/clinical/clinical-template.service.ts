import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { AuditService } from '../../shared/audit/audit.service';
import type { DoctorClinicalTemplateRow } from '../../schema/doctor-clinical-templates.schema';
import { DoctorFacade } from '../doctor/doctor.facade';
import { CLINICAL_AUDIT_ENTITY_TYPES, CLINICAL_ERROR_CODES } from './clinical.constants';
import type { SaveClinicalTemplateDto } from './clinical.dto';
import { normaliseText, parseMedicineLines } from './clinical-medicine.util';
import { ClinicalTemplateRepository } from './clinical-template.repository';
import { toClinicalTemplateView, type ClinicalTemplateView } from './clinical.mapper';

/**
 * FR-9.6: "the doctor can save and reuse prescription templates to cut
 * consultation time."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** THE PRESCRIBING GATE HERE READS A DIFFERENT SOURCE, ON PURPOSE. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `clinical.service.ts` gates medicines on
 * `consultations.specialty_id -> specialties.can_prescribe`, and its header
 * explains at length why nothing else will do THERE.
 *
 * A personal template has NO CONSULTATION. There is nothing to snapshot from,
 * so the question "may this doctor write a medicine line at all?" has to be
 * answered from the doctor themselves — which is exactly what
 * `DoctorContract.getPrescribingEligibility` is for, and exactly what its own
 * doc comment says: "this is for contexts with NO per-consultation specialty
 * snapshot — e.g. gating a doctor's own personal `doctor_clinical_templates`
 * (M-15, FR-9.6), where there is no consultation to snapshot from."
 *
 * The two checks are not redundant and neither replaces the other. This one
 * stops a counsellor from ever authoring a template with medicines in it; the
 * consultation-level one stops ANY template's medicines from landing in a
 * record whose booked specialty cannot prescribe — including a psychiatrist's
 * own template applied to a counselling consultation, which this check cannot
 * see and would happily allow.
 *
 * `doctor-clinical-templates.schema.ts` warns against re-deriving the
 * prescribing gate from the template's own `specialty_id` column, and this does
 * not: that column is an optional CONTEXT TAG for the picker, and the gate is
 * never read from it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** NO `diagnosis`, NO `chief_complaint`. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The table has neither column, `SaveClinicalTemplateDto` has neither field,
 * and `ClinicalService.applyTemplate` copies neither. From that schema's own
 * header: "a pre-fillable diagnosis is a clinical-safety hazard, not a
 * convenience, and must be written fresh every consultation." Three layers say
 * the same thing, and the innermost one is the table.
 */
@Injectable()
export class ClinicalTemplateService {
  constructor(
    private readonly repo: ClinicalTemplateRepository,
    private readonly doctors: DoctorFacade,
    private readonly audit: AuditService,
  ) {}

  /** The picker (FR-9.6), ordered `updated_at desc` — see the repository for why there is no usage counter. */
  async listOwn(doctorId: string, specialtyId?: string): Promise<ClinicalTemplateView[]> {
    const rows = await this.repo.listForDoctor(doctorId, specialtyId);
    return rows.map(toClinicalTemplateView);
  }

  async getOwn(templateId: string, doctorId: string): Promise<ClinicalTemplateView> {
    return toClinicalTemplateView(await this.requireOwnTemplateRow(templateId, doctorId));
  }

  async create(doctorId: string, dto: SaveClinicalTemplateDto): Promise<ClinicalTemplateView> {
    const medicines = parseMedicineLines(dto.medicines, 'request');
    await this.assertMedicinesPermittedForDoctor(doctorId, medicines.length);
    await this.assertSpecialtyPractised(doctorId, dto.specialtyId);

    const row = await this.guardConstraints(() =>
      this.repo.create({
        doctorId,
        specialtyId: dto.specialtyId ?? null,
        name: dto.name.trim(),
        medicines,
        adviceCovered: normaliseText(dto.adviceCovered),
        adviceHomePractice: normaliseText(dto.adviceHomePractice),
        adviceNextFocus: normaliseText(dto.adviceNextFocus),
        adviceWarningSigns: normaliseText(dto.adviceWarningSigns),
      }),
    );

    await this.writeAudit('create', doctorId, row, medicines.length);
    return toClinicalTemplateView(row);
  }

  /** `PUT` semantics, like the record itself: the body is the complete template, so an omitted field is cleared rather than preserved. */
  async update(templateId: string, doctorId: string, dto: SaveClinicalTemplateDto): Promise<ClinicalTemplateView> {
    await this.requireOwnTemplateRow(templateId, doctorId);

    const medicines = parseMedicineLines(dto.medicines, 'request');
    await this.assertMedicinesPermittedForDoctor(doctorId, medicines.length);
    await this.assertSpecialtyPractised(doctorId, dto.specialtyId);

    const row = await this.guardConstraints(() =>
      this.repo.updateForDoctor(templateId, doctorId, {
        specialtyId: dto.specialtyId ?? null,
        name: dto.name.trim(),
        medicines,
        adviceCovered: normaliseText(dto.adviceCovered),
        adviceHomePractice: normaliseText(dto.adviceHomePractice),
        adviceNextFocus: normaliseText(dto.adviceNextFocus),
        adviceWarningSigns: normaliseText(dto.adviceWarningSigns),
      }),
    );
    if (!row) throw templateNotFound();

    await this.writeAudit('update', doctorId, row, medicines.length);
    return toClinicalTemplateView(row);
  }

  /** Hard delete — nothing references a template row, because applying one is a copy (`doctor-clinical-templates.schema.ts`). */
  async remove(templateId: string, doctorId: string): Promise<void> {
    const existing = await this.requireOwnTemplateRow(templateId, doctorId);

    const deleted = await this.repo.deleteForDoctor(templateId, doctorId);
    if (!deleted) throw templateNotFound();

    await this.audit.write({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'delete',
      entityType: CLINICAL_AUDIT_ENTITY_TYPES.DOCTOR_CLINICAL_TEMPLATE,
      entityId: templateId,
      metadata: { name: existing.name },
    });
  }

  /**
   * The owner-scoped row read, shared with `ClinicalService.applyTemplate`.
   *
   * Returns the ROW rather than the view because applying a template is a
   * field-for-field copy into `clinical_records`, and going through a view and
   * back would be exactly the mapping layer the schema says should not exist.
   */
  async requireOwnTemplateRow(templateId: string, doctorId: string): Promise<DoctorClinicalTemplateRow> {
    const row = await this.repo.findByIdForDoctor(templateId, doctorId);
    if (!row) throw templateNotFound();
    return row;
  }

  /* ── Gates ────────────────────────────────────────────────────────────── */

  /** See the class header for why this is `getPrescribingEligibility` and the record path is not. */
  private async assertMedicinesPermittedForDoctor(doctorId: string, medicineCount: number): Promise<void> {
    if (medicineCount === 0) return;

    if (!(await this.doctors.getPrescribingEligibility(doctorId))) {
      throw new ConflictException({
        code: CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
        message:
          'Your specialty does not allow prescribing, so a template cannot contain medicines. Save an advice and therapy-plan template instead.',
      });
    }
  }

  /**
   * `doctor_clinical_templates` carries a COMPOSITE foreign key to
   * `(doctor_specialties.doctor_id, specialty_id)`, so tagging a template with
   * a specialty the doctor does not practise is refused by the database
   * regardless of what this method does.
   *
   * Checked here first anyway, through `DoctorFacade` rather than by reading
   * M-05's table, so the doctor gets a 409 that says what is wrong instead of a
   * driver error. `guardConstraints` still catches the residual race — an admin
   * removing the specialty between this read and the write.
   */
  private async assertSpecialtyPractised(doctorId: string, specialtyId: string | undefined): Promise<void> {
    if (!specialtyId) return;

    const profile = await this.doctors.getPublicProfile(doctorId);
    if (!profile?.specialties.some((specialty) => specialty.id === specialtyId)) {
      throw specialtyNotPractised();
    }
  }

  /* ── Plumbing ─────────────────────────────────────────────────────────── */

  private async writeAudit(
    action: 'create' | 'update',
    doctorId: string,
    row: DoctorClinicalTemplateRow,
    medicineCount: number,
  ): Promise<void> {
    await this.audit.write({
      actorType: 'doctor',
      actorId: doctorId,
      action,
      entityType: CLINICAL_AUDIT_ENTITY_TYPES.DOCTOR_CLINICAL_TEMPLATE,
      entityId: row.id,
      // NO `consultationId` — a template belongs to a doctor, not to a
      // consultation. Every OTHER audit row this module writes carries one
      // (`clinical.constants.ts`); this is the one entity for which there is no
      // consultation to carry, and inventing one would corrupt the FR-11.6
      // trail rather than enrich it.
      metadata: { name: row.name, medicineCount, specialtyId: row.specialtyId },
    });
  }

  /**
   * Turns the two constraints this table carries into this module's own error
   * vocabulary:
   *
   *   `uniqueIndex().on(doctorId, name)`     -> 409 TEMPLATE_NAME_TAKEN
   *   the composite doctor/specialty FK      -> 409 TEMPLATE_SPECIALTY_NOT_PRACTISED
   *
   * Both are safety nets under a check that already ran, for the concurrent
   * case the check cannot cover — the same reasoning
   * `postgres-error.util.ts` gives for existing everywhere else.
   */
  private async guardConstraints<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw templateNameTaken();
      if (isForeignKeyViolation(error)) throw specialtyNotPractised();
      throw error;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** One code for "does not exist" and "belongs to another doctor" — the caller cannot distinguish them, and must not be able to. */
export function templateNotFound(): NotFoundException {
  return new NotFoundException({ code: CLINICAL_ERROR_CODES.TEMPLATE_NOT_FOUND, message: 'Template not found.' });
}

export function templateNameTaken(): ConflictException {
  return new ConflictException({
    code: CLINICAL_ERROR_CODES.TEMPLATE_NAME_TAKEN,
    message: 'You already have a template with that name.',
  });
}

export function specialtyNotPractised(): ConflictException {
  return new ConflictException({
    code: CLINICAL_ERROR_CODES.TEMPLATE_SPECIALTY_NOT_PRACTISED,
    message: 'A template can only be tagged with a specialty you practise.',
  });
}

/**
 * Postgres `23503`, walking the `cause` chain.
 *
 * Duck-typed and walked exactly as `postgres-error.util.ts#isUniqueConstraint
 * Violation` is, and for the same discovered reason: Drizzle 0.45 wraps the
 * driver's error in a `DrizzleQueryError` whose own `code` is `undefined` and
 * hangs the real `pg` `DatabaseError` off `.cause`, so a top-level-only check
 * matches nothing.
 *
 * Deliberately LOCAL to this module rather than added to `shared/errors`.
 * `doctor_clinical_templates`'s composite FK is the only place in the codebase
 * that needs it today, `src/shared` is edited by every parallel worktree at
 * once, and a one-consumer helper does not earn a shared-file conflict. Promote
 * it the moment a second module needs it.
 */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23503') return true;
    if (!('cause' in current)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

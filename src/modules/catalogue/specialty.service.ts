import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import type { CreateSpecialtyDto, UpdateSpecialtyDto, UpdateSpecialtyTemplatesDto } from './specialty-admin.dto';
import { CATALOGUE_AUDIT_ENTITY_TYPES, CATALOGUE_ERROR_CODES } from './catalogue.constants';
import type { PublicSpecialty } from './catalogue.contract';
import { toPublicSpecialty } from './specialty.mapper';
import type { SpecialtyRow } from '../../schema/specialties.schema';
import {
  SpecialtyRepository,
  type SpecialtyGeneralFieldsUpdate,
  type SpecialtyTemplatesUpdate,
} from './specialty.repository';

/** Shared 404 shape — also used by `concern.service.ts` when validating a `specialtyId`. */
export function specialtyNotFound(): NotFoundException {
  return new NotFoundException({ code: CATALOGUE_ERROR_CODES.SPECIALTY_NOT_FOUND, message: 'Specialty not found.' });
}

/**
 * `specialties` entity operations: admin CRUD (general fields + the
 * separately-permissioned clinical-templates fields) and the public/
 * contract-backing reads. Mirrors `doctor.service.ts`'s split — the
 * "field-group has its own permission, its own endpoint, its own service
 * method" pattern from `doctor-verification.service.ts` is followed here for
 * the templates group specifically, rather than a whole separate file,
 * because there is only one such group (contrast with doctor's four).
 */
@Injectable()
export class SpecialtyService {
  constructor(
    private readonly repo: SpecialtyRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Admin CRUD (admin/specialties)                                          */
  /* ---------------------------------------------------------------------- */

  async adminList(): Promise<SpecialtyRow[]> {
    return this.repo.list();
  }

  async adminGetById(id: string): Promise<SpecialtyRow> {
    const specialty = await this.repo.findById(id);
    if (!specialty) throw specialtyNotFound();
    return specialty;
  }

  /** Rejects a duplicate `code` cleanly (409) — same check-first pattern as `doctor.service.ts#adminCreate`'s duplicate-mobile check. */
  async adminCreate(actingAdminId: string, dto: CreateSpecialtyDto): Promise<SpecialtyRow> {
    const existing = await this.repo.findByCode(dto.code);
    if (existing) {
      throw new ConflictException({
        code: CATALOGUE_ERROR_CODES.SPECIALTY_CODE_TAKEN,
        message: 'A specialty with this code already exists.',
      });
    }

    const specialty = await this.repo.create({
      code: dto.code,
      name: dto.name,
      description: dto.description,
      canPrescribe: dto.canPrescribe,
      intakeForm: dto.intakeForm,
      firstConsultForm: dto.firstConsultForm,
      requiredDocuments: dto.requiredDocuments,
    });

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'create',
      entityType: CATALOGUE_AUDIT_ENTITY_TYPES.SPECIALTY,
      entityId: specialty.id,
      metadata: { after: this.definedFieldsOnly(dto) },
    });
    return specialty;
  }

  /**
   * Edits name/description/canPrescribe/intakeForm/firstConsultForm/
   * requiredDocuments/isActive. Deliberately does NOT touch
   * `prescriptionTemplate`/`adviceTemplate` — see `adminUpdateTemplates`.
   *
   * The `specialties_prescription_template_check` CHECK constraint (`can_
   * prescribe OR prescription_template IS NULL`) is enforced here BEFORE the
   * write, not left for Postgres to reject: flipping `canPrescribe` to
   * `false` while `prescriptionTemplate` is currently non-null is REJECTED
   * (409), not silently cleared. `prescriptionTemplate` is admin-authored
   * clinical content (the medicine starter list a doctor applies while
   * documenting) — silently discarding it as a side effect of an unrelated
   * toggle would be a surprising, unrecoverable loss. The admin must
   * explicitly clear it via `PATCH .../templates` first; that is then an
   * intentional, audited action of its own, not a side effect buried inside
   * this one. (Contrast with `doctor-verification.service.ts#setVerification
   * Status`, which DOES force a dependent field in the same update — there
   * `isListed` is a boolean flag with no content to lose.)
   *
   * Skips the update AND the audit write entirely when the DTO carries no
   * defined fields — same discipline as `doctor.service.ts#adminUpdate
   * ProfileFields`.
   */
  async adminUpdate(actingAdminId: string, id: string, dto: UpdateSpecialtyDto): Promise<SpecialtyRow> {
    const specialty = await this.repo.findById(id);
    if (!specialty) throw specialtyNotFound();

    const fields = this.definedFieldsOnly(dto);
    if (Object.keys(fields).length === 0) {
      return specialty;
    }

    if (fields.canPrescribe === false && specialty.prescriptionTemplate !== null) {
      throw new ConflictException({
        code: CATALOGUE_ERROR_CODES.CANNOT_DISABLE_PRESCRIBING_WITH_TEMPLATE_SET,
        message:
          'This specialty still has a prescription template set. Clear it via PATCH .../templates before disabling prescribing.',
      });
    }

    const before = this.extractBefore(specialty, fields);
    const updated = await this.repo.updateGeneralFields(id, fields);
    if (!updated) throw specialtyNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: CATALOGUE_AUDIT_ENTITY_TYPES.SPECIALTY,
      entityId: id,
      metadata: { before, after: fields },
    });
    return updated;
  }

  /**
   * `prescriptionTemplate`/`adviceTemplate` ONLY. Re-reads the specialty
   * fresh (not a value the caller could have cached) so the `canPrescribe`
   * check below is always against current state, not a stale one. Setting a
   * non-null `prescriptionTemplate` while `canPrescribe` is currently
   * `false` is rejected (409) — the same CHECK constraint, the other
   * direction from `adminUpdate`'s. Setting it to `null` is always allowed
   * (clearing is never invalid).
   */
  async adminUpdateTemplates(actingAdminId: string, id: string, dto: UpdateSpecialtyTemplatesDto): Promise<SpecialtyRow> {
    const specialty = await this.repo.findById(id);
    if (!specialty) throw specialtyNotFound();

    const fields: SpecialtyTemplatesUpdate = {};
    if (dto.prescriptionTemplate !== undefined) fields.prescriptionTemplate = dto.prescriptionTemplate;
    if (dto.adviceTemplate !== undefined) fields.adviceTemplate = dto.adviceTemplate;

    if (Object.keys(fields).length === 0) {
      return specialty;
    }

    if (fields.prescriptionTemplate != null && !specialty.canPrescribe) {
      throw new ConflictException({
        code: CATALOGUE_ERROR_CODES.TEMPLATE_REQUIRES_PRESCRIBING,
        message: 'This specialty does not allow prescribing — enable canPrescribe before setting a prescription template.',
      });
    }

    const before = this.extractBefore(specialty, fields);
    const updated = await this.repo.updateTemplates(id, fields);
    if (!updated) throw specialtyNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: CATALOGUE_AUDIT_ENTITY_TYPES.SPECIALTY,
      entityId: id,
      metadata: { before, after: fields },
    });
    return updated;
  }

  /* ---------------------------------------------------------------------- */
  /* Public read (GET /specialties, GET /specialties/:id)                    */
  /* ---------------------------------------------------------------------- */

  /** Active specialties only, regardless of caller — the admin panel uses `adminList` for the full set. */
  async listActive(): Promise<PublicSpecialty[]> {
    const rows = await this.repo.listActive();
    return rows.map(toPublicSpecialty);
  }

  /**
   * 404 (never 403) when the specialty doesn't exist OR is inactive and the
   * caller isn't an admin — a 403 would confirm a disabled specialty's
   * existence to a patient/doctor. Same reasoning `doctor.controller.ts`'s
   * `GET /doctors/:id` already uses for unlisted doctors.
   */
  async getByIdForCaller(id: string, auth: AuthContext): Promise<PublicSpecialty> {
    const specialty = await this.repo.findById(id);
    if (!specialty) throw specialtyNotFound();

    const visible = auth.accountType === 'admin' || specialty.isActive;
    if (!visible) throw specialtyNotFound();

    return toPublicSpecialty(specialty);
  }

  /* ---------------------------------------------------------------------- */
  /* Contract-backing reads (catalogue.facade.ts)                            */
  /* ---------------------------------------------------------------------- */

  /** Used internally by `concern.service.ts` to validate a `specialtyId` exists. */
  async findRawById(id: string): Promise<SpecialtyRow | null> {
    return this.repo.findById(id);
  }

  async getPublicById(id: string): Promise<PublicSpecialty | null> {
    const specialty = await this.repo.findById(id);
    return specialty ? toPublicSpecialty(specialty) : null;
  }

  private definedFieldsOnly(dto: CreateSpecialtyDto | UpdateSpecialtyDto): SpecialtyGeneralFieldsUpdate {
    const fields: SpecialtyGeneralFieldsUpdate = {};
    if (dto.name !== undefined) fields.name = dto.name;
    if (dto.description !== undefined) fields.description = dto.description;
    if (dto.canPrescribe !== undefined) fields.canPrescribe = dto.canPrescribe;
    if (dto.intakeForm !== undefined) fields.intakeForm = dto.intakeForm;
    if (dto.firstConsultForm !== undefined) fields.firstConsultForm = dto.firstConsultForm;
    if (dto.requiredDocuments !== undefined) fields.requiredDocuments = dto.requiredDocuments;
    if ('isActive' in dto && dto.isActive !== undefined) fields.isActive = dto.isActive;
    return fields;
  }

  private extractBefore(row: SpecialtyRow, fields: object): Record<string, unknown> {
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      before[key] = (row as unknown as Record<string, unknown>)[key];
    }
    return before;
  }
}

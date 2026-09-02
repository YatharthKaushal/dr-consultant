import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { AuditService } from '../../shared/audit/audit.service';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { AssignDoctorSpecialtyDto } from './doctor-admin.dto';
import { DoctorSpecialtyRepository } from './doctor-specialty.repository';
import { DOCTOR_AUDIT_ENTITY_TYPES, DOCTOR_ERROR_CODES } from './doctor.constants';
import type { DoctorSpecialtyWithDetails } from './doctor.mapper';
import { doctorNotFound } from './doctor.service';
import { DoctorRepository } from './doctor.repository';

/** `doctor_specialties` assignment, including the primary-swap transaction, plus the `getPrescribingEligibility` contract read. `code`/`name`/`canPrescribe` come from `CatalogueFacade` — this module never reads `specialties` directly. */
@Injectable()
export class DoctorSpecialtyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly doctorRepo: DoctorRepository,
    private readonly repo: DoctorSpecialtyRepository,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueFacade,
  ) {}

  /**
   * Idempotent: already-assigned with the same `isPrimary` flag is a no-op —
   * no update, no audit. Setting `isPrimary: true` runs the unset-old-
   * primary-then-set-new-primary sequence inside one transaction, respecting
   * `doctor_specialties_one_primary_idx` (at most one primary row per
   * doctor).
   */
  async assign(actingAdminId: string, doctorId: string, dto: AssignDoctorSpecialtyDto): Promise<DoctorSpecialtyWithDetails> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const specialty = await this.catalogue.getSpecialtyById(dto.specialtyId);
    if (!specialty) {
      throw new NotFoundException({ code: DOCTOR_ERROR_CODES.SPECIALTY_NOT_FOUND, message: 'Specialty not found.' });
    }

    const wantPrimary = dto.isPrimary ?? false;
    const existing = await this.repo.findByDoctorAndSpecialty(doctorId, dto.specialtyId);

    if (existing && existing.isPrimary === wantPrimary) {
      // Already assigned with the same primary flag — idempotent no-op.
      return { id: existing.id, specialtyId: specialty.id, code: specialty.code, name: specialty.name, isPrimary: existing.isPrimary };
    }

    return this.db.transaction(async (tx) => {
      if (wantPrimary) {
        await this.repo.clearPrimary(doctorId, tx);
      }

      const row = existing
        ? await this.repo.setPrimaryFlag(existing.id, wantPrimary, tx)
        : await this.repo.insert(doctorId, dto.specialtyId, wantPrimary, tx);
      if (!row) {
        // The doctor_specialties JUNCTION ROW vanished mid-transaction (e.g.
        // a concurrent `remove` deleted the row `setPrimaryFlag` targeted, or
        // the just-inserted row was concurrently removed before `insert`'s
        // `RETURNING` was read) — a genuine race, not the doctor itself
        // disappearing. `doctorNotFound()` would be misleading here; the
        // doctor row is confirmed to exist above.
        throw new NotFoundException({
          code: DOCTOR_ERROR_CODES.DOCTOR_SPECIALTY_NOT_FOUND,
          message: 'The doctor-specialty assignment was not found — it may have been removed concurrently.',
        });
      }

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: existing ? 'update' : 'create',
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_SPECIALTY,
          entityId: doctorId,
          metadata: { specialtyId: dto.specialtyId, isPrimary: wantPrimary },
        },
        tx,
      );

      return { id: row.id, specialtyId: specialty.id, code: specialty.code, name: specialty.name, isPrimary: row.isPrimary };
    });
  }

  /** Idempotent — a repeated remove of a specialty the doctor no longer holds is a no-op, no audit (same discipline as identity's RBAC `revokeRole`). */
  async remove(actingAdminId: string, doctorId: string, specialtyId: string): Promise<void> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const removed = await this.repo.remove(doctorId, specialtyId);
    if (!removed) {
      return;
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'delete',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_SPECIALTY,
      entityId: doctorId,
      metadata: { specialtyId },
    });
  }

  /**
   * Derived from the doctor's PRIMARY specialty's `canPrescribe` — `false`
   * when the doctor has no primary specialty or doesn't exist. See
   * `doctor.contract.ts`'s `getPrescribingEligibility` doc comment for the
   * important "not the per-consultation gate" caveat.
   */
  async getPrescribingEligibility(doctorId: string): Promise<boolean> {
    const primary = await this.repo.findPrimaryByDoctor(doctorId);
    if (!primary) return false;
    const specialty = await this.catalogue.getSpecialtyById(primary.specialtyId);
    return specialty?.canPrescribe ?? false;
  }
}

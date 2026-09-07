import { Injectable } from '@nestjs/common';
import { maskFullName } from '../../shared/privacy/mask.util';
import type { DeletionActor, PatientContract, PatientDeletionSnapshot, PatientProfileSummary } from './patient.contract';
import { PatientRepository } from './patient.repository';
import { PatientService } from './patient.service';

@Injectable()
export class PatientFacade implements PatientContract {
  constructor(
    private readonly repo: PatientRepository,
    private readonly service: PatientService,
  ) {}

  /** See `PatientContract#getProfileSummary`'s header — masked when `deletedAt` is set. */
  async getProfileSummary(patientId: string): Promise<PatientProfileSummary | null> {
    const row = await this.repo.findById(patientId);
    if (!row) {
      return null;
    }
    const isDeleted = row.deletedAt !== null;
    return {
      id: row.id,
      fullName: isDeleted ? maskFullName(row.fullName) : row.fullName,
      // `dateOfBirth` masking: a soft-deleted account's date of birth is
      // dropped entirely rather than partially shown — unlike a name or a
      // phone number, there is no "safe partial" of a birth date that
      // doesn't still narrow a real person down hard, and nothing in this
      // codebase reads a masked summary's `dateOfBirth` for anything but
      // display.
      dateOfBirth: isDeleted ? null : row.dateOfBirth,
      gender: row.gender,
      preferredLanguage: row.preferredLanguage,
      isDeleted,
    };
  }

  async softDeleteForDeletionRequest(patientId: string, actor: DeletionActor): Promise<PatientDeletionSnapshot> {
    return this.service.softDeleteForDeletionRequest(patientId, actor);
  }

  async restoreFromDeletion(patientId: string): Promise<{ restored: boolean }> {
    return this.service.restoreFromDeletion(patientId);
  }
}

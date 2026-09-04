import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { AccountStatus, Gender } from '../../schema/enums.schema';
import { patientsTable, type PatientRow } from '../../schema/patients.schema';
import type { Executor } from '../identity/identity.repository';

/**
 * Fields this module owns on `patients` (`fullName`, `dateOfBirth`, `gender`,
 * `preferredLanguage`), plus `status` — a moderation write, not an auth
 * write. `mobileNumber`/`tokenVersion` stay exclusively identity's; a status
 * change that must kill live sessions goes through `IdentityFacade.
 * revokeAllSessions` in `patient.service.ts`, never through `tokenVersion`
 * here.
 */
export interface PatientProfileUpdate {
  fullName?: string;
  dateOfBirth?: string;
  gender?: Gender;
  preferredLanguage?: string;
  status?: AccountStatus;
}

@Injectable()
export class PatientRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<PatientRow | null> {
    const [row] = await executor.select().from(patientsTable).where(eq(patientsTable.id, id)).limit(1);
    return row ?? null;
  }

  /** Simple list for the first admin patient screen — add pagination when the panel needs it. */
  async findAll(executor: Executor = this.db): Promise<PatientRow[]> {
    return executor.select().from(patientsTable).orderBy(patientsTable.createdAt);
  }

  async updateProfile(id: string, data: PatientProfileUpdate, executor: Executor = this.db): Promise<PatientRow | null> {
    const [row] = await executor
      .update(patientsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(patientsTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * `status` is one of the auth-relevant columns identity.repository.ts
   * otherwise owns, but admin moderation (suspend/reinstate) legitimately
   * writes it here — `tokenVersion` stays exclusively identity's, bumped
   * separately via `IdentityFacade.revokeAllSessions`.
   */
  async updateStatus(id: string, status: AccountStatus, executor: Executor = this.db): Promise<PatientRow | null> {
    const [row] = await executor
      .update(patientsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(patientsTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * ADDITIVE (M-21/data rights execution). Nulls every direct-identifier
   * column this module owns on `patients` — `fullName`, `dateOfBirth`,
   * `pushToken`, `deviceId`. Deliberately NOT `mobileNumber` or
   * `tokenVersion`: both stay exclusively identity's to write, per this
   * file's own header comment, so a caller anonymizing a patient must also
   * call `IdentityFacade.anonymizeMobileNumber('patient', id)` and
   * `IdentityFacade.revokeAllSessions('patient', id, ...)` — this method is
   * only the half of anonymization that belongs to THIS table's owning
   * columns. Deliberately NOT `status`: the caller decides that separately
   * (`patient.service.ts#updateStatus` already owns the
   * status-plus-revocation transition to `deleted`), so this method can be
   * retried on its own without re-deciding the account's status each time.
   * `gender`/`preferredLanguage` are left alone — neither is a direct
   * identifier.
   */
  async anonymizeIdentity(id: string, executor: Executor = this.db): Promise<PatientRow | null> {
    const [row] = await executor
      .update(patientsTable)
      .set({ fullName: null, dateOfBirth: null, pushToken: null, deviceId: null, updatedAt: new Date() })
      .where(eq(patientsTable.id, id))
      .returning();
    return row ?? null;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { doctorsTable, type DoctorRow } from '../../schema/doctors.schema';
import type { DoctorSeniority, DoctorVerificationStatus } from '../../schema/enums.schema';
import type { Executor } from '../identity/identity.repository';

export interface DoctorProfileFieldsUpdate {
  fullName?: string;
  qualification?: string;
  registrationNumber?: string;
  yearsOfExperience?: number;
  consultationDurationMinutes?: number;
  bufferMinutes?: number;
}

export interface DoctorOwnProfileUpdate {
  bio?: string;
  languages?: string[];
}

export interface DoctorVerificationUpdate {
  verificationStatus: DoctorVerificationStatus;
  verifiedByAdminId?: string | null;
  verifiedAt?: Date | null;
  /** Forced `false` in the same statement when the transition demotes the doctor — see `doctor-verification.service.ts`. */
  isListed?: boolean;
}

export interface DoctorListingUpdate {
  isListed?: boolean;
  allowInstantConsult?: boolean;
}

/**
 * `doctors` table CRUD. `identity.repository.ts` already owns
 * `mobileNumber`/`mobileVerifiedAt`/`tokenVersion` (the OTP sign-in flow) and
 * `presence`/`blockedByConsultationId` belong to M-13/M-15 — every method
 * here touches only columns this module owns, except `create`, which also
 * legitimately writes `mobileNumber` once, at row-creation time (FR-1.2: "an
 * admin creates a doctor account" — identity doesn't own row-CREATION, only
 * auth-flow reads/writes against an existing row).
 */
@Injectable()
export class DoctorRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor.select().from(doctorsTable).where(eq(doctorsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByMobile(mobileNumber: string, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor.select().from(doctorsTable).where(eq(doctorsTable.mobileNumber, mobileNumber)).limit(1);
    return row ?? null;
  }

  async findByRegistrationNumber(registrationNumber: string, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .select()
      .from(doctorsTable)
      .where(eq(doctorsTable.registrationNumber, registrationNumber))
      .limit(1);
    return row ?? null;
  }

  /** Plain list, every status — no pagination, mirroring `identity.repository.ts`'s `listAdmins`. */
  async list(executor: Executor = this.db): Promise<DoctorRow[]> {
    return executor.select().from(doctorsTable).orderBy(doctorsTable.fullName);
  }

  async create(data: { mobileNumber: string; fullName: string }, executor: Executor = this.db): Promise<DoctorRow> {
    const [row] = await executor.insert(doctorsTable).values(data).returning();
    if (!row) {
      throw new Error('doctors insert returned no row — should be unreachable.');
    }
    return row;
  }

  async updateProfileFields(
    id: string,
    data: DoctorProfileFieldsUpdate,
    executor: Executor = this.db,
  ): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(doctorsTable.id, id))
      .returning();
    return row ?? null;
  }

  async updateOwnProfile(id: string, data: DoctorOwnProfileUpdate, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(doctorsTable.id, id))
      .returning();
    return row ?? null;
  }

  async updateVerification(id: string, data: DoctorVerificationUpdate, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(doctorsTable.id, id))
      .returning();
    return row ?? null;
  }

  async updateListing(id: string, data: DoctorListingUpdate, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(doctorsTable.id, id))
      .returning();
    return row ?? null;
  }

  /** `consultationFeeInr` is a `numeric` column — drizzle's node-postgres driver reads/writes it as a decimal string. */
  async updateFee(id: string, consultationFeeInr: string, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ consultationFeeInr, updatedAt: new Date() })
      .where(eq(doctorsTable.id, id))
      .returning();
    return row ?? null;
  }

  async updateSeniority(id: string, seniorityLevel: DoctorSeniority, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ seniorityLevel, updatedAt: new Date() })
      .where(eq(doctorsTable.id, id))
      .returning();
    return row ?? null;
  }
}

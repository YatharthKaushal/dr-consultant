import { Inject, Injectable } from '@nestjs/common';
import { and, eq, exists, inArray, lte, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
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

  async listByIds(ids: readonly string[], executor: Executor = this.db): Promise<DoctorRow[]> {
    if (ids.length === 0) return [];
    return executor.select().from(doctorsTable).where(inArray(doctorsTable.id, [...ids]));
  }

  /**
   * ADDITIVE (M-09/search): the listed-and-bookable multi-doctor read behind
   * `DoctorContract.listListedDoctors`. Notes on the three non-obvious bits:
   *
   *   - `(verificationStatus = 'verified' AND isListed)` leads the WHERE so
   *     the composite index `doctors` already declares on exactly that pair
   *     drives the scan.
   *   - The specialty filter is an EXISTS subquery, NOT a join. A join
   *     against `doctor_specialties` multiplies a doctor by their specialty
   *     count, which would corrupt `limit`/`offset` — a page of 20 could
   *     return 12 distinct doctors. EXISTS keeps one row per doctor, so
   *     paging counts doctors. The service loads the full specialty list
   *     for the page separately.
   *   - `languages` is a jsonb ARRAY of strings, so it is expanded with
   *     `jsonb_array_elements_text` and compared case-insensitively: a
   *     doctor who wrote "Hindi" must still answer a filter for "hindi".
   *     The wanted list is bound as a single `text[]` PARAMETER — never
   *     interpolated into the statement — so an admin-supplied or
   *     patient-supplied language string can carry no SQL. `lower(...)`
   *     means this predicate is not index-backed; acceptable against a
   *     candidate pool bounded in the tens, and the place a functional index
   *     would go if that pool ever grows.
   */
  async listListedDoctors(
    filter: { specialtyIds?: readonly string[]; languages?: readonly string[]; maxFeeInr?: string; limit: number; offset: number },
    executor: Executor = this.db,
  ): Promise<DoctorRow[]> {
    const conditions = [eq(doctorsTable.verificationStatus, 'verified'), eq(doctorsTable.isListed, true)];

    if (filter.specialtyIds && filter.specialtyIds.length > 0) {
      conditions.push(
        exists(
          executor
            .select({ one: sql`1` })
            .from(doctorSpecialtiesTable)
            .where(
              and(
                eq(doctorSpecialtiesTable.doctorId, doctorsTable.id),
                inArray(doctorSpecialtiesTable.specialtyId, [...filter.specialtyIds]),
              ),
            ),
        ),
      );
    }

    if (filter.languages && filter.languages.length > 0) {
      const wanted = filter.languages.map((language) => language.trim().toLowerCase()).filter((language) => language.length > 0);
      if (wanted.length > 0) {
        conditions.push(
          // `sql.param(wanted)` binds the whole list as ONE `text[]`
          // parameter. Interpolating the array directly makes drizzle expand
          // it into a parameter LIST, which renders as `any(($3, $4)::text[])`
          // — a row constructor Postgres rejects, so any filter naming two or
          // more languages failed with a syntax error while a single-language
          // filter happened to work.
          sql`exists (select 1 from jsonb_array_elements_text(${doctorsTable.languages}) as spoken(language) where lower(spoken.language) = any(${sql.param(wanted)}::text[]))`,
        );
      }
    }

    if (filter.maxFeeInr !== undefined) {
      conditions.push(lte(doctorsTable.consultationFeeInr, filter.maxFeeInr));
    }

    return executor
      .select()
      .from(doctorsTable)
      .where(and(...conditions))
      // Ordered by name then id: `limit`/`offset` paging over an unordered
      // set can repeat or skip rows, and `fullName` alone is not unique.
      .orderBy(doctorsTable.fullName, doctorsTable.id)
      .limit(filter.limit)
      .offset(filter.offset);
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

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, exists, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable, type DoctorRow } from '../../schema/doctors.schema';
import type { DoctorPresence, DoctorSeniority, DoctorVerificationStatus } from '../../schema/enums.schema';
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

/** ADDITIVE (M-13) — see `listInstantRoutingCandidates`. */
export interface InstantRoutingCandidateFilter {
  /** The consultation's BOOKING-TIME specialty snapshot. The doctor must practise it, primary or secondary. */
  specialtyId: string;
  /** Doctors already offered this request. Never re-offered — FR-10.6 re-routes to the NEXT doctor. */
  excludeDoctorIds?: readonly string[];
  limit: number;
}

/**
 * `doctors` table CRUD. `identity.repository.ts` already owns
 * `mobileNumber`/`mobileVerifiedAt`/`tokenVersion` (the OTP sign-in flow) —
 * every method here touches only columns this module owns, except `create`,
 * which also legitimately writes `mobileNumber` once, at row-creation time
 * (FR-1.2: "an admin creates a doctor account" — identity doesn't own
 * row-CREATION, only auth-flow reads/writes against an existing row).
 *
 * ── ADDITIVE (M-13/PRESENCE AND INSTANT CONSULT) ───────────────────────────
 *
 * `presence`, `allow_instant_consult` and `blocked_by_consultation_id` are
 * columns on `doctors`, so they are M-05's to write even though M-13 owns the
 * RULES that decide when they move. The four methods at the bottom of this
 * file — `findByIdForUpdate`, `updatePresenceIfIn`, `setCompletionGate`/
 * `clearCompletionGateByConsultation`, `listInstantRoutingCandidates` — exist
 * so M-13 never has to reach into this table itself.
 *
 * That split is the point. The alternative (M-13 writing `doctors` directly)
 * is the same drift `booking.repository.ts` documents in the other direction
 * when it reads `payments`, and it would put the completion gate — the one
 * cached fact the whole instant flow hinges on — under two owners.
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

  /* ── ADDITIVE (M-13): presence, the completion gate, and routing ───────── */

  /**
   * *** THE ROW LOCK BEHIND THE SEVEN-STATE MACHINE. *** `SELECT ... FOR
   * UPDATE` on one doctor, inside the CALLER's transaction — which is why `tx`
   * is required and not defaulted, exactly as `booking.repository.ts#
   * findByIdForUpdate` requires one.
   *
   * Every presence transition and every completion-gate write takes this
   * FIRST and re-reads `presence`/`blocked_by_consultation_id` through it, so
   * two concurrent transitions on one doctor serialize instead of
   * interleaving: the second waits here, then sees the first one's committed
   * state and fails its own legality guard. Without it, a doctor's routing
   * offer and their own "go offline" tap could both read `available_now` and
   * both write, leaving a request pending against a doctor who is gone.
   */
  async findByIdForUpdate(id: string, tx: DatabaseTransaction): Promise<DoctorRow | null> {
    const [row] = await tx.select().from(doctorsTable).where(eq(doctorsTable.id, id)).limit(1).for('update');
    return row ?? null;
  }

  /**
   * Presence transition guarded by BOTH the id and the set of states it is
   * legal from — the mirror of `booking.repository.ts#updateStatusIfIn`. The
   * `WHERE presence IN (...)` is a second line of defence under the `FOR
   * UPDATE` re-read, so even a caller that skipped the lock cannot drive an
   * illegal transition. Returns `null` when the guard did not match.
   *
   * `requireNotGated` adds `blocked_by_consultation_id IS NULL` to the same
   * statement. *** THAT IS WHAT MAKES THE COMPLETION GATE UNBYPASSABLE FROM
   * THE PRESENCE ENDPOINT (FR-10.5). *** It is one predicate in one atomic
   * UPDATE, not a read-then-write the caller could be talked out of.
   */
  async updatePresenceIfIn(
    id: string,
    from: readonly DoctorPresence[],
    to: DoctorPresence,
    options: { requireNotGated?: boolean } = {},
    executor: Executor = this.db,
  ): Promise<DoctorRow | null> {
    const conditions = [eq(doctorsTable.id, id), inArray(doctorsTable.presence, [...from])];
    if (options.requireNotGated) {
      conditions.push(isNull(doctorsTable.blockedByConsultationId));
    }

    const [row] = await executor
      .update(doctorsTable)
      .set({ presence: to, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  }

  /**
   * Sets the completion gate. Refuses (returns `null`) if the doctor is
   * ALREADY gated by a DIFFERENT consultation — that would silently drop the
   * older outstanding documentation, which is the one thing FR-10.5 exists to
   * stop. Re-setting the same consultation is a no-op that still returns the
   * row, so a retried call is safe.
   */
  async setCompletionGate(
    id: string,
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ blockedByConsultationId: consultationId, updatedAt: new Date() })
      .where(
        and(
          eq(doctorsTable.id, id),
          // Free, or already gated by this same consultation.
          sql`(${doctorsTable.blockedByConsultationId} is null or ${doctorsTable.blockedByConsultationId} = ${consultationId})`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Clears the gate BY CONSULTATION rather than by doctor, because that is
   * what M-15 will hold when it finalises a clinical record — it knows the
   * consultation it just closed, not which doctor row happens to cache the
   * block. Returns the row that was cleared, or `null` when no doctor was
   * gated by this consultation (already cleared, or never gated) — which
   * makes the call idempotent by construction.
   */
  async clearCompletionGateByConsultation(consultationId: string, executor: Executor = this.db): Promise<DoctorRow | null> {
    const [row] = await executor
      .update(doctorsTable)
      .set({ blockedByConsultationId: null, updatedAt: new Date() })
      .where(eq(doctorsTable.blockedByConsultationId, consultationId))
      .returning();
    return row ?? null;
  }

  /**
   * *** THE ROUTING CANDIDATE QUERY (FR-10.2/FR-10.3/FR-10.5). *** Every
   * doctor an instant request may be offered to, in the order it should try
   * them.
   *
   * The four predicates, and why each is here rather than in M-13:
   *   - `presence = 'available_now'` — FR-10.4's only routable state.
   *     `scheduled_only` is deliberately NOT included: FR-10.3 says that
   *     doctor "stays bookable by slot but receives no instant requests", so
   *     they must remain fully visible to M-07/M-11 and invisible here. That
   *     is the whole distinction between the two states, and it is expressed
   *     exactly once — in this WHERE clause.
   *   - `allow_instant_consult` — M-05's admin permission (FR-18.1's
   *     "Instant-consult permission"). A doctor can be `available_now`
   *     without it; they simply never route.
   *   - `blocked_by_consultation_id IS NULL` — *** THE COMPLETION GATE. ***
   *     Second and independent enforcement point: even a doctor who somehow
   *     reached `available_now` while gated is not a candidate here.
   *   - `verification_status = 'verified' AND is_listed` — the same
   *     booking-eligibility gate `isVerifiedAndListed` reports. M-11's
   *     `assignDoctor` re-checks it and would refuse, so leaving it out would
   *     mean routing to a doctor whose acceptance is guaranteed to fail.
   *
   * The specialty filter is an EXISTS subquery, not a join, for the reason
   * `listListedDoctors` gives: a join multiplies a doctor by their specialty
   * count and corrupts `limit`. It also matches the `consultations_doctor_
   * specialty_fk` composite FK that `assignDoctor` will be checked against, so
   * a candidate returned here cannot fail that constraint.
   *
   * ORDER: `updated_at ASC, id ASC` — a rough round-robin, NOT a ranking.
   * FR-10.6 says only that a decline or timeout routes to "the next available
   * doctor" and says nothing about which is first, so this deliberately does
   * not encode a preference: every presence transition bumps `updated_at`, so
   * a doctor who has just been offered (or has just finished) something sorts
   * to the back and the next request tries someone else. `id` breaks ties so
   * paging is stable.
   */
  async listInstantRoutingCandidates(
    filter: InstantRoutingCandidateFilter,
    executor: Executor = this.db,
  ): Promise<DoctorRow[]> {
    const conditions = [
      eq(doctorsTable.presence, 'available_now'),
      eq(doctorsTable.allowInstantConsult, true),
      isNull(doctorsTable.blockedByConsultationId),
      eq(doctorsTable.verificationStatus, 'verified'),
      eq(doctorsTable.isListed, true),
      exists(
        executor
          .select({ one: sql`1` })
          .from(doctorSpecialtiesTable)
          .where(
            and(
              eq(doctorSpecialtiesTable.doctorId, doctorsTable.id),
              eq(doctorSpecialtiesTable.specialtyId, filter.specialtyId),
            ),
          ),
      ),
    ];

    if (filter.excludeDoctorIds && filter.excludeDoctorIds.length > 0) {
      conditions.push(notInArray(doctorsTable.id, [...filter.excludeDoctorIds]));
    }

    return executor
      .select()
      .from(doctorsTable)
      .where(and(...conditions))
      .orderBy(asc(doctorsTable.updatedAt), asc(doctorsTable.id))
      .limit(filter.limit);
  }

  /**
   * THE BOOT SWEEP'S WRITE. Moves every doctor currently in one of `from` to
   * `to`, in one statement, and returns their ids so the caller can audit
   * each one.
   *
   * `docs/erd.sql` on `doctors`: "No `last_heartbeat_at`: presence is carried
   * on the realtime channel (M-13), so the socket already knows who is live —
   * its disconnect handler, and a sweep at boot, write `presence = offline`."
   * This is that sweep. After a restart no stream exists, so any doctor the
   * old process left `available_now` is a lie the next routing decision would
   * act on.
   */
  async bulkResetPresence(
    from: readonly DoctorPresence[],
    to: DoctorPresence,
    executor: Executor = this.db,
  ): Promise<string[]> {
    if (from.length === 0) return [];
    const rows = await executor
      .update(doctorsTable)
      .set({ presence: to, updatedAt: new Date() })
      .where(inArray(doctorsTable.presence, [...from]))
      .returning({ id: doctorsTable.id });
    return rows.map((row) => row.id);
  }
}

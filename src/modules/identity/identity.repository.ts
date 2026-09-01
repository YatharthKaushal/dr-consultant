import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { AccountStatus, AccountType } from '../../schema/enums.schema';
import { adminsTable } from '../../schema/admins.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { otpChallengesTable, type OtpChallengeRow } from '../../schema/otp-challenges.schema';
import { patientsTable } from '../../schema/patients.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
export type Executor = Database | DatabaseTransaction;

/**
 * Uniform shape across the three account tables, even though their own
 * "may this account sign in" column differs (`patients`/`admins.status`
 * vs. `doctors.verification_status`) — that per-table rule is applied once,
 * here, so the service layer never needs to know each table's own
 * vocabulary.
 */
export interface AccountAuthState {
  id: string;
  isActive: boolean;
  tokenVersion: number;
}

export interface FindOrCreatePatientResult {
  id: string;
  isNewAccount: boolean;
  tokenVersion: number;
}

const PATIENT_INACTIVE_STATUSES = new Set(['suspended', 'deleted']);
const DOCTOR_INACTIVE_STATUSES = new Set(['rejected', 'suspended']);

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* otp_challenges                                                          */
  /* ---------------------------------------------------------------------- */

  async insertChallenge(
    data: {
      mobileNumber: string;
      audience: AccountType;
      providerRequestId: string;
      expiresAt: Date;
      ipAddress?: string;
      deviceId?: string;
    },
    executor: Executor = this.db,
  ): Promise<OtpChallengeRow> {
    const [row] = await executor
      .insert(otpChallengesTable)
      .values({
        mobileNumber: data.mobileNumber,
        audience: data.audience,
        providerRequestId: data.providerRequestId,
        expiresAt: data.expiresAt,
        ipAddress: data.ipAddress,
        deviceId: data.deviceId,
      })
      .returning();

    if (!row) {
      throw new Error('otp_challenges insert returned no row — should be unreachable.');
    }
    return row;
  }

  async findChallengeById(id: string, executor: Executor = this.db): Promise<OtpChallengeRow | null> {
    const [row] = await executor.select().from(otpChallengesTable).where(eq(otpChallengesTable.id, id)).limit(1);
    return row ?? null;
  }

  async bumpAttemptCount(id: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(otpChallengesTable)
      .set({ attemptCount: sql`${otpChallengesTable.attemptCount} + 1` })
      .where(eq(otpChallengesTable.id, id));
  }

  /** Records an `otp.retry` — updates the same row in place; Slide reuses the same `providerRequestId`. */
  async recordResend(id: string, newExpiresAt: Date, executor: Executor = this.db): Promise<void> {
    await executor
      .update(otpChallengesTable)
      .set({
        resendCount: sql`${otpChallengesTable.resendCount} + 1`,
        lastSentAt: new Date(),
        expiresAt: newExpiresAt,
      })
      .where(eq(otpChallengesTable.id, id));
  }

  async markVerified(id: string, verifiedAt: Date, executor: Executor = this.db): Promise<void> {
    await executor.update(otpChallengesTable).set({ verifiedAt }).where(eq(otpChallengesTable.id, id));
  }

  /** Sum of `1 + resend_count` for this number since `since` — the actual "how many sends" count, not a row count. */
  async countRecentSendsByMobile(mobileNumber: string, since: Date, executor: Executor = this.db): Promise<number> {
    const [result] = await executor
      .select({ total: sql<string>`coalesce(sum(1 + ${otpChallengesTable.resendCount}), 0)` })
      .from(otpChallengesTable)
      .where(and(eq(otpChallengesTable.mobileNumber, mobileNumber), gte(otpChallengesTable.createdAt, since)));
    return Number(result?.total ?? 0);
  }

  async countRecentSendsByIp(ipAddress: string, since: Date, executor: Executor = this.db): Promise<number> {
    const [result] = await executor
      .select({ total: sql<string>`coalesce(sum(1 + ${otpChallengesTable.resendCount}), 0)` })
      .from(otpChallengesTable)
      .where(and(eq(otpChallengesTable.ipAddress, ipAddress), gte(otpChallengesTable.createdAt, since)));
    return Number(result?.total ?? 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Accounts                                                                 */
  /* ---------------------------------------------------------------------- */

  async findPatientAuthStateByMobile(mobileNumber: string, executor: Executor = this.db): Promise<AccountAuthState | null> {
    const [row] = await executor
      .select({ id: patientsTable.id, status: patientsTable.status, tokenVersion: patientsTable.tokenVersion })
      .from(patientsTable)
      .where(eq(patientsTable.mobileNumber, mobileNumber))
      .limit(1);
    return row ? { id: row.id, isActive: !PATIENT_INACTIVE_STATUSES.has(row.status), tokenVersion: row.tokenVersion } : null;
  }

  async findPatientAuthStateById(id: string, executor: Executor = this.db): Promise<AccountAuthState | null> {
    const [row] = await executor
      .select({ id: patientsTable.id, status: patientsTable.status, tokenVersion: patientsTable.tokenVersion })
      .from(patientsTable)
      .where(eq(patientsTable.id, id))
      .limit(1);
    return row ? { id: row.id, isActive: !PATIENT_INACTIVE_STATUSES.has(row.status), tokenVersion: row.tokenVersion } : null;
  }

  /** Idempotent — a repeated OTP verify for a brand-new number must not create two rows. */
  async findOrCreatePatientByMobile(mobileNumber: string, executor: Executor = this.db): Promise<FindOrCreatePatientResult> {
    const inserted = await executor
      .insert(patientsTable)
      .values({ mobileNumber })
      .onConflictDoNothing({ target: patientsTable.mobileNumber })
      .returning({ id: patientsTable.id, tokenVersion: patientsTable.tokenVersion });

    if (inserted[0]) {
      return { id: inserted[0].id, isNewAccount: true, tokenVersion: inserted[0].tokenVersion };
    }

    const [existing] = await executor
      .select({ id: patientsTable.id, tokenVersion: patientsTable.tokenVersion })
      .from(patientsTable)
      .where(eq(patientsTable.mobileNumber, mobileNumber))
      .limit(1);

    if (!existing) {
      throw new Error('Patient row vanished between insert-conflict and re-select — should be unreachable.');
    }
    return { id: existing.id, isNewAccount: false, tokenVersion: existing.tokenVersion };
  }

  async findDoctorAuthStateByMobile(mobileNumber: string, executor: Executor = this.db): Promise<AccountAuthState | null> {
    const [row] = await executor
      .select({
        id: doctorsTable.id,
        verificationStatus: doctorsTable.verificationStatus,
        tokenVersion: doctorsTable.tokenVersion,
      })
      .from(doctorsTable)
      .where(eq(doctorsTable.mobileNumber, mobileNumber))
      .limit(1);
    return row
      ? { id: row.id, isActive: !DOCTOR_INACTIVE_STATUSES.has(row.verificationStatus), tokenVersion: row.tokenVersion }
      : null;
  }

  async findDoctorAuthStateById(id: string, executor: Executor = this.db): Promise<AccountAuthState | null> {
    const [row] = await executor
      .select({
        id: doctorsTable.id,
        verificationStatus: doctorsTable.verificationStatus,
        tokenVersion: doctorsTable.tokenVersion,
      })
      .from(doctorsTable)
      .where(eq(doctorsTable.id, id))
      .limit(1);
    return row
      ? { id: row.id, isActive: !DOCTOR_INACTIVE_STATUSES.has(row.verificationStatus), tokenVersion: row.tokenVersion }
      : null;
  }

  async setDoctorMobileVerifiedIfUnset(id: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(doctorsTable)
      .set({ mobileVerifiedAt: new Date() })
      .where(and(eq(doctorsTable.id, id), sql`${doctorsTable.mobileVerifiedAt} is null`));
  }

  async findAdminAuthStateByMobile(mobileNumber: string, executor: Executor = this.db): Promise<AccountAuthState | null> {
    const [row] = await executor
      .select({ id: adminsTable.id, status: adminsTable.status, tokenVersion: adminsTable.tokenVersion })
      .from(adminsTable)
      .where(eq(adminsTable.mobileNumber, mobileNumber))
      .limit(1);
    return row ? { id: row.id, isActive: row.status === 'active', tokenVersion: row.tokenVersion } : null;
  }

  async findAdminAuthStateById(id: string, executor: Executor = this.db): Promise<AccountAuthState | null> {
    const [row] = await executor
      .select({ id: adminsTable.id, status: adminsTable.status, tokenVersion: adminsTable.tokenVersion })
      .from(adminsTable)
      .where(eq(adminsTable.id, id))
      .limit(1);
    return row ? { id: row.id, isActive: row.status === 'active', tokenVersion: row.tokenVersion } : null;
  }

  async setAdminMobileVerifiedIfUnset(id: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(adminsTable)
      .set({ mobileVerifiedAt: new Date() })
      .where(and(eq(adminsTable.id, id), sql`${adminsTable.mobileVerifiedAt} is null`));
  }

  /** For `GET /auth/me` — the account's own basic profile fields, regardless of account type. */
  async getAccountSummary(
    accountType: AccountType,
    id: string,
    executor: Executor = this.db,
  ): Promise<{ id: string; mobileNumber: string; fullName: string | null } | null> {
    if (accountType === 'patient') {
      const [row] = await executor
        .select({ id: patientsTable.id, mobileNumber: patientsTable.mobileNumber, fullName: patientsTable.fullName })
        .from(patientsTable)
        .where(eq(patientsTable.id, id))
        .limit(1);
      return row ?? null;
    }
    if (accountType === 'doctor') {
      const [row] = await executor
        .select({ id: doctorsTable.id, mobileNumber: doctorsTable.mobileNumber, fullName: doctorsTable.fullName })
        .from(doctorsTable)
        .where(eq(doctorsTable.id, id))
        .limit(1);
      return row ?? null;
    }
    const [row] = await executor
      .select({ id: adminsTable.id, mobileNumber: adminsTable.mobileNumber, fullName: adminsTable.fullName })
      .from(adminsTable)
      .where(eq(adminsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  async getContactMobileNumber(accountType: AccountType, id: string, executor: Executor = this.db): Promise<string | null> {
    // Deliberately three explicit branches rather than picking a table
    // variable first: a union-typed PgTable reference doesn't play well
    // with drizzle's `.from()`/`.where()` overloads, which expect one
    // concrete table type.
    if (accountType === 'patient') {
      const [row] = await executor
        .select({ mobileNumber: patientsTable.mobileNumber })
        .from(patientsTable)
        .where(eq(patientsTable.id, id))
        .limit(1);
      return row?.mobileNumber ?? null;
    }
    if (accountType === 'doctor') {
      const [row] = await executor
        .select({ mobileNumber: doctorsTable.mobileNumber })
        .from(doctorsTable)
        .where(eq(doctorsTable.id, id))
        .limit(1);
      return row?.mobileNumber ?? null;
    }
    const [row] = await executor
      .select({ mobileNumber: adminsTable.mobileNumber })
      .from(adminsTable)
      .where(eq(adminsTable.id, id))
      .limit(1);
    return row?.mobileNumber ?? null;
  }

  /** Returns the new `tokenVersion`. Used by `logout-all` and by a status change that must kill live sessions immediately. */
  async bumpTokenVersion(accountType: AccountType, id: string, executor: Executor = this.db): Promise<number> {
    if (accountType === 'patient') {
      const [row] = await executor
        .update(patientsTable)
        .set({ tokenVersion: sql`${patientsTable.tokenVersion} + 1` })
        .where(eq(patientsTable.id, id))
        .returning({ tokenVersion: patientsTable.tokenVersion });
      if (!row) throw new Error(`bumpTokenVersion: no patient row for id ${id}.`);
      return row.tokenVersion;
    }
    if (accountType === 'doctor') {
      const [row] = await executor
        .update(doctorsTable)
        .set({ tokenVersion: sql`${doctorsTable.tokenVersion} + 1` })
        .where(eq(doctorsTable.id, id))
        .returning({ tokenVersion: doctorsTable.tokenVersion });
      if (!row) throw new Error(`bumpTokenVersion: no doctor row for id ${id}.`);
      return row.tokenVersion;
    }
    const [row] = await executor
      .update(adminsTable)
      .set({ tokenVersion: sql`${adminsTable.tokenVersion} + 1` })
      .where(eq(adminsTable.id, id))
      .returning({ tokenVersion: adminsTable.tokenVersion });
    if (!row) throw new Error(`bumpTokenVersion: no admin row for id ${id}.`);
    return row.tokenVersion;
  }

  /* ---------------------------------------------------------------------- */
  /* Admin management (identity-admin.controller.ts)                         */
  /* ---------------------------------------------------------------------- */

  async findAdminByMobile(mobileNumber: string, executor: Executor = this.db) {
    const [row] = await executor.select().from(adminsTable).where(eq(adminsTable.mobileNumber, mobileNumber)).limit(1);
    return row ?? null;
  }

  async findAdminById(id: string, executor: Executor = this.db) {
    const [row] = await executor.select().from(adminsTable).where(eq(adminsTable.id, id)).limit(1);
    return row ?? null;
  }

  async listAdmins(executor: Executor = this.db) {
    return executor.select().from(adminsTable).orderBy(adminsTable.fullName);
  }

  async createAdmin(data: { mobileNumber: string; fullName: string }, executor: Executor = this.db) {
    const [row] = await executor.insert(adminsTable).values(data).returning();
    if (!row) {
      throw new Error('admins insert returned no row — should be unreachable.');
    }
    return row;
  }

  async updateAdmin(id: string, data: { fullName?: string; status?: AccountStatus }, executor: Executor = this.db) {
    const [row] = await executor
      .update(adminsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(adminsTable.id, id))
      .returning();
    return row ?? null;
  }
}

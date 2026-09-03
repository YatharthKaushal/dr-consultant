import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import type { PushAppKey } from './notification-push.types';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/**
 * All SQL against the DEVICE TOKEN columns — `patients.push_token`,
 * `patients.device_id`, `doctors.push_token`, `doctors.device_id` — and
 * nothing else on either table.
 *
 * ===========================================================================
 * *** WHY M-08 TOUCHES COLUMNS ON TWO OTHER MODULES' TABLES. ***
 *
 * `docs/MODULES.md` §7's rule is about DATA, not about tables: "One module
 * owns each piece of data. Others read it through that module's public
 * interface, never from its tables." M-08's own entry then names the data it
 * owns: "Data owned: notification templates, delivery records, DEVICE
 * TOKENS." Device tokens are M-08's, and this repository is the public
 * interface through which they are read and written.
 *
 * They live as columns on `patients`/`doctors` rather than in a
 * `device_tokens` table because there is exactly ONE per account —
 * `docs/erd.sql` gives each table a single `push_token text` and a single
 * `device_id varchar(120)`, plus an index on `push_token`. A one-row-per-
 * account fact is a column, not a table, and inventing a table here would
 * mean writing a migration the brief forbids and contradicting the schema.
 *
 * The other two modules agree, and already say so in their own code:
 * `doctor.mapper.ts`'s `SafeDoctorRow` is `Omit<DoctorRow, 'tokenVersion' |
 * 'pushToken' | 'deviceId' | ...>` with the comment that these are not the
 * doctor module's to expose. Nothing in `modules/patient` or `modules/doctor`
 * reads or writes either column, so there is no second writer to race with.
 *
 * The discipline that makes this safe is SCOPE: every statement below
 * SELECTs or SETs only the four columns named above. No profile field, no
 * status, no `token_version` is read or written here, and a review that finds
 * one should reject it.
 * ===========================================================================
 *
 * *** THE AUDIENCE KIND IS `PushAppKey`, NOT `NotificationAudienceKind`. ***
 * There is no admin row here at all, and the type says so: `notifications.
 * admin_id`'s schema comment is explicit that admins are "read in the panel —
 * admins have no push token". An admin device token is not unsupported by
 * omission, it is unrepresentable.
 */
@Injectable()
export class NotificationDeviceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The account's current FCM registration token, or `null` if it has none (or does not exist). */
  async findPushToken(app: PushAppKey, accountId: string, executor: Executor = this.db): Promise<string | null> {
    if (app === 'patient') {
      const [row] = await executor
        .select({ pushToken: patientsTable.pushToken })
        .from(patientsTable)
        .where(eq(patientsTable.id, accountId))
        .limit(1);
      return row?.pushToken ?? null;
    }

    const [row] = await executor
      .select({ pushToken: doctorsTable.pushToken })
      .from(doctorsTable)
      .where(eq(doctorsTable.id, accountId))
      .limit(1);
    return row?.pushToken ?? null;
  }

  /**
   * Stores the token this account's app just handed us. Returns false when
   * the account does not exist.
   *
   * *** THE TOKEN IS CLEARED FROM ANY OTHER ACCOUNT FIRST. *** An FCM
   * registration token identifies an APP INSTALL, not a person. When one
   * phone is used by two people in turn — a shared family handset, a doctor's
   * clinic tablet, a factory-reset device — the second sign-in receives the
   * SAME token the first account is still holding. Leaving it on both rows
   * would send the first person's notifications to the second person's lock
   * screen, which is an SRS 6.2 privacy breach dressed up as a stale row.
   *
   * Scoped to the same `app`, because the patient and doctor apps are
   * separate Firebase projects (`fcm-push.adapter.ts`) and a token from one
   * is meaningless to the other, so there is nothing to collide.
   */
  async register(
    app: PushAppKey,
    accountId: string,
    values: { pushToken: string; deviceId?: string },
    executor: Executor = this.db,
  ): Promise<boolean> {
    if (app === 'patient') {
      await executor
        .update(patientsTable)
        .set({ pushToken: null, updatedAt: new Date() })
        .where(and(eq(patientsTable.pushToken, values.pushToken), ne(patientsTable.id, accountId)));

      const updated = await executor
        .update(patientsTable)
        .set({ pushToken: values.pushToken, deviceId: values.deviceId ?? null, updatedAt: new Date() })
        .where(eq(patientsTable.id, accountId))
        .returning({ id: patientsTable.id });
      return updated.length > 0;
    }

    await executor
      .update(doctorsTable)
      .set({ pushToken: null, updatedAt: new Date() })
      .where(and(eq(doctorsTable.pushToken, values.pushToken), ne(doctorsTable.id, accountId)));

    const updated = await executor
      .update(doctorsTable)
      .set({ pushToken: values.pushToken, deviceId: values.deviceId ?? null, updatedAt: new Date() })
      .where(eq(doctorsTable.id, accountId))
      .returning({ id: doctorsTable.id });
    return updated.length > 0;
  }

  /**
   * Drops the account's token — on sign-out, and on FCM reporting
   * `registration-token-not-registered` (see `fcm-push.classifier.ts`).
   *
   * `deviceId` is cleared with it. FR-1.8's device id is only meaningful
   * alongside the token it was registered with; keeping it after the token is
   * gone would leave a device identifier attached to an account for no
   * purpose, which is the opposite of what SRS 6.2 asks for.
   */
  async clearPushToken(app: PushAppKey, accountId: string, executor: Executor = this.db): Promise<void> {
    if (app === 'patient') {
      await executor
        .update(patientsTable)
        .set({ pushToken: null, deviceId: null, updatedAt: new Date() })
        .where(eq(patientsTable.id, accountId));
      return;
    }

    await executor
      .update(doctorsTable)
      .set({ pushToken: null, deviceId: null, updatedAt: new Date() })
      .where(eq(doctorsTable.id, accountId));
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { notificationsTable, type NotificationRow } from '../../schema/notifications.schema';
import type { NotificationAudience } from './notification.contract';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/**
 * All SQL against `notifications`. No other module reads or writes this table
 * (`backend/README.md` §2), and nothing in this module writes it except
 * through here.
 *
 * *** THE ROW IS BOTH THINGS. *** `notifications` is the delivery record AND
 * the in-app notification. FR-16.1 asks for "push AND in-app reminders", and
 * there is no second table: an in-app notification is one of these rows read
 * back, and `read_at` — not a status value — is what makes it read. The
 * schema says so twice: `status` is "delivery only. Whether it was READ is
 * read_at", and `read_at` is "set = read. There is no read value in the
 * status enum saying the same thing."
 *
 * That is why every read here filters on the audience column IN THE WHERE
 * CLAUSE rather than taking an id and checking ownership afterwards: a
 * patient asking for a notification that belongs to someone else must get
 * nothing back from the query, not from an `if` a later refactor can drop.
 */
@Injectable()
export class NotificationRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Writes the delivery record. `status` takes the column default (`queued`)
   * and is settled afterwards by `markSent`/`markFailed` — the row exists
   * before the push is attempted, so a process that dies mid-send leaves a
   * `queued` row rather than no evidence at all.
   */
  async insert(
    values: {
      audience: NotificationAudience;
      templateCode: string;
      title: string;
      body: string;
      deepLinkData?: unknown;
      consultationId?: string;
    },
    executor: Executor = this.db,
  ): Promise<NotificationRow> {
    const [row] = await executor
      .insert(notificationsTable)
      .values({
        patientId: values.audience.kind === 'patient' ? values.audience.id : null,
        doctorId: values.audience.kind === 'doctor' ? values.audience.id : null,
        adminId: values.audience.kind === 'admin' ? values.audience.id : null,
        templateCode: values.templateCode,
        title: values.title,
        body: values.body,
        deepLinkData: values.deepLinkData ?? null,
        consultationId: values.consultationId ?? null,
      })
      .returning();
    return row;
  }

  async markSent(id: number, sentAt: Date, executor: Executor = this.db): Promise<void> {
    await executor
      .update(notificationsTable)
      .set({ status: 'sent', sentAt, failureReason: null })
      .where(eq(notificationsTable.id, id));
  }

  async markFailed(id: number, failureReason: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(notificationsTable)
      .set({ status: 'failed', failureReason })
      .where(eq(notificationsTable.id, id));
  }

  /** Newest first. The `(<audience>_id, created_at)` indexes the table already carries are exactly this query. */
  async listForAudience(
    filter: {
      audience: NotificationAudience;
      unreadOnly?: boolean;
      limit: number;
      offset: number;
    },
    executor: Executor = this.db,
  ): Promise<NotificationRow[]> {
    const conditions: SQL[] = [ownerCondition(filter.audience)];
    if (filter.unreadOnly === true) conditions.push(isNull(notificationsTable.readAt));

    return executor
      .select()
      .from(notificationsTable)
      .where(and(...conditions))
      // `id` is bigserial, so it breaks a `created_at` tie deterministically —
      // without it a page boundary can repeat or skip a row.
      .orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countUnread(audience: NotificationAudience, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(notificationsTable)
      .where(and(ownerCondition(audience), isNull(notificationsTable.readAt)));
    return Number(row?.value ?? 0);
  }

  /**
   * Marks ONE notification read, scoped to its owner in the WHERE clause.
   * Returns false when the row does not exist OR belongs to someone else —
   * the caller turns both into the same 404, so the endpoint cannot be used
   * to probe which notification ids exist.
   *
   * `coalesce` rather than an `IS NULL` predicate: marking an already-read
   * notification read again must be a no-op that still reports success (a
   * client re-opening a screen does this constantly), while the FIRST read is
   * the timestamp worth keeping. One statement does both.
   */
  async markRead(
    audience: NotificationAudience,
    id: number,
    readAt: Date,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const updated = await executor
      .update(notificationsTable)
      .set({ readAt: sql`coalesce(${notificationsTable.readAt}, ${readAt.toISOString()}::timestamptz)` })
      .where(and(eq(notificationsTable.id, id), ownerCondition(audience)))
      .returning({ id: notificationsTable.id });
    return updated.length > 0;
  }

  /** Marks every unread notification for this audience read. Returns how many rows moved. */
  async markAllRead(audience: NotificationAudience, readAt: Date, executor: Executor = this.db): Promise<number> {
    const updated = await executor
      .update(notificationsTable)
      .set({ readAt })
      .where(and(ownerCondition(audience), isNull(notificationsTable.readAt)))
      .returning({ id: notificationsTable.id });
    return updated.length;
  }
}

/**
 * The audience -> column mapping, in ONE place.
 *
 * `notifications` has three nullable owner columns rather than a
 * `(owner_type, owner_id)` pair, because each one is a real foreign key to a
 * real table — see the three `ALTER TABLE ... ADD FOREIGN KEY` statements in
 * `docs/erd.sql`. A polymorphic pair cannot be a foreign key, and would trade
 * three enforced references for none.
 */
function ownerCondition(audience: NotificationAudience): SQL {
  if (audience.kind === 'patient') return eq(notificationsTable.patientId, audience.id);
  if (audience.kind === 'doctor') return eq(notificationsTable.doctorId, audience.id);
  return eq(notificationsTable.adminId, audience.id);
}

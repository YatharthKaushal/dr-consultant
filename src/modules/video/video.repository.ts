import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';
import {
  consultationParticipantsTable,
  type ConsultationParticipantRow,
} from '../../schema/consultation-participants.schema';
import type { CallParty } from './video-room.util';
import type { VideoConfigKey } from './video.constants';

/** Either a pooled handle or an open transaction — every method takes one so a caller can compose it into its own transaction (`shared/audit/audit.service.ts`'s pattern). */
type Executor = Database | DatabaseTransaction;

/**
 * All of this module's SQL (`backend/README.md` §2: "repositories hold the
 * SQL"), against exactly one table: `consultation_participants`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * There is no `consultations`, `payments`, `patients`, `doctors` or `consents`
 * query in this file, and that is the whole boundary discipline of M-14:
 *
 *   `consultations`  is M-11's. Reads go through `BookingFacade.getBooking`,
 *                    and the two status moves through
 *                    `BookingFacade.transitionConsultationStatus`.
 *   `payments`       is M-12's, through `PaymentFacade.getByConsultationId`.
 *   `patients`       is M-04's, through `PatientFacade.getProfileSummary`.
 *   `consents`       is M-03's, through `CONSENT_PORT`.
 *
 * `consultation_participants.consultation_id` is a foreign key into
 * `consultations`, which is a REFERENCE and not a read — the FK is what keeps a
 * connection row from outliving the consultation it belongs to, and Postgres
 * enforces it without this module selecting from that table.
 *
 * The `app_config` read/write at the bottom is not an exception: `app_config`
 * is owned by no module (`payment-config.repository.ts` and
 * `instant.repository.ts` both say so), and `docs/MODULES.md` §7's
 * "configuration lives with its owning module" makes the `video.*` keys this
 * module's.
 *
 * ── IDEMPOTENCY IS THE PRIMARY KEY'S JOB ───────────────────────────────────
 *
 * `docs/erd.sql` on `livekit_participant_sid`: "LiveKit PA_xxx, unique per
 * CONNECTION - this being the key is what makes webhook redelivery
 * idempotent." Both writes below are built on that and on nothing else — no
 * preceding SELECT that two concurrent deliveries could both pass, and no
 * `video_webhook_events` table. Postgres decides.
 */
@Injectable()
export class VideoRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── Writes ───────────────────────────────────────────────────────────── */

  /**
   * Records one CONNECTION (`participant_joined`).
   *
   * *** `ON CONFLICT DO NOTHING` ON THE PRIMARY KEY IS THE IDEMPOTENCY
   * GUARANTEE. *** LiveKit retries a webhook it did not get a 2xx for, and can
   * deliver the same event twice on its own. A redelivered `participant_joined`
   * finds its sid already present and writes nothing; the row it would have
   * written is byte-for-byte the row that is already there, because both come
   * from the same event.
   *
   * *** A RECONNECT ADDS A ROW; IT NEVER OVERWRITES ONE. *** That is the whole
   * design of the table ("One row per LiveKit connection, so a reconnect adds a
   * row rather than overwriting one") and it falls out of the key: a reconnect
   * is a new LiveKit connection, so it carries a new sid, so it takes a new row
   * with no conflict to resolve.
   *
   * Returns whether a row was actually inserted, so the caller can tell a fresh
   * delivery from a replay and audit only the fresh one.
   */
  async insertConnectionIfNew(
    input: {
      livekitParticipantSid: string;
      consultationId: string;
      party: CallParty;
      joinedAt: Date;
    },
    executor: Executor = this.db,
  ): Promise<boolean> {
    const inserted = await executor
      .insert(consultationParticipantsTable)
      .values({
        livekitParticipantSid: input.livekitParticipantSid,
        consultationId: input.consultationId,
        party: input.party,
        joinedAt: input.joinedAt,
      })
      .onConflictDoNothing({ target: consultationParticipantsTable.livekitParticipantSid })
      .returning({ sid: consultationParticipantsTable.livekitParticipantSid });

    return inserted.length > 0;
  }

  /**
   * Closes one CONNECTION (`participant_left`).
   *
   * *** AN UPSERT, NOT AN UPDATE, BECAUSE THE TWO EVENTS CAN ARRIVE OUT OF
   * ORDER. *** LiveKit makes no ordering guarantee across deliveries, and a
   * retried `participant_joined` racing a fresh `participant_left` is an
   * ordinary outcome. If this were a bare UPDATE, a leave that overtook its
   * join would match no row, be silently dropped, and leave a connection open
   * forever — which would then inflate that party's duration for the rest of
   * time (`video-session.util.ts` treats a null `left_at` as running to now).
   * The insert branch carries the join time LiveKit itself reports on the
   * participant, so the row is complete either way.
   *
   * *** THE `WHERE left_at IS NULL` IS THE IDEMPOTENCY GUARD. *** A redelivered
   * `participant_left` finds the row already closed and updates nothing, so the
   * first leave time stands and a replay can never move it. Returns whether a
   * row was actually written.
   */
  async closeConnection(
    input: {
      livekitParticipantSid: string;
      consultationId: string;
      party: CallParty;
      joinedAt: Date;
      leftAt: Date;
      /** LiveKit's `DisconnectReason` verbatim. Null when it sent none. */
      disconnectReason: string | null;
    },
    executor: Executor = this.db,
  ): Promise<boolean> {
    const written = await executor
      .insert(consultationParticipantsTable)
      .values({
        livekitParticipantSid: input.livekitParticipantSid,
        consultationId: input.consultationId,
        party: input.party,
        joinedAt: input.joinedAt,
        leftAt: input.leftAt,
        disconnectReason: input.disconnectReason,
      })
      .onConflictDoUpdate({
        target: consultationParticipantsTable.livekitParticipantSid,
        set: { leftAt: input.leftAt, disconnectReason: input.disconnectReason },
        // Only an OPEN connection is closed. Without this a redelivery would
        // rewrite `left_at` to the later delivery's timestamp, and
        // `disconnect_reason` along with it.
        setWhere: isNull(consultationParticipantsTable.leftAt),
      })
      .returning({ sid: consultationParticipantsTable.livekitParticipantSid });

    return written.length > 0;
  }

  /* ── Reads ────────────────────────────────────────────────────────────── */

  /** Every connection for one consultation, `joined_at` ascending — the index on `(consultation_id, party, joined_at)` serves this directly. */
  async listConnections(
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<ConsultationParticipantRow[]> {
    return executor
      .select()
      .from(consultationParticipantsTable)
      .where(eq(consultationParticipantsTable.consultationId, consultationId))
      .orderBy(asc(consultationParticipantsTable.joinedAt));
  }

  /** One connection by its LiveKit sid, or `undefined`. */
  async findConnection(
    livekitParticipantSid: string,
    executor: Executor = this.db,
  ): Promise<ConsultationParticipantRow | undefined> {
    const [row] = await executor
      .select()
      .from(consultationParticipantsTable)
      .where(eq(consultationParticipantsTable.livekitParticipantSid, livekitParticipantSid))
      .limit(1);
    return row;
  }

  /* ── app_config (the `video.*` keys this module owns) ─────────────────── */

  /** The stored values for a set of keys. A key with no row is simply absent from the map — the caller substitutes its compiled-in fallback. */
  async findConfigByKeys(
    keys: readonly VideoConfigKey[],
    executor: Executor = this.db,
  ): Promise<Map<string, unknown>> {
    if (keys.length === 0) return new Map();

    const rows = await executor
      .select({ key: appConfigTable.key, value: appConfigTable.value })
      .from(appConfigTable)
      .where(inArray(appConfigTable.key, [...keys]));

    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /** Upserts one `video.*` key. Ownership and shape are enforced in `video-config.service.ts` BEFORE this is reached. */
  async upsertConfig(key: VideoConfigKey, value: unknown, executor: Executor = this.db): Promise<void> {
    await executor
      .insert(appConfigTable)
      .values({ key, value })
      .onConflictDoUpdate({
        target: appConfigTable.key,
        set: { value, updatedAt: new Date() },
      });
  }

  /**
   * A guard used only by the real-database integration test: how many rows one
   * consultation has, straight from Postgres.
   *
   * Kept here rather than written inline in the spec so that the test asserts
   * against the same table definition the production code writes through —
   * `and`/`sql` are imported for it, and it is the only count this module needs.
   */
  async countConnections(
    consultationId: string,
    party?: CallParty,
    executor: Executor = this.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ total: sql<number>`count(*)::int` })
      .from(consultationParticipantsTable)
      .where(
        party === undefined
          ? eq(consultationParticipantsTable.consultationId, consultationId)
          : and(
              eq(consultationParticipantsTable.consultationId, consultationId),
              eq(consultationParticipantsTable.party, party),
            ),
      );
    return row?.total ?? 0;
  }
}

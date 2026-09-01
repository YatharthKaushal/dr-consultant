import { check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { consultationsTable } from './consultations.schema';
import { partyEnum } from './enums.schema';

/**
 * One row per LiveKit connection, so a reconnect adds a row rather than
 * overwriting one. Call duration is the summed intervals, first join is
 * `min(joined_at)`, and the party with NO row here is the one that did not
 * show — none of the three is stored.
 *
 * Only `party = patient` and `party = doctor` are ever written, enforced by
 * the CHECK below (added by hand per `docs/erd.sql` — not derivable from the
 * shared `party` enum, which also has `admin`/`system`).
 */
export const consultationParticipantsTable = pgTable(
  'consultation_participants',
  {
    /** LiveKit PA_xxx, unique per CONNECTION — this being the key is what makes webhook redelivery idempotent. */
    livekitParticipantSid: varchar('livekit_participant_sid', { length: 64 }).primaryKey(),
    /** Parsed from the room name, which is a function of this id. */
    consultationId: uuid('consultation_id')
      .notNull()
      .references(() => consultationsTable.id),
    party: partyEnum('party').notNull(),
    /** participant_joined webhook. */
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** participant_left webhook. Null = still connected, or the webhook never arrived. */
    leftAt: timestamp('left_at', { withTimezone: true, mode: 'date' }),
    /** LiveKit DisconnectReason verbatim. Not an enum: LiveKit owns this vocabulary. */
    disconnectReason: varchar('disconnect_reason', { length: 40 }),
  },
  (table) => [
    index().on(table.consultationId, table.party, table.joinedAt),
    check(
      'consultation_participants_party_check',
      sql`${table.party} in ('patient', 'doctor')`,
    ),
  ],
);

export type ConsultationParticipantRow = typeof consultationParticipantsTable.$inferSelect;
export type NewConsultationParticipantRow = typeof consultationParticipantsTable.$inferInsert;

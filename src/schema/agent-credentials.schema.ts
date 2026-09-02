import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { agentProfilesTable } from './agent-profiles.schema';

/**
 * One API key for one `agent_profiles` row, plus the health record rotation
 * keeps on it. A profile has many keys on purpose: the client owns the
 * provider account and is billed at actuals, so a key that has burned its
 * quota, been revoked, or hit a per-minute ceiling must step aside for the
 * next one without a human in the loop and without a deploy.
 *
 * `encrypted_key` is AES-256-GCM ciphertext produced by `ai-crypto.service.ts`
 * (`v1:iv:authTag:ciphertext`, all base64url), never a plaintext key. It is
 * decrypted only in memory, only at call time, and never leaves this module:
 * no DTO, mapper, log line or `audit_log` row may carry it. `key_last4` is
 * the only fragment anything outside this module ever sees, rendered as
 * `****1234`.
 *
 * `key_last4` is stored rather than derived because deriving it would mean
 * decrypting — i.e. touching the master key — just to render an admin list
 * screen. Four characters is not enough to attack a key with, and keeping it
 * in the clear means the read path for the admin panel never needs the
 * encryption key at all.
 *
 * The health columns are written after every attempt (`ai-rotation.service.ts`)
 * and are deliberately plain columns, not a separate events table: rotation
 * only ever needs the CURRENT state of a key, and an append-only attempt log
 * on the request path would cost a write per attempt for data nothing reads.
 * The audit trail for admin ACTIONS on a credential still goes to `audit_log`
 * as usual; this is operational state, not an audit record.
 *
 *   - `consecutive_failures` — resets to 0 on any success. A monitoring
 *     signal for the admin panel, NOT an auto-disable trigger.
 *   - `last_failure_kind` — the classified `LlmFailureKind`
 *     (`llm-provider.types.ts`), so the panel can say "quota exhausted"
 *     rather than "it broke". `varchar(40)`, not an enum, for the same
 *     migration-cost reason `agent_profiles.provider` is not an enum: the
 *     failure taxonomy is ours and will grow.
 *   - `cooldown_until` — the ONLY automatic mechanism that takes a key out of
 *     rotation, and it is always temporary. Set from the vendor's own
 *     `Retry-After` when it gives one, else `ai.default_cooldown_seconds`.
 *     A credential whose `cooldown_until` is in the future is skipped when
 *     the candidate list is built; nothing needs to clear it on a timer.
 *
 * Enable/disable (`is_active`) is strictly an admin decision. Nothing in this
 * module ever writes it automatically — see the comment on
 * `ai-rotation.service.ts#recordFailure`.
 */
export const agentCredentialsTable = pgTable(
  'agent_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      // ON DELETE CASCADE is a data-integrity BACKSTOP, not the API's
      // behaviour. A credential is meaningless without its profile — it names
      // no provider, model or endpoint of its own — so a row deleted straight
      // from SQL must not strand encrypted key material no screen can reach.
      //
      // The admin-facing delete never relies on it: `agent-profile.service.ts`
      // REFUSES to delete a profile that still has credentials (409
      // `PROFILE_HAS_CREDENTIALS`) and makes the admin remove them one by one
      // first. Deliberately the stricter of the two options — cascading would
      // destroy N irrecoverable third-party keys behind a single click, and
      // would leave one audit row naming the profile instead of one per key,
      // losing the record of what was actually thrown away.
      .references(() => agentProfilesTable.id, { onDelete: 'cascade' }),
    /** Admin-facing label, e.g. "prod key 1", "billing account B". Unique per profile so two keys are never ambiguous in the panel. */
    label: varchar('label', { length: 120 }).notNull(),
    /** AES-256-GCM ciphertext, `v1:iv:authTag:ciphertext`. NEVER plaintext. See `ai-crypto.service.ts`. */
    encryptedKey: text('encrypted_key').notNull(),
    /** Last four characters of the plaintext key, for display only (`****1234`). */
    keyLast4: varchar('key_last4', { length: 4 }).notNull(),
    /** Inner sort key of the rotation candidate list, within a profile. Lower runs first. */
    priority: smallint('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),

    /* Health — written by `ai-rotation.service.ts` after every attempt. */
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
    /** A `LlmFailureKind` value. NULL until the first failure. */
    lastFailureKind: varchar('last_failure_kind', { length: 40 }),
    /** Skipped by rotation while this is in the future. The only automatic take-out-of-rotation mechanism. */
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true, mode: 'date' }),
    lastSucceededAt: timestamp('last_succeeded_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // The admin panel's per-profile credential list, in the order rotation
    // would try them.
    index().on(table.profileId, table.priority),
    // Partial, filtered on `is_active`: the rotation candidate query only ever
    // looks at active credentials, and in steady state that is a small subset
    // of the table (dead keys are disabled, not deleted, so the admin keeps
    // the history). Postgres can use this index for that query without
    // touching disabled rows at all.
    index('agent_credentials_active_priority_idx')
      .on(table.profileId, table.priority)
      .where(sql`${table.isActive}`),
    // An admin cannot create two same-named keys under one profile — the
    // label is how they tell keys apart, since they can never see the keys.
    uniqueIndex().on(table.profileId, table.label),
  ],
);

export type AgentCredentialRow = typeof agentCredentialsTable.$inferSelect;
export type NewAgentCredentialRow = typeof agentCredentialsTable.$inferInsert;

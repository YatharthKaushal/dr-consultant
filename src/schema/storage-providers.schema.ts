import { boolean, index, jsonb, pgTable, smallint, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Non-secret, per-provider settings for `modules/storage`'s two blob-storage
 * backends. Bucket/region/custom-endpoint for S3, cloud name for Cloudinary —
 * nothing here is sensitive, which is the whole point of this table's shape.
 * See the table comment for what is deliberately NOT here.
 */
export interface StorageProviderConfig {
  /** `provider = 's3'` only. */
  bucket?: string;
  /** `provider = 's3'` only. AWS region, e.g. `ap-south-1`. */
  region?: string;
  /** `provider = 's3'` only. Override endpoint for an S3-compatible host (R2, MinIO, a self-hosted gateway). Omit for real AWS S3. */
  endpoint?: string;
  /** `provider = 'cloudinary'` only. */
  cloudName?: string;
}

/**
 * One row per blob-storage backend `modules/storage` knows how to talk to —
 * today exactly two: `s3` (primary) and `cloudinary` (automatic secondary).
 * Seeded once by `storage.seed.ts`, never created or deleted through the API
 * (`storage-admin.controller.ts` has no POST/DELETE, PATCH only) — this table
 * is admin-EDITABLE, not admin-EXTENSIBLE.
 *
 * ── No encrypted-credential column, unlike `agent_credentials` ──────────────
 *
 * `agent_credentials` exists because an admin can add an arbitrary number of
 * third-party LLM API keys over time — different vendors, different accounts,
 * rotated on demand — so each one is a secret this application legitimately
 * had to accept, store and protect at rest (AES-256-GCM, `ai-crypto.service.
 * ts`, its own master-key env var).
 *
 * This table has no analog of that because the credential model here is
 * deliberately different, not because the AI module's approach was skipped by
 * oversight: the actual secrets (AWS access key/secret, Cloudinary API
 * key/secret) live ONLY in environment variables (`S3_ACCESS_KEY_ID` /
 * `S3_SECRET_ACCESS_KEY` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`, see
 * `env.validation.ts`) — exactly like `DATABASE_URL` and the JWT secrets
 * already do — matching SRS 6.1 verbatim: secrets are held in the cloud
 * environment, never in the app bundle (and never in Postgres). There is
 * exactly ONE S3 bucket and ONE Cloudinary account for the whole platform,
 * provisioned once by whoever deploys it — not an admin experimenting with
 * multiple vendor keys the way LLM credentials are. Building a crypto service
 * and a second master-key env var for a threat model of "one secret pair per
 * provider, set once at deploy time, changed by redeploying" would be
 * over-engineering: env vars already are the at-rest protection for exactly
 * that shape of secret everywhere else in this codebase.
 *
 * What DOES live here is everything that is NOT a secret and that an admin
 * plausibly needs to change without a redeploy: which bucket/cloud account to
 * use, whether a provider is enabled, which one is tried first, and the
 * automatic health/cooldown state `storage-rotation.service.ts` maintains —
 * the exact non-secret slice of `agent_profiles`' job, minus the one-to-many
 * credential relationship `agent_credentials` exists for.
 *
 * ── `provider` is UNIQUE — one row per provider, not many keys per provider ─
 *
 * This is the opposite cardinality from `agent_profiles`/`agent_credentials`,
 * where many rows can legitimately share a `provider` value (many OpenAI-
 * compatible profiles, many keys per profile). Here `provider` is the
 * table's natural key: there is exactly one S3 configuration and exactly one
 * Cloudinary configuration for the whole platform, so "the row for s3" must
 * be unambiguous. The unique constraint is what makes `storage-provider.
 * repository.ts#findByProvider` — the lookup `getSignedUrl`/`delete` use to
 * resolve a storage key's provider prefix back to its config — a single-row
 * answer by construction, and it is what `storage.seed.ts`'s
 * `ON CONFLICT (provider) DO NOTHING` upsert targets.
 *
 * ── `provider`: bare `varchar(20)`, no `pgEnum`, no CHECK ───────────────────
 *
 * Same choice, and the same reasoning, as `agent_profiles.provider` (see that
 * file) — restated here because the list this column names is explicitly
 * expected to grow (Azure Blob, GCS, Cloudflare R2 are all plausible future
 * backends behind the same `StorageProviderAdapter` interface):
 *
 *   - A `pgEnum` needs `ALTER TYPE ... ADD VALUE` — a migration — before a new
 *     provider's seed row can exist, even though nothing about the VALUE SET
 *     changes at the database layer (Postgres does not care what the string
 *     says).
 *   - A `varchar` + CHECK needs the CHECK dropped and recreated. Same cost.
 *   - A bare `varchar` needs nothing: adding a provider is one entry in
 *     `STORAGE_PROVIDER_CODES` (`storage.constants.ts`), one new adapter
 *     class, one line in `StorageProviderRegistry`, and one row in
 *     `storage.seed.ts`. No DB change.
 *
 * The case for skipping a CHECK here is in fact STRONGER than
 * `agent_profiles.provider`'s: that table accepts arbitrary admin input
 * indirectly (an admin picks a provider when creating a profile via the API).
 * This table has no INSERT path through the API at all — the only writer of
 * `provider` is `storage.seed.ts`, which is source-controlled code, not user
 * input. The value set is validated exactly once, at the one place a row can
 * ever be created. `StorageProviderRegistry.find()` still answers an
 * unrecognised value with `null` rather than throwing, so a row written by a
 * newer build (or restored from a dump) degrades to "this provider is
 * skipped by rotation" instead of poisoning every operation.
 */
export const storageProvidersTable = pgTable(
  'storage_providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** One of `STORAGE_PROVIDER_CODES` (`storage.constants.ts`). Unique — see the table comment. */
    provider: varchar('provider', { length: 20 }).notNull().unique(),
    /** Admin kill switch for a whole provider. Rotation also has an automatic mechanism (`cooldown_until`); the two are strictly separate — nothing in `storage-rotation.service.ts` ever writes `is_active`, exactly as `agent_credentials.is_active` is admin-only. */
    isActive: boolean('is_active').notNull().default(true),
    /** Outer sort key of the rotation candidate list (`storage-rotation.service.ts`) — lower runs first, so S3 (primary) is tried before Cloudinary (secondary). `smallint` because it is an ordering hint, never arithmetic. */
    priority: smallint('priority').notNull().default(100),
    /** Non-secret settings only — see `StorageProviderConfig` and the table comment. `{}` until an admin fills it in via `PATCH /admin/storage/providers/:id`. */
    config: jsonb('config').$type<StorageProviderConfig>().notNull().default({}),

    /* Health — written by `storage-rotation.service.ts` after every attempt, same discipline as `agent_credentials`'. */
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
    /** A `StorageFailureKind` value (`storage.constants.ts`). `varchar(40)`, not an enum, for the same migration-cost reason `provider` is not one. NULL until the first failure. */
    lastFailureKind: varchar('last_failure_kind', { length: 40 }),
    /** Skipped by rotation while this is in the future. The only automatic take-out-of-rotation mechanism — see `agent_credentials.cooldown_until`'s comment for why this is preferred over disabling. */
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true, mode: 'date' }),
    lastSucceededAt: timestamp('last_succeeded_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  // Serves the rotation candidate query — "active providers, cheapest
  // priority first" — the only read on this table that runs on a request
  // path rather than in the admin panel. Same shape as `agent_profiles`' index.
  (table) => [index().on(table.isActive, table.priority)],
);

export type StorageProviderRow = typeof storageProvidersTable.$inferSelect;
export type NewStorageProviderRow = typeof storageProvidersTable.$inferInsert;

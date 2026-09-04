import type { AuditAction } from '../../schema/enums.schema';

/* -------------------------------------------------------------------------- */
/* Pagination (search + export)                                               */
/* -------------------------------------------------------------------------- */

export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;
export const AUDIT_MAX_OFFSET = 100_000;

/**
 * Row cap on the CSV export, mirroring `payment.constants.ts#PAYMENT_EXPORT_
 * MAX_ROWS` and `governance.constants.ts#GOVERNANCE_EXPORT_MAX_ROWS` — a cap
 * is honest about the memory a single in-process render costs. `audit_log`
 * is the one table in this codebase every other module writes into, so this
 * is set generously above any of theirs.
 */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/* -------------------------------------------------------------------------- */
/* Retention — the client-configurable window, and what it may ever touch    */
/* -------------------------------------------------------------------------- */

/**
 * `app_config` keys M-21 OWNS. `docs/MODULES.md` §7's rule ("configuration
 * lives with its owning module") plus M-21's own "Data owned: ... retention
 * settings" put the audit-log retention window here — the same shape every
 * other owning-module config service (`payment-config.service.ts`,
 * `search-config.service.ts`) already uses.
 */
export const AUDIT_CONFIG_KEYS = {
  /** Integer days, or `0` = purging is OFF. See `audit-retention-sweep.service.ts`'s header for why `0` is the shipped default. */
  RETENTION_DAYS: 'audit.retention_days',
} as const;
export type AuditConfigKey = (typeof AUDIT_CONFIG_KEYS)[keyof typeof AUDIT_CONFIG_KEYS];
export const AUDIT_CONFIG_KEY_LIST: readonly AuditConfigKey[] = Object.values(AUDIT_CONFIG_KEYS);

/** `0` — retention purging ships OFF. See `audit-retention-sweep.service.ts`'s header for the full reasoning: SRS §5.3 never mentions `audit_log`, so nothing is purged until a client explicitly opts in. */
export const AUDIT_CONFIG_FALLBACKS = {
  RETENTION_DAYS: 0,
} as const;

/** `0` (disabled) is always legal outside these bounds; a non-zero window must fall inside them. Floor of 30 days keeps a client from accidentally configuring away last week's evidence; ceiling of 10 years is a sanity bound, not a legal one — actual retention law is the client's call (SRS §5.3), this just stops a fat-fingered `99999999`. */
export const AUDIT_RETENTION_DAYS_BOUNDS = { min: 30, max: 3650 };

/**
 * *** THE RETENTION-ELIGIBILITY DECISION. THIS IS THE WHOLE POINT. ***
 *
 * SRS §5.3 ("Retention") says: "Medical record retention rules and patient
 * data handling obligations are set by the client under applicable data
 * protection law. The system stores clinical notes, prescriptions, files and
 * appointment logs; it does not store video or audio of consultations." That
 * sentence is about `clinical_records`/`patient_files`/`appointments` — the
 * MEDICAL record. It says NOTHING about `audit_log`, anywhere. Silence is
 * not permission.
 *
 * Read against SRS §5.2 ("Audit logs record who accessed or changed clinical
 * and financial records, and when"), §6.7 (Auditability) and this module's
 * own `docs/MODULES.md` done-when — "a clinical record READ, a REFUND and a
 * CONFIGURATION CHANGE each leave a COMPLETE entry" — the entries this table
 * exists to hold are, by name, exactly the ones a retention sweep must never
 * touch: every `create`/`update`/`delete` (who changed what), every `read`/
 * `export` this M-21 round just finished wiring up for clinical and
 * financial data (who saw what), and every `webhook` (SRS §6.1: "payment
 * status is trusted only from verified gateway webhooks" — the trust trail
 * for that trust).
 *
 * What is left, and all that is left, is authentication noise —
 * `audit-log.schema.ts`'s own doc comment says this table "Absorbs the
 * login-attempt log (`action = login`...) and the credential sign-off trail
 * (`action = verify`)". Those two actions were never evidence of who saw or
 * changed a clinical or financial record; they are the rate-limiting/session
 * bookkeeping this table happens to also hold. THIS is the safe, narrow set
 * a client-configured window may ever delete.
 *
 * `entity_type` is deliberately NOT part of this decision. `entity_type` is
 * a free-form `varchar` written by ~20 other modules' own constants files
 * (`CLINICAL_AUDIT_ENTITY_TYPES`, `PAYMENT_AUDIT_ENTITY_TYPES`, ...) — hand-
 * classifying every one of them as "financial"/"clinical"/"safe" from this
 * module would mean either reaching into files this build's guardrails keep
 * this worktree out of, or trusting a list that silently goes stale the next
 * time any of those ~20 modules adds an entity type. `action` is already a
 * small, closed, schema-level enum this module owns the read side of
 * (`enums.schema.ts#AUDIT_ACTIONS`), and it alone is enough to keep every
 * create/update/delete/read/export/webhook row — regardless of which module
 * or table it is about — out of reach of this sweep.
 */
export const AUDIT_PURGE_ELIGIBLE_ACTIONS: readonly AuditAction[] = ['login', 'verify'];

/* -------------------------------------------------------------------------- */
/* Retention sweep scheduling                                                 */
/* -------------------------------------------------------------------------- */

/** Hourly — this is authentication noise cleanup, not a time-critical reconciliation; nothing downstream is waiting on it the way `clinical-gate-sweep.service.ts`'s doctor-gate repair is. */
export const AUDIT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Rows deleted per batch statement. */
export const AUDIT_RETENTION_SWEEP_BATCH_SIZE = 1_000;
/** Bounds one tick's total work — see `clinical-gate-sweep.service.ts`'s header for why an unbounded pass is a self-inflicted load spike, and why hitting this is reported rather than silently absorbed. */
export const AUDIT_RETENTION_SWEEP_MAX_BATCHES = 50;

/* -------------------------------------------------------------------------- */
/* Audit — what THIS module itself writes to `audit_log`                      */
/* -------------------------------------------------------------------------- */

export const AUDIT_AUDIT_ENTITY_TYPES = {
  /** One `audit.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'audit_config',
  /** A CSV export of the log itself (SRS 6.7-shaped, extended to the log M-21 owns). */
  EXPORT: 'audit_log_export',
  /** *** THE MODULE THAT DELETES EVIDENCE LOGS ITS OWN DELETIONS. *** Written by `system`, best-effort, once per non-empty sweep pass — see `audit-retention-sweep.service.ts`. */
  RETENTION_PURGE: 'audit_log_retention_purge',
} as const;

export const AUDIT_ERROR_CODES = {
  CONFIG_INVALID: 'AUDIT_CONFIG_INVALID',
  CONFIG_KEY_NOT_OWNED: 'AUDIT_CONFIG_KEY_NOT_OWNED',
} as const;
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[keyof typeof AUDIT_ERROR_CODES];

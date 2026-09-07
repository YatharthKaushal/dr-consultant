import type { ConsultationStatus, DeletionStatus } from '../../schema/enums.schema';

/**
 * `'soft_delete'` is ADDITIVE (account-deletion lifecycle round) — replaces
 * what `patients` used to be (`'anonymize'`, destroying `fullName`/
 * `dateOfBirth` in place). A soft delete keeps identity fields live in
 * storage (masked at READ time instead, `shared/privacy/mask.util.ts`) and
 * is REVERSIBLE by an admin `restore` — an `anonymize` never was. See
 * `patient.service.ts#softDeleteForDeletionRequest`'s header for the full
 * account of why the earlier design made "the admin can restore any
 * deleted account forever" untrue.
 */
export type DataRightsDecision = 'hard_delete' | 'anonymize' | 'soft_delete' | 'retain';

/**
 * One row of the M-21 per-table survey (see `data-rights.constants.ts`),
 * enriched with a live row count. This is what `previewExecution` returns —
 * a description of what WOULD happen, never a record of what did.
 */
export interface DataRightsTableEntry {
  /** Postgres table name, snake_case, matching `src/schema/*.schema.ts`. */
  table: string;
  /** The module that owns this table's schema and writes it. */
  module: string;
  decision: DataRightsDecision;
  /**
   * Live count of rows this patient/their consultations have in this table,
   * as of the moment `previewExecution` (or `executeForRequest`, before it
   * mutates anything) ran. `null` only for `audit_log` — see its own entry
   * in `data-rights.constants.ts` for why this module deliberately does not
   * compute that count itself.
   */
  rowCount: number | null;
  /** Present for `decision: 'retain'`. The lawful ground, citing SRS/MODULES.md. */
  reason?: string;
  /** Present for `decision: 'anonymize'`. Exactly which columns are nulled/replaced — nothing else on the row changes. */
  columnsAffected?: string[];
  /**
   * True when a human — not this code — should make the final call on this
   * table, per the brief's own instruction to flag genuine uncertainty
   * rather than guess wrong in the destructive direction. The `decision`
   * field is still the SAFE DEFAULT this code actually acts on (always
   * `retain` when this flag is set) — never a placeholder.
   */
  flaggedForHumanDecision?: boolean;
  /** Present when `flaggedForHumanDecision` is true — why this one is genuinely unresolved. */
  humanDecisionNote?: string;
}

/**
 * ADDITIVE (open-obligations round). One consultation `executeForRequest`
 * would refuse to run past — see `DataRightsService#computeOpenObligations`.
 * `paymentStatus` is `null` when no `payments` row exists at all for this
 * consultation (an unpaid, never-checked-out draft is still an obligation —
 * the slot itself is still held).
 */
export interface DataRightsOpenObligation {
  consultationId: string;
  status: ConsultationStatus;
  scheduledStartAt: string | null;
  paymentStatus: string | null;
}

/**
 * `previewExecution`'s full return value. Writes nothing — see
 * `data-rights.service.ts`.
 *
 * *** ADDITIVE (account-deletion lifecycle round): `doctorId` JOINS
 * `patientId`, BOTH NOW NULLABLE. *** Exactly one is set, mirroring
 * `data-deletion-requests.schema.ts`'s own `account_xor_check` — a doctor's
 * own request previews the (much shorter) `DOCTOR_TABLE_SURVEY` instead of
 * the patient one. Kept as a pair rather than renamed to a generic
 * `accountType`/`accountId` to minimise churn on every existing
 * patient-path caller/test that already reads `.patientId`.
 */
export interface DataRightsPreview {
  requestId: string;
  patientId: string | null;
  doctorId: string | null;
  /** The request's CURRENT status at the moment of preview — read-only context, not a precondition preview itself enforces. */
  requestStatus: DeletionStatus;
  tables: DataRightsTableEntry[];
  /**
   * ADDITIVE (open-obligations round). Every consultation still open right
   * now — an admin reviewing this preview BEFORE approving sees exactly
   * what `executeForRequest` would refuse on. Empty when there is nothing
   * outstanding. Reporting this here is informational only; `previewExecution`
   * itself still writes nothing and enforces nothing.
   */
  openObligations: DataRightsOpenObligation[];
  generatedAt: string;
}

/** One mutating step's real outcome — the only kind of table entry that can ever fail independently of the others. */
export interface DataRightsStepOutcome {
  table: string;
  module: string;
  decision: Extract<DataRightsDecision, 'hard_delete' | 'anonymize' | 'soft_delete'>;
  status: 'success' | 'failed';
  /** Rows removed (hard_delete) or rows changed (anonymize). Present only on `status: 'success'`. */
  rowsAffected?: number;
  /** `Error#message`, present only on `status: 'failed'`. Never a stack trace — this is written to `data_deletion_requests.execution_outcome`, a durable compliance record, not a debug log. */
  error?: string;
}

/**
 * The exact shape written to `data_deletion_requests.execution_outcome`.
 * `data-deletion-requests.schema.ts`'s own comment on that column is the
 * contract this satisfies: "per-table counts, lawful retention grounds, or
 * a failure reason."
 */
export interface DataRightsExecutionOutcome {
  requestId: string;
  /** ADDITIVE (account-deletion lifecycle round): `doctorId` joins `patientId`, both nullable — exactly one set, same as `DataRightsPreview`. */
  patientId: string | null;
  doctorId: string | null;
  executedAt: string;
  /**
   * `'executed'` only when EVERY mutating step succeeded. `'failed'` the
   * moment even one did not — see `data-rights.service.ts#executeForRequest`
   * for why there is no third, "partial" value: `deletion_status` has no
   * such state, and reporting `'executed'` for a run that left even one
   * table untouched would be the exact false-success the brief prohibits.
   * `mutatingSteps` below is what distinguishes "nothing succeeded" from
   * "two of three succeeded" within a `'failed'` outcome — read it, not
   * just this one field.
   */
  overallStatus: 'executed' | 'failed';
  /** One entry per table this execution attempted to hard-delete or anonymize, in the order attempted. */
  mutatingSteps: DataRightsStepOutcome[];
  /** Every RETAIN table from the preview, carried into the permanent record — so the outcome alone (without re-reading the survey) states what was deliberately left untouched and why. */
  retainedTables: DataRightsTableEntry[];
}

export interface DataRightsExecutionResult {
  requestId: string;
  patientId: string | null;
  doctorId: string | null;
  status: Extract<DeletionStatus, 'executed' | 'failed'>;
  executionOutcome: DataRightsExecutionOutcome;
}

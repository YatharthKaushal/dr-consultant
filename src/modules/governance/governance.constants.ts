/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

/** Working-queue page size, mirroring `followup.constants.ts`'s `FOLLOWUP_DEFAULT_PAGE_SIZE`/`FOLLOWUP_MAX_PAGE_SIZE`. */
export const GOVERNANCE_DEFAULT_PAGE_SIZE = 20;
export const GOVERNANCE_MAX_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* CSV export                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Row cap on a queue export, mirroring `payment.constants.ts`'s
 * `PAYMENT_EXPORT_MAX_ROWS` — see that constant's own comment: "a cap is
 * honest about the memory this costs." Governance's queues are backlogs, not
 * historical ledgers, so this is generously larger than any real backlog is
 * ever expected to be; hitting it is a signal something else is wrong, not a
 * routine event.
 */
export const GOVERNANCE_EXPORT_MAX_ROWS = 10_000;

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

/** `audit_log.entity_type` values this module writes — only the CSV export leaves a trail; every other read is a live composition across other modules' own already-audited data. */
export const GOVERNANCE_AUDIT_ENTITY_TYPES = {
  PENDING_CASE_SUMMARIES_EXPORT: 'governance_pending_case_summaries_export',
  SAFETY_ALERTS_EXPORT: 'governance_safety_alerts_export',
} as const;

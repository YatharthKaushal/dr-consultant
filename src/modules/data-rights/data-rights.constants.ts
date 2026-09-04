import type { DataRightsTableEntry } from './data-rights.types';

/**
 * Error-code vocabulary this module's controller surfaces. No
 * `audit_log.entity_type` constant here — this module never calls
 * `AuditService` directly; every audit entry an execution produces is
 * written by the owning module doing the actual write (`patient.service.ts
 * #anonymizeForDeletion`) or by `DataDeletionService#recordExecutionOutcome`
 * itself for the request's own status transition.
 */
export const DATA_RIGHTS_ERROR_CODES = {
  DATA_DELETION_REQUEST_NOT_FOUND: 'DATA_DELETION_REQUEST_NOT_FOUND',
  /** Mirrors `DataDeletionService#recordExecutionOutcome`'s own guard — surfaced here so a caller of THIS module's endpoints sees the same code without reading M-03's. */
  DATA_DELETION_NOT_APPROVED: 'DATA_DELETION_NOT_APPROVED',
} as const;

/**
 * *** THE M-21 PER-TABLE SURVEY — THE POLICY, KEPT IN ONE PLACE. ***
 *
 * Every table in `src/schema/` that references a patient directly
 * (`patient_id`) or through a consultation (`consultation_id` on a table
 * belonging to that patient's consultations), with the decision this build
 * makes for it and the lawful reason where the decision is `retain`.
 *
 * *** WHY THIS LIST LIVES HERE AND NOT SCATTERED ACROSS THE COUNT METHODS
 * THIS MODULE CALLS. *** Each owning module's `count*ForConsultations`/
 * `count*ForPatient` method answers "how many rows", a pure mechanical fact.
 * WHETHER that table is hard-deleted, anonymized or retained — and WHY — is
 * a compliance decision, and compliance decisions belong to the module that
 * owns compliance (this one), not to fifteen different owning modules each
 * independently re-deciding it. `data-rights.service.ts#previewExecution`
 * merges this static policy with a live row count from each owning module.
 *
 * *** `rowCount` IS DELIBERATELY ABSENT FROM THIS TABLE. *** It is filled
 * in at request time — a `count(*)` from months ago would be a lie by the
 * time an admin reads it.
 *
 * Money and audit rows retain by the brief's own explicit default
 * (`payments`, `refunds`, `audit_log`); every other `retain` below states
 * its own specific, cited reason — never "seems important".
 *
 * Two entries carry `flaggedForHumanDecision: true`. Both still execute as
 * `retain` (the safe default the brief asks for when genuinely unsure) —
 * the flag exists so a human reads the open question, not so the code
 * silently guesses.
 */
export const STATIC_TABLE_SURVEY: ReadonlyArray<Omit<DataRightsTableEntry, 'rowCount'>> = [
  // ── The one table this execution actually anonymizes as its centrepiece ──
  {
    table: 'patients',
    module: 'patient',
    decision: 'anonymize',
    columnsAffected: ['full_name', 'date_of_birth', 'mobile_number', 'push_token', 'device_id', 'status (-> deleted)'],
  },

  // ── Hard-deleted ──────────────────────────────────────────────────────
  {
    table: 'search_queries',
    module: 'search',
    decision: 'hard_delete',
  },

  // ── Anonymized in place ───────────────────────────────────────────────
  {
    table: 'promotion_code_attempts',
    module: 'promotion',
    decision: 'anonymize',
    columnsAffected: ['patient_id', 'ip_address'],
  },

  // ── Retained: clinical/medical-record chain (SRS §5.2 links booking, ────
  //    payment, session metadata, documents, notes, prescription and case
  //    summary through one consultation ID; SRS §5.3/§8 leave medical-
  //    record retention to the client under applicable law) ──────────────
  {
    table: 'consultations',
    module: 'booking',
    decision: 'retain',
    reason:
      'Backbone of the one-consultation-ID clinical record chain (SRS §5.2); medical-record retention rests with the client under applicable law (SRS §5.3, §8).',
  },
  {
    table: 'clinical_records',
    module: 'clinical',
    decision: 'retain',
    reason: 'Diagnosis, prescription and case summary — the medical record itself (SRS §5.3, §8).',
  },
  {
    table: 'checkin_responses',
    module: 'followup',
    decision: 'retain',
    reason: 'Part of the seven-day follow-up clinical record (SRS §5.3).',
  },
  {
    table: 'safety_alerts',
    module: 'followup',
    decision: 'retain',
    reason: 'Safety-incident record evidencing the crisis-response duty (SRS §6.3) and part of the clinical record (SRS §5.3).',
  },
  {
    table: 'followup_assignments',
    module: 'followup',
    decision: 'retain',
    reason: 'Records which follow-up pathway version applied and when — part of the clinical follow-up record (SRS §5.3).',
  },
  {
    table: 'consultation_participants',
    module: 'video',
    decision: 'retain',
    reason:
      'Session metadata SRS §5.2 names explicitly as part of the linked consultation record; also the only evidence separating a hang-up from a dropped network when adjudicating a technical-issue complaint or refund.',
  },
  {
    table: 'patient_files',
    module: 'document',
    decision: 'retain',
    flaggedForHumanDecision: true,
    humanDecisionNote:
      'Genuinely unresolved: these are the rawest patient-identifying artefacts on the platform (scanned reports, prescription PDFs), which argues for deletion — but they may also be part of the mandated medical record (SRS §5.3), which argues against it. The right answer is category-dependent (a lab report vs. a generated prescription PDF vs. a patient-uploaded ID-adjacent file) and the SRS does not specify a per-category retention period. Retained untouched pending that decision.',
    reason: 'Retained pending a human decision — see humanDecisionNote.',
  },
  {
    table: 'report_requests',
    module: 'document',
    decision: 'retain',
    reason: "Part of the clinical documentation chain (a doctor's request for a report) — SRS §5.3.",
  },
  {
    table: 'clarification_cases',
    module: 'clarification',
    decision: 'retain',
    reason:
      "Already structurally de-identified (age/gender/history only, never a name); source_consultation_id is kept by the schema's own design 'for the treating doctor and audit ONLY' — an audit linkage this table's own header establishes, not an oversight.",
  },
  {
    table: 'instant_consultancy',
    module: 'instant',
    decision: 'retain',
    reason:
      "Operational routing history feeding the doctor reliability metrics (FR-18.6) — a record about doctor performance; carries no patient identifier beyond the consultation link.",
  },
  {
    table: 'content_recommendations',
    module: 'carehub',
    decision: 'retain',
    reason: "Part of the doctor's documented care plan for the consultation — clinical record chain (SRS §5.3).",
  },

  // ── Retained: legal/compliance evidence ──────────────────────────────
  {
    table: 'consents',
    module: 'consent',
    decision: 'retain',
    reason:
      "Append-only legal evidence of consent (SRS §5.2: 'Consent records are versioned and time-stamped') — this platform's own proof it obtained consent before providing a teleconsultation.",
  },
  {
    table: 'audit_log',
    module: 'shared/audit',
    decision: 'retain',
    reason:
      "SRS §5.2: 'Audit logs record who accessed or changed clinical and financial records, and when' — an immutable compliance trail (SRS §8). The brief's own explicit default for money/audit rows.",
    humanDecisionNote:
      "This module deliberately does NOT compute a row count for audit_log — the parallel M-21 audit-search track (src/modules/audit/, a separate worktree) owns log search/export, and duplicating query logic against a table under its active development risked conflicting with that work. rowCount is reported as null; see the coordinator's report.",
  },

  // ── Retained: explicit product requirement ───────────────────────────
  {
    table: 'feedback',
    module: 'feedback',
    decision: 'retain',
    reason: "M-19's own done-when (docs/MODULES.md): 'a complaint can be raised, tracked and closed with its full history kept.'",
  },
  {
    table: 'complaints',
    module: 'feedback',
    decision: 'retain',
    reason: "M-19's own done-when (docs/MODULES.md): 'a complaint can be raised, tracked and closed with its full history kept.'",
  },

  // ── Retained: operational/audit-adjacent, flagged as a closer call ───
  {
    table: 'notifications',
    module: 'notification',
    decision: 'retain',
    flaggedForHumanDecision: true,
    humanDecisionNote:
      'A closer call than the others: this is a delivery log, not a clinical or financial record. Retained because the body is template-rendered copy that by design (FR-16.2) never names a diagnosis, and the row is evidence of what the platform actually communicated and when (dispute value, e.g. "I was never notified" on a red-flag alert) — but a reasonable alternative decision is to hard-delete it once the request executes.',
    reason: 'Operational delivery/audit record — see humanDecisionNote for the alternative reading.',
  },
  {
    table: 'search_rate_limits',
    module: 'search',
    decision: 'retain',
    reason:
      "Rate-limit counter, deliberately built with no FK to patients (its own schema header: outlives the account it counted) so it is unaffected by patient anonymization; carries no identifying content beyond a timestamp/source and a bare patient_id pointer to the now-anonymized patient row.",
  },

  // ── Retained: financial / anti-fraud ledgers ─────────────────────────
  {
    table: 'discount_instruments',
    module: 'promotion',
    decision: 'retain',
    reason: 'Referral/voucher/coupon ledger — anti-fraud caps (one referral per patient, single-use-per-user) depend on this history.',
  },
  {
    table: 'discount_redemptions',
    module: 'promotion',
    decision: 'retain',
    reason: 'Financial redemption ledger — reconciliation and cap enforcement.',
  },
  {
    table: 'affiliate_attributions',
    module: 'promotion',
    decision: 'retain',
    reason: 'Attribution ledger underpinning partner commission calculation — financial record.',
  },
  {
    table: 'affiliate_commissions',
    module: 'promotion',
    decision: 'retain',
    reason: 'Money owed to a partner — financial record.',
  },
  {
    table: 'referral_events',
    module: 'promotion',
    decision: 'retain',
    reason: "Anti-farming ledger ('referred once, ever' constraint) and reward-minting record — financial/anti-fraud.",
  },
  {
    table: 'price_quotes',
    module: 'pricing',
    decision: 'retain',
    reason: 'GST invoice detail (place of supply, tax breakdown) underlying a payment — financial record-keeping.',
  },
  {
    table: 'price_quote_components',
    module: 'pricing',
    decision: 'retain',
    reason: 'Per-line GST breakdown backing the invoice — financial record-keeping.',
  },
  {
    table: 'refund_components',
    module: 'pricing',
    decision: 'retain',
    reason: 'Per-line credit-note GST breakdown (s.34 CGST Act) — financial record-keeping.',
  },
  {
    table: 'payments',
    module: 'payment',
    decision: 'retain',
    reason: 'Financial/tax record (GST invoice) — the brief\'s explicit default for money rows.',
  },
  {
    table: 'refunds',
    module: 'payment',
    decision: 'retain',
    reason: 'Financial/tax record (GST credit note) — the brief\'s explicit default for money rows.',
  },
  {
    table: 'payment_events',
    module: 'payment',
    decision: 'retain',
    reason: 'Durable webhook-delivery audit trail underneath the payments/refunds idempotency guarantee — financial audit trail.',
  },
];

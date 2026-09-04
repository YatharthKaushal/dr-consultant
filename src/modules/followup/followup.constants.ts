/**
 * M-16: Follow-Up and Patient Safety — constants, DI tokens and error codes.
 * Mirrors the shape `clinical.constants.ts` and `instant.constants.ts` use
 * for the same purpose.
 */

/* -------------------------------------------------------------------------- */
/* DI tokens — the seams to modules this worktree cannot see or cannot touch. */
/* -------------------------------------------------------------------------- */

/**
 * *** THE M-16 -> M-08 (NOTIFICATIONS) SEAM. ***
 *
 * `modules/notification` IS merged in this worktree (unlike the "parallel
 * worktree" cases `instant-notification.contract.ts` and
 * `pricing-discount.contract.ts` document), so this is bound directly to the
 * real `NotificationFacade` in `followup.module.ts` — there is no placeholder
 * period to wait out. The port is still declared locally rather than
 * imported, for the same reason every other module does it (`backend/
 * README.md` §2: a module's only public surface is its facade, resolved
 * through DI): it keeps `followup.service.ts` from depending on M-08's
 * import path, and it is the exact pattern this module was asked to follow.
 *
 * `UnavailableFollowupNotificationProvider` stays in the tree, unbound — the
 * hard kill-switch this codebase gives every notification-consuming module,
 * used here only if an operator ever needs to take push out of the follow-up
 * path at the DI level.
 */
export const FOLLOWUP_NOTIFICATION_PORT = Symbol('FOLLOWUP_NOTIFICATION_PORT');

/**
 * *** THE M-16 -> M-18 (CARE HUB) SEAM. *** `modules/carehub` does not exist
 * yet (`docs/MODULES.md`: M-18 ships after M-16). Bound to
 * `UnavailableCareHubProvider`, which returns an empty recommendation list —
 * FR-14.1's "recommended self-help" section renders empty until M-18 merges
 * and the coordinator rebinds this token to the real facade in
 * `followup.module.ts`. The exact pattern `pricing.module.ts` used for
 * `DISCOUNT_PORT` before `modules/promotion` existed.
 */
export const CARE_HUB_PORT = Symbol('CARE_HUB_PORT');

/**
 * *** THE M-16 -> M-01/IDENTITY "ADMINS BY PERMISSION" GAP. ***
 *
 * A red or missed-checkin alert notifies "the admin or care coordinator"
 * (FR-13.4) — in practice, every admin holding `governance.act_alerts`
 * (`permission.catalog.ts`: bundled to `clinical_governance` and
 * `care_coordinator`). No existing facade lists admins by permission —
 * `identity.contract.ts#IdentityContract` has no such method, and
 * `identity-access.service.ts#listAdmins` (all admins, unfiltered) is not on
 * `IdentityContract` either. Adding it is `modules/identity`'s file to touch,
 * which is out of scope for this worktree.
 *
 * Bound to `UnavailableAdminDirectoryProvider` (returns `[]`), so no admin
 * push goes out yet — the durable, authoritative side of FR-13.4 is the
 * `safety_alerts` row itself (queryable today via
 * `GET /admin/safety-alerts`, gated on `governance.read_queues`), never a
 * push notification. The coordinator closes this by adding
 * `listAdminIdsWithPermission` to `IdentityContract`/`IdentityFacade` and
 * rebinding this token in `followup.module.ts`.
 */
export const ADMIN_DIRECTORY_PORT = Symbol('ADMIN_DIRECTORY_PORT');

/* -------------------------------------------------------------------------- */
/* Notification template codes — the fixed set `notifications.template_code`'s */
/* own schema comment names. Both were reserved there for this module.        */
/* -------------------------------------------------------------------------- */

export const FOLLOWUP_NOTIFICATION_TEMPLATES = {
  /** Doctor + care_coordinator/clinical_governance admins, FR-16.4 / FR-13.4. Urgency without content — never what was flagged. */
  RED_FLAG_ALERT: 'red_flag_alert',
  /** Patient-facing daily reminder. Not raised by this module's current routes (no reminder scheduler yet) — reserved for the coordinator's use. */
  CHECKIN_DUE: 'checkin_due',
} as const;

/* -------------------------------------------------------------------------- */
/* The missed check-in sweep — plain `setInterval`, no `@nestjs/schedule`.    */
/* Shape copied from `clinical-gate-sweep.service.ts` / `pricing-quote-       */
/* sweep.service.ts`. See `followup-checkin-sweep.service.ts` for why.        */
/* -------------------------------------------------------------------------- */

export const FOLLOWUP_CHECKIN_SWEEP_INTERVAL_MS = 5 * 60_000; // every 5 minutes
export const FOLLOWUP_CHECKIN_SWEEP_BATCH_SIZE = 100;
export const FOLLOWUP_CHECKIN_SWEEP_MAX_BATCHES = 20;

/* -------------------------------------------------------------------------- */
/* Audit + error codes                                                        */
/* -------------------------------------------------------------------------- */

export const FOLLOWUP_AUDIT_ENTITY_TYPES = {
  FOLLOWUP_ASSIGNMENT: 'followup_assignment',
  CHECKIN_RESPONSE: 'checkin_response',
  SAFETY_ALERT: 'safety_alert',
  FOLLOWUP_PATHWAY: 'followup_pathway',
} as const;

export const FOLLOWUP_ERROR_CODES = {
  PATHWAY_NOT_FOUND: 'FOLLOWUP_PATHWAY_NOT_FOUND',
  NO_CURRENT_PATHWAY: 'FOLLOWUP_NO_CURRENT_PATHWAY',
  PATHWAY_VERSION_TAKEN: 'FOLLOWUP_PATHWAY_VERSION_TAKEN',
  ASSIGNMENT_NOT_FOUND: 'FOLLOWUP_ASSIGNMENT_NOT_FOUND',
  ALREADY_ASSIGNED: 'FOLLOWUP_ALREADY_ASSIGNED',
  CONSULTATION_NOT_FOUND: 'FOLLOWUP_CONSULTATION_NOT_FOUND',
  CHECKIN_ALREADY_SUBMITTED: 'FOLLOWUP_CHECKIN_ALREADY_SUBMITTED',
  CHECKIN_OUTSIDE_WINDOW: 'FOLLOWUP_CHECKIN_OUTSIDE_WINDOW',
  INVALID_ANSWERS: 'FOLLOWUP_INVALID_ANSWERS',
  INVALID_QUESTION_SET: 'FOLLOWUP_INVALID_QUESTION_SET',
  INVALID_RED_FLAG_RULES: 'FOLLOWUP_INVALID_RED_FLAG_RULES',
  ALERT_NOT_FOUND: 'FOLLOWUP_ALERT_NOT_FOUND',
  ALERT_ALREADY_CLOSED: 'FOLLOWUP_ALERT_ALREADY_CLOSED',
  NOT_OWN_CONSULTATION: 'FOLLOWUP_NOT_OWN_CONSULTATION',
} as const;

/** `followup_pathways`' "exactly one current version per code" advisory-lock namespace — the `legal_documents` pattern (`consent.constants.ts#LEGAL_DOCUMENT_CURRENT_LOCK_PREFIX`). */
export const FOLLOWUP_PATHWAY_CURRENT_LOCK_PREFIX = 'followup_pathway_current';

/* -------------------------------------------------------------------------- */
/* Admin pagination                                                           */
/* -------------------------------------------------------------------------- */

export const FOLLOWUP_DEFAULT_PAGE_SIZE = 20;
export const FOLLOWUP_MAX_PAGE_SIZE = 100;

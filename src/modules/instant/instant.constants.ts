import type { DoctorPresence } from '../../schema/enums.schema';

/**
 * M-13's constants: the seven-state transition table, the `app_config` keys it
 * OWNS with their compiled-in fallbacks, its error-code vocabulary, its
 * `audit_log.entity_type` values and the sweep tuning.
 *
 * Structure copied from `payment.constants.ts` and `booking.constants.ts` —
 * keys + defaults + seed source in one place, so the admin write path, the
 * read fallbacks and `instant.seed.ts` can never drift apart.
 */

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

/** `audit_log.entity_type` values this module writes. */
export const INSTANT_AUDIT_ENTITY_TYPES = {
  /** One `instant_consultancy` row — an offer made to one doctor. `entity_id` is the attempt id, `consultation_id` the request. */
  INSTANT_REQUEST: 'instant_request',
  /** A routing DECISION about the request as a whole: it started, it ran out of doctors, it was released. `entity_id` is the consultation id. */
  INSTANT_ROUTING: 'instant_routing',
  /** One `instant.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'instant_config',
} as const;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const INSTANT_ERROR_CODES = {
  /**
   * No `instant_consultancy` row with this id, or it was not offered to the
   * calling doctor — deliberately the same code for both, so a doctor cannot
   * probe for another doctor's requests. The same reasoning
   * `BOOKING_ERROR_CODES.BOOKING_NOT_FOUND` gives.
   */
  REQUEST_NOT_FOUND: 'INSTANT_REQUEST_NOT_FOUND',
  /** The offer has already been accepted, declined, timed out or superseded. Answering twice is a conflict, not a second answer. */
  REQUEST_NOT_PENDING: 'INSTANT_REQUEST_NOT_PENDING',
  /** The acceptance window closed before the answer arrived (FR-10.6). A separate code from `REQUEST_NOT_PENDING` because the doctor did nothing wrong and the app should say so. */
  REQUEST_WINDOW_CLOSED: 'INSTANT_REQUEST_WINDOW_CLOSED',
  /** The consultation id is unknown, is not `mode: 'instant'`, or is not the caller's. */
  INSTANT_CONSULT_NOT_FOUND: 'INSTANT_CONSULT_NOT_FOUND',
  /** The consultation is not in a status this step is legal from. */
  INVALID_STATE_TRANSITION: 'INSTANT_INVALID_STATE_TRANSITION',
  /** FR-10.6, exhausted: every eligible doctor was tried (or there were none) and the request was released. */
  NO_DOCTOR_AVAILABLE: 'INSTANT_NO_DOCTOR_AVAILABLE',
  /** A doctor tried to set a presence state only the system may set (`request_pending`, `in_consultation`, `completing_notes`). */
  PRESENCE_NOT_SELF_SETTABLE: 'INSTANT_PRESENCE_NOT_SELF_SETTABLE',
  /** The requested presence move is not in `LEGAL_PRESENCE_TRANSITIONS` from where the doctor actually is. */
  PRESENCE_TRANSITION_NOT_ALLOWED: 'INSTANT_PRESENCE_TRANSITION_NOT_ALLOWED',
  /**
   * *** THE COMPLETION GATE REFUSED (FR-10.5). *** Documentation for a
   * previous instant consultation is still outstanding, so this doctor cannot
   * become routable. Distinct from `PRESENCE_TRANSITION_NOT_ALLOWED` because
   * the two need completely different wording in the app: "finish your notes"
   * versus "you cannot get there from here".
   */
  COMPLETION_GATE_ACTIVE: 'INSTANT_COMPLETION_GATE_ACTIVE',
  /** The doctor id does not exist. */
  DOCTOR_NOT_FOUND: 'INSTANT_DOCTOR_NOT_FOUND',
  /**
   * ANY throw from `PaymentFacade` while minting the accept-then-pay order,
   * rewrapped. A raw gateway or payment-module error must never reach a
   * patient or a doctor — the same discipline `BOOKING_ERROR_CODES
   * .PAYMENT_SETUP_FAILED` applies.
   */
  PAYMENT_SETUP_FAILED: 'INSTANT_PAYMENT_SETUP_FAILED',
  /** A `PUT /admin/instant-consults/config` body whose value fails this module's own shape check. */
  CONFIG_INVALID: 'INSTANT_CONFIG_INVALID',
  /** A config write naming a key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'INSTANT_CONFIG_KEY_NOT_OWNED',
} as const;
export type InstantErrorCode = (typeof INSTANT_ERROR_CODES)[keyof typeof INSTANT_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* The seven-state machine (FR-10.4)                                           */
/* -------------------------------------------------------------------------- */

/**
 * *** THE LEGAL-TRANSITION TABLE. FR-10.4's SEVEN STATES, AS DATA. ***
 *
 * Read each entry as: "a doctor may ENTER <key> from any of <value>". That
 * direction, rather than the more usual from -> to, is deliberate — it is
 * exactly the shape `DoctorFacade.transitionPresence` takes as its `from`
 * argument, so a caller writes `LEGAL_PRESENCE_TRANSITIONS[target]` and cannot
 * hand-roll a subtly different set at one call site.
 *
 * M-13 owns this table; M-05 owns the row and the `SELECT ... FOR UPDATE` that
 * enforces it. See `doctor-presence.service.ts`'s header for why the two are
 * split that way.
 *
 * The five non-obvious entries:
 *
 *   `offline` is NOT reachable from `in_consultation` or `completing_notes`.
 *     A dropped socket is the ordinary case on a mobile network, and if it
 *     could reset a doctor who is mid-consult — or who owes documentation —
 *     then backgrounding the app would clear the completion gate. FR-10.5
 *     would be bypassable by turning the screen off.
 *
 *   `request_pending` is reachable ONLY from `available_now`. An offer may
 *     only ever land on a doctor who is live and free; every other guard in
 *     the router is a second line of defence behind this one.
 *
 *   `in_consultation` is reachable ONLY from `request_pending` — you get
 *     there by accepting. (M-14 will need to widen this when a SCHEDULED
 *     consult starts a call; that is a one-line change here and nowhere else,
 *     which is the point of keeping the table as data.)
 *
 *   `completing_notes` is reachable ONLY from `in_consultation`, and the same
 *     transaction sets the completion gate.
 *
 *   `available_now` is reachable from `in_consultation` for exactly one
 *     reason: the accept-rollback compensation in `instant.service.ts`, where
 *     the doctor accepted but the payment order could not be created. No
 *     consultation happened, so no gate was ever set, and the doctor must go
 *     straight back into the pool rather than being stranded.
 */
export const LEGAL_PRESENCE_TRANSITIONS: Record<DoctorPresence, readonly DoctorPresence[]> = {
  offline: ['available_now', 'request_pending', 'paused', 'scheduled_only'],
  available_now: ['offline', 'request_pending', 'in_consultation', 'completing_notes', 'paused', 'scheduled_only'],
  request_pending: ['available_now'],
  in_consultation: ['request_pending'],
  completing_notes: ['in_consultation'],
  paused: ['offline', 'available_now', 'request_pending', 'scheduled_only'],
  scheduled_only: ['offline', 'available_now', 'paused'],
};

/**
 * The states a DOCTOR may set on themselves through `PUT /doctors/me/presence`.
 *
 * The other three (`request_pending`, `in_consultation`, `completing_notes`)
 * are facts about work in flight, not preferences: the router sets the first,
 * accepting sets the second, ending a consult sets the third. Letting a doctor
 * assert any of them by hand would let them claim to be busy to dodge routing,
 * or — worse — claim to be `completing_notes` and then walk it back.
 */
export const SELF_SETTABLE_PRESENCE = ['offline', 'available_now', 'paused', 'scheduled_only'] as const satisfies readonly DoctorPresence[];
export type SelfSettablePresence = (typeof SELF_SETTABLE_PRESENCE)[number];

/**
 * States a doctor must NOT be gated to enter (FR-10.5).
 *
 * `available_now` is the one a doctor can ask for, and refusing it there is
 * what makes the gate visible to them. `request_pending` is on the list as a
 * second, independent stop: the routing candidate query already excludes
 * gated doctors, so a gated doctor reaching here means something upstream is
 * wrong, and the right answer is to refuse rather than to route.
 */
export const PRESENCE_REQUIRING_NO_GATE = ['available_now', 'request_pending'] as const satisfies readonly DoctorPresence[];

/**
 * States a doctor may be moved OUT OF when their realtime channel closes.
 *
 * Identical to `LEGAL_PRESENCE_TRANSITIONS.offline`, and referenced through
 * that rather than repeated, so the disconnect handler and the transition
 * table cannot disagree. `docs/erd.sql` on `doctors`: "presence is carried on
 * the realtime channel (M-13), so the socket already knows who is live — its
 * disconnect handler, and a sweep at boot, write `presence = offline`."
 */
export const DISCONNECT_CLEARS_PRESENCE = LEGAL_PRESENCE_TRANSITIONS.offline;

/**
 * What the BOOT SWEEP resets to `offline`.
 *
 * After a restart no stream exists, so a doctor the previous process left
 * `available_now` or `request_pending` is a lie the next routing decision
 * would act on. `paused` is on the list for the same reason — it means "online
 * but not taking requests", and there is nothing online about a process that
 * has just started.
 *
 * `in_consultation` and `completing_notes` are deliberately NOT reset: a
 * consult in progress and documentation outstanding both survive a deploy,
 * and resetting the second would clear the completion gate on every restart.
 * `scheduled_only` is not reset either — it is a standing preference rather
 * than a live-socket fact, routing already excludes it (FR-10.3), and making
 * doctors re-set it after every deploy would buy nothing.
 */
export const BOOT_STALE_PRESENCE = ['available_now', 'request_pending', 'paused'] as const satisfies readonly DoctorPresence[];

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The `app_config` keys M-13 OWNS.
 *
 * `instant.acceptance_window_seconds` is RESERVED BY `docs/erd.sql` — it is in
 * `app_config`'s own comment ("Everything the admin can change without a
 * release") and named again on `instant_consultancy.expires_at` ("acceptance
 * window, configured in app_config"), but no default is stated anywhere and
 * nothing had ever declared it. This is that declaration.
 *
 * `instant.payment_window_seconds` is GENUINELY NEW — not in `docs/erd.sql`'s
 * key list, not in any SRS section. It is flagged here rather than invented
 * silently, exactly as `booking.constants.ts` flags its own three. It exists
 * because FR-10.2's request -> accept -> PAY ordering creates a second window
 * with no equivalent in the scheduled flow; see `instant-expiry.service.ts`.
 */
export const INSTANT_CONFIG_KEYS = {
  ACCEPTANCE_WINDOW_SECONDS: 'instant.acceptance_window_seconds',
  PAYMENT_WINDOW_SECONDS: 'instant.payment_window_seconds',
} as const;
export type InstantConfigKey = (typeof INSTANT_CONFIG_KEYS)[keyof typeof INSTANT_CONFIG_KEYS];

export const INSTANT_CONFIG_KEY_LIST: readonly InstantConfigKey[] = Object.values(INSTANT_CONFIG_KEYS);

/**
 * *** WHY 60 SECONDS TO ACCEPT, AND 5 MINUTES TO PAY. ***
 *
 * ACCEPTANCE (`instant.acceptance_window_seconds`). SRS 6.4 asks that instant
 * requests "route in near real time, with a defined acceptance window and
 * automatic re-routing on timeout". The window is a direct trade: too short
 * and a doctor who is genuinely there loses requests to a notification that
 * had not finished arriving; too long and a patient waits N x window before
 * anybody picks up, because FR-10.6 re-routes SEQUENTIALLY. 60 seconds is long
 * enough for a push to land, wake a backgrounded app and be tapped, and short
 * enough that three failed attempts still cost a patient under three minutes.
 *
 * PAYMENT (`instant.payment_window_seconds`). This one has no counterpart in
 * the scheduled flow and it is NOT the same trade as `booking.slot_hold_
 * minutes`. That constant is deliberately set LONGER than the gateway's
 * checkout window (20 minutes against Razorpay's ~15) so a legitimate late
 * capture always lands inside a live hold. *** DOING THAT HERE WOULD HOLD A
 * LIVE DOCTOR IDLE FOR TWENTY MINUTES WHILE ONE PATIENT DECIDES. *** An
 * instant consult exists because both parties are present right now; a doctor
 * who accepted and then sat blocked for twenty minutes would stop going
 * Available Now, and the whole feature dies with them.
 *
 * So this window is deliberately SHORTER than the gateway's, and the residual
 * risk is handed to a mechanism that already exists: if the payment lands
 * after we released, M-11's `confirmLateCapture` re-acquires the consultation
 * (there is no slot to lose — an instant row has no `scheduled_start_at`, so
 * the double-booking index does not apply) or files it for an admin with the
 * money HELD, never refunded. Five minutes is comfortably past a UPI collect
 * (~5 min) and covers a card journey that does not need 3-D Secure.
 *
 * Both are `app_config` values precisely because this trade is a business
 * decision an operator should be able to retune from the panel without a
 * release (SRS 6.6).
 */
export const INSTANT_CONFIG_FALLBACKS = {
  ACCEPTANCE_WINDOW_SECONDS: 60,
  PAYMENT_WINDOW_SECONDS: 300,
} as const;

/** What `instant.seed.ts` inserts into `app_config` on first run (`ON CONFLICT DO NOTHING` — never overwrites an admin-tuned value). */
export const INSTANT_APP_CONFIG_DEFAULTS: Record<InstantConfigKey, unknown> = {
  [INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS]: INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
  [INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS]: INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS,
};

/**
 * Bounds on the two windows, enforced in the service as well as the DTO
 * (`backend/README.md`: services hold the rules, not just the HTTP layer).
 *
 * Deliberately loose — an operator tuning the feature should not have to ask
 * for a release — but not absent. An acceptance window of 2 seconds silently
 * turns every request into a timeout, and one of 3 hours holds a patient on a
 * spinner; both are typos, not policies, and either would be discovered by a
 * patient rather than by whoever typed it.
 */
export const INSTANT_CONFIG_BOUNDS: Record<InstantConfigKey, { min: number; max: number }> = {
  [INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS]: { min: 10, max: 600 },
  [INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS]: { min: 60, max: 1_800 },
};

/* -------------------------------------------------------------------------- */
/* Routing and sweeps                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How many doctors one request may be offered to before it is released as
 * `NO_DOCTOR_AVAILABLE`.
 *
 * `instant_consultancy.attempt_number` is a `smallint`, so this is bounded
 * either way; the point of a low ceiling is the patient, not the column. Ten
 * attempts at a 60-second window is ten minutes of a spinner, which is already
 * past the point where "we could not find a doctor, here are the scheduled
 * slots" is the better answer.
 */
export const MAX_ROUTING_ATTEMPTS = 10;

/**
 * How many candidates one routing pass fetches before picking.
 *
 * More than one, because reserving a doctor can lose a race: the candidate
 * query says `available_now`, and between that read and the presence write the
 * doctor may have gone offline, paused, or been reserved by another request.
 * The router then simply tries the next name it already has, instead of
 * paying a second round trip to find out there was one.
 *
 * Five rather than fifty: every extra candidate is a row read on the hot path
 * for a race that is uncommon, and a request that loses five in a row will get
 * a fresh list on its next attempt anyway.
 */
export const ROUTING_CANDIDATE_FETCH = 5;

/**
 * *** HOW THE TWO SWEEPS ARE SCHEDULED, AND WHY. ***
 *
 * Copied wholesale from `booking-slot-hold.service.ts`'s `SWEEP_SCHEDULING`
 * note, because the reasoning is identical and the two must not diverge:
 * `@nestjs/schedule` is NOT installed and this module does not add it. Both
 * sweeps are driven by plain `setInterval`s owned by `instant-expiry.service
 * .ts`, started in `onModuleInit` and cleared in `onApplicationShutdown`.
 *
 * Why not add the package: it means editing `package.json` AND `package-lock.
 * json` — two of the highest-conflict files in the repository — while sibling
 * modules are being built in PARALLEL WORKTREES; `ScheduleModule.forRoot()`
 * would also have to go into `app.module.ts`, the shared composition root
 * every worktree touches; and `@nestjs/schedule` earns its keep for cron
 * EXPRESSIONS and dynamic job registration, not for two fixed-period jobs.
 *
 * The two things a naive `setInterval` gets wrong are both handled: `.unref()`
 * so the timer never holds the event loop open (Jest and CLI processes still
 * exit cleanly), and a re-entrancy guard per sweep so a slow pass cannot
 * overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY does not depend on the scheduler at all. Two processes
 * sweeping at once is harmless: each candidate is locked with `SELECT ... FOR
 * UPDATE` and re-checked under that lock, so the loser's guard does not match
 * and it does nothing. Correctness lives in the transaction, not in the timer.
 */
const SWEEP_SCHEDULING = true;
export { SWEEP_SCHEDULING };

/**
 * The acceptance-window sweep's period. Much shorter than
 * `booking-slot-hold.service.ts`'s 60 seconds, and it has to be: that sweep
 * chases a 20-minute hold, this one chases a 60-second window, and a patient
 * is watching. The lag between an offer expiring and the next doctor being
 * tried is bounded by this number.
 */
export const ACCEPTANCE_SWEEP_INTERVAL_MS = 10_000;

/** The post-acceptance payment sweep's period. Chases a 5-minute window, so a coarser tick costs nothing. */
export const PAYMENT_SWEEP_INTERVAL_MS = 30_000;

/** Candidates examined per pass, per sweep. Bounds one pass's work so a backlog drains steadily instead of in one spike — `booking-slot-hold.service.ts`'s `SWEEP_BATCH_SIZE`, same value. */
export const SWEEP_BATCH_SIZE = 100;

/** How often the SSE stream emits a keep-alive comment event. Well under the 60s idle timeout most proxies and mobile networks apply to an idle response body. */
export const STREAM_KEEPALIVE_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Ports and notifications                                                     */
/* -------------------------------------------------------------------------- */

/**
 * DI token for the `NotificationPort` implementation, bound in
 * `instant.module.ts` — mirrors `booking.constants.ts`'s
 * `BOOKING_PAYMENT_PORT`, `search.constants.ts`'s `SEARCH_AI_PORT` and
 * `document.constants.ts`'s `DOCUMENT_STORAGE_PORT`. Every DI token in this
 * codebase lives in its module's `*.constants.ts`; the interface it carries is
 * in `instant-notification.contract.ts`.
 *
 * Bound to `UnavailableNotificationProvider` (a null object that returns
 * `{ queued: false, reason: 'provider_unavailable' }` and NEVER throws) until
 * `modules/notification` (M-08) is merged; the COORDINATOR then rebinds it to
 * `NotificationFacade`.
 */
export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

/**
 * `notifications.template_code` values this module raises.
 *
 * `instant_request` is the ONLY one `docs/erd.sql` names (its
 * `notifications.template_code` comment lists exactly: booking_confirmed,
 * consult_reminder, doctor_joined, prescription_ready, checkin_due,
 * instant_request, red_flag_alert, document_rejected, doctor_approved). The
 * other three are GENUINELY NEW and flagged as such rather than invented
 * silently — M-08 owns the template set and an admin owns the copy (FR-16.4),
 * so a code with no template resolves to `reason: 'template_missing'` and
 * nothing breaks.
 *
 * *** NONE OF THESE MAY NAME A DIAGNOSIS (FR-16.2). *** Every `variables`
 * payload in this module carries a doctor's name, a specialty name or a
 * reference code, and never the patient's concern text or intake answers.
 */
export const INSTANT_NOTIFICATION_TEMPLATES = {
  /** To the DOCTOR: an instant request is waiting, with N seconds to accept. In `docs/erd.sql`'s list. */
  INSTANT_REQUEST: 'instant_request',
  /** To the PATIENT: a doctor accepted, pay now. NEW. */
  INSTANT_ACCEPTED: 'instant_accepted',
  /** To the PATIENT: nobody was available and the request was released (FR-10.6, exhausted). NEW. */
  INSTANT_NO_DOCTOR_AVAILABLE: 'instant_no_doctor_available',
  /** To the PATIENT: the payment window closed and the doctor was released. NEW. */
  INSTANT_PAYMENT_WINDOW_EXPIRED: 'instant_payment_window_expired',
} as const;

/* -------------------------------------------------------------------------- */
/* Paging                                                                      */
/* -------------------------------------------------------------------------- */

/** Upper bound on one page of an instant-request listing, so an admin or doctor listing can never become an unbounded scan. */
export const MAX_INSTANT_PAGE_SIZE = 100;
export const DEFAULT_INSTANT_PAGE_SIZE = 20;

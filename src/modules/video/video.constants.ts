/**
 * M-14's constants: the `app_config` keys it OWNS, their compiled-in
 * fallbacks, its error-code vocabulary and its `audit_log.entity_type` values.
 *
 * Structure copied from `payment.constants.ts` and `instant.constants.ts` —
 * keys + defaults + seed source in one place, so the admin write path, the read
 * fallbacks and the seed can never drift apart.
 *
 * *** SEEDED BY STEP 0 WITH THE WEBHOOK PATH ONLY. *** `main.ts` needs that one
 * value to exempt the route from Fastify's JSON body parser, and `main.ts` is
 * owned by the coordinator while three worktrees are in flight. Everything else
 * in this file belongs to the M-14 track, which extends it.
 */

/**
 * The LiveKit webhook's full request path, INCLUDING `main.ts`'s `api` global
 * prefix.
 *
 * Exported because `main.ts` needs it: Fastify's JSON body parser rejects a
 * malformed body with a 400 before any controller runs, and LiveKit — like
 * Razorpay — signs its webhook over the RAW BYTES and retries on a non-2xx. A
 * literal in `main.ts` would silently stop matching the day the route moves.
 *
 * See `src/shared/http/webhook-safe-json.parser.ts` for what the exemption does
 * and why it is safe for every other route.
 */
export const VIDEO_WEBHOOK_PATH = '/api/video/webhook';

/* -------------------------------------------------------------------------- */
/* The room, and the participant identity                                      */
/* -------------------------------------------------------------------------- */

/**
 * *** THE ROOM IS DERIVABLE, NOT STORED. ***
 *
 * `docs/erd.sql` fixes this on `consultation_participants.consultation_id`:
 * "parsed from the room name, which is a function of this id". There is no
 * rooms table and no tokens table in the ERD, and that is a decision rather
 * than an omission — a `video_rooms` row would be a second, weaker copy of a
 * fact `consultations.id` already carries perfectly, and it could go stale (a
 * row for a consultation that was cancelled, two rows for one consultation, a
 * room nobody ever joined). `docs/MODULES.md` lists "room records, access
 * tokens" under M-14's DATA OWNED; this module reads that as owning the
 * DERIVATION and the ISSUING, which is what the schema actually supports.
 *
 * The name is therefore `consult-<consultation uuid>`, and
 * `video-room.util.ts` is the ONLY place that composes or parses it. A join
 * token names the room, the webhook names the room, and both ends agree
 * because they both call the same two functions.
 */
export const VIDEO_ROOM_NAME_PREFIX = 'consult-';

/**
 * The LiveKit participant identity, `<party>:<account uuid>`.
 *
 * *** THE SEPARATOR IS `:` AND NOT `-` ON PURPOSE. *** A uuid contains
 * hyphens, so `patient-<uuid>` cannot be split on its first hyphen without
 * ambiguity, and a parser that split on the LAST one would be one rename away
 * from breaking. `:` appears in neither `party` nor a uuid.
 *
 * The identity is what the `participant_joined` webhook hands back, and it is
 * the ONLY thing that says which side of the consultation connected — the
 * webhook carries no patient id and no doctor id. It is therefore re-checked
 * against the booking on the way in (`video-webhook.service.ts`): an identity
 * naming an account that is not this consultation's patient or doctor is
 * recorded nowhere.
 */
export const VIDEO_IDENTITY_SEPARATOR = ':';

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

/** `audit_log.entity_type` values this module writes. */
export const VIDEO_AUDIT_ENTITY_TYPES = {
  /**
   * A join token was minted for one consultation. `entity_id` is the
   * consultation id, `consultation_id` the same, and `metadata` carries the
   * party and the TTL — never the token and never the secret.
   *
   * Audited because this is the whole of FR-8.5's access control: the token IS
   * admission to a clinical conversation, and "who was let into which consult,
   * when" is the question an incident starts from. `docs/MODULES.md` §7's rule
   * — "every module touching clinical or financial data writes audit entries
   * from its first release" — covers a video consultation squarely.
   */
  JOIN_TOKEN: 'video_join_token',
  /** One LiveKit connection or disconnection, from the webhook. `entity_id` is the participant sid. */
  SESSION: 'video_session',
  /** One `video.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'video_config',
} as const;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const VIDEO_ERROR_CODES = {
  /**
   * No consultation with this id, or the caller is neither its patient nor its
   * doctor — deliberately ONE code for both, and a 404 rather than a 403.
   * `instant.controller.ts` states the convention: ownership failures "return
   * 404 rather than 403 so a patient cannot probe for another patient's
   * consultation." A 403 here would confirm that a consultation exists to
   * somebody with no relationship to it.
   */
  CONSULTATION_NOT_FOUND: 'VIDEO_CONSULTATION_NOT_FOUND',
  /** The consultation is not in a status a call may run in — see `JOINABLE_CONSULTATION_STATUSES`. */
  CONSULTATION_NOT_JOINABLE: 'VIDEO_CONSULTATION_NOT_JOINABLE',
  /** The consultation has no doctor assigned yet, so there is nobody to call. Only reachable for an instant request still routing. */
  DOCTOR_NOT_ASSIGNED: 'VIDEO_DOCTOR_NOT_ASSIGNED',
  /** *** GATE 2. *** FR-8.5: tokens are issued "after payment ... checks pass". No `payments` row, or its status is not `paid`. */
  PAYMENT_NOT_COMPLETED: 'VIDEO_PAYMENT_NOT_COMPLETED',
  /**
   * *** GATE 3. *** FR-8.5, and SRS 6.2's "consent is captured before
   * teleconsultation". The patient has not accepted the CURRENT
   * `teleconsultation_consent` version.
   *
   * Also the code an UNAVAILABLE consent module produces, because the null
   * object fails closed — see `unavailable-consent.provider.ts`.
   */
  CONSENT_REQUIRED: 'VIDEO_CONSENT_REQUIRED',
  /** Too early: `video.join_window_minutes` before `scheduled_start_at` has not been reached yet. Carries `opensAt`. */
  JOIN_WINDOW_NOT_OPEN: 'VIDEO_JOIN_WINDOW_NOT_OPEN',
  /** The LiveKit SDK threw while minting. The underlying error is logged, never returned — it is produced with the API secret in hand. */
  TOKEN_MINT_FAILED: 'VIDEO_TOKEN_MINT_FAILED',
  /** The webhook's `Authorization` JWT did not verify, or its `sha256` claim did not match the body. The ONLY non-2xx the webhook returns. */
  WEBHOOK_SIGNATURE_INVALID: 'VIDEO_WEBHOOK_SIGNATURE_INVALID',
  /** A `PUT /admin/video/config` body whose value fails this module's own shape check. */
  CONFIG_INVALID: 'VIDEO_CONFIG_INVALID',
  /** A config write naming a key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'VIDEO_CONFIG_KEY_NOT_OWNED',
} as const;
export type VideoErrorCode = (typeof VIDEO_ERROR_CODES)[keyof typeof VIDEO_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* The join gate and the two status moves                                      */
/* -------------------------------------------------------------------------- */

/**
 * The consultation statuses a call may be joined in.
 *
 * `scheduled` is where BOTH modes wait: a scheduled booking reaches it when
 * its payment is captured (`BookingContract#confirmPayment`), and so does an
 * instant one — FR-10.2's accept-then-pay ends in the same transition. One
 * rule, not two.
 *
 * `in_progress` is on the list because a RECONNECT must work. The first join
 * moves the consultation to `in_progress`; if the list stopped at `scheduled`,
 * a dropped mobile connection would be unrecoverable — which is the single
 * most likely thing to happen during a real consultation.
 *
 * `awaiting_doctor` is deliberately absent: an instant request still routing
 * has no doctor to call. `awaiting_documentation` and `completed` are absent
 * because the call is over; `cancelled`, `no_show` and `expired` because it
 * will not happen. `pending_payment` is absent because that IS the payment
 * gate, and letting it through here would make gate 2 unreachable.
 */
export const JOINABLE_CONSULTATION_STATUSES = ['scheduled', 'in_progress'] as const;

/**
 * *** THE TWO STATUS MOVES THIS MODULE OWNS. ***
 *
 * `consultation_status` carries `in_progress` and `awaiting_documentation`,
 * and before this module NOTHING in the codebase set either one: M-11 moves a
 * consultation to `scheduled`, `cancelled`, `no_show` or `expired`, M-13 moves
 * it through `awaiting_doctor`/`pending_payment`/`expired`, and M-15 will set
 * `completed` when the clinical record is finalised. The two states in the
 * middle — the call is running, the call is over and the notes are outstanding
 * — are facts about a VIDEO SESSION, which is why they land here.
 *
 * Read each entry as "a consultation may ENTER <key> from any of <value>", the
 * same direction `instant.constants.ts`'s `LEGAL_PRESENCE_TRANSITIONS` uses
 * and for the same reason: it is exactly the shape
 * `BookingContract#transitionConsultationStatus` takes as its `from` argument,
 * so a caller writes `LEGAL_VIDEO_STATUS_TRANSITIONS[target]` and cannot
 * hand-roll a subtly different set at one call site.
 *
 * M-14 owns this table; M-11 owns the row and the `SELECT ... FOR UPDATE` that
 * enforces it.
 */
export const LEGAL_VIDEO_STATUS_TRANSITIONS = {
  /** The first participant connected. Only from `scheduled` — a call cannot start on a consultation that was never paid for, was cancelled, or is already over. */
  in_progress: ['scheduled'],
  /**
   * The call ended. Only from `in_progress`: a consultation nobody ever joined
   * does not owe documentation, it is a NO-SHOW, and that is M-11's
   * `markNoShow` with its own policy — not something a `room_finished` webhook
   * for an empty room may decide.
   */
  awaiting_documentation: ['in_progress'],
} as const satisfies Record<string, readonly string[]>;

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The `app_config` keys M-14 OWNS.
 *
 * *** BOTH ARE RESERVED BY `docs/erd.sql` AND NEITHER HAD EVER BEEN DECLARED.
 * *** They are named in `app_config`'s own table comment ("Everything the admin
 * can change without a release"), and that comment goes on to define them:
 * "`video.join_window_minutes` is how early before scheduled_start_at the
 * backend will mint a join token, and `video.join_token_ttl_seconds` is how
 * long that token stays good. Both are business rules an admin tunes, so
 * neither is a constant in code."
 *
 * No default is stated for either, anywhere — exactly the situation
 * `instant.constants.ts` documents for `instant.acceptance_window_seconds`.
 * The values below are this module's choice and are argued in
 * `VIDEO_CONFIG_FALLBACKS`.
 *
 * The same comment also settles what is NOT here: "The LiveKit server URL is
 * NOT here - it is `LIVEKIT_URL` in the environment, one per deployment, and
 * the API key and secret are environment secrets." All three are read through
 * `getEnv()` in `livekit.client.ts` and nowhere else.
 */
export const VIDEO_CONFIG_KEYS = {
  JOIN_TOKEN_TTL_SECONDS: 'video.join_token_ttl_seconds',
  JOIN_WINDOW_MINUTES: 'video.join_window_minutes',
} as const;
export type VideoConfigKey = (typeof VIDEO_CONFIG_KEYS)[keyof typeof VIDEO_CONFIG_KEYS];

export const VIDEO_CONFIG_KEY_LIST: readonly VideoConfigKey[] = Object.values(VIDEO_CONFIG_KEYS);

/**
 * *** WHY FIVE MINUTES OF TOKEN, AND FIFTEEN MINUTES OF WINDOW. ***
 *
 * TTL (`video.join_token_ttl_seconds`). FR-8.5 asks for "short-lived join
 * tokens", and the TTL is what makes the word "short" mean anything. It bounds
 * how long a LEAKED token is worth something — one pasted into a chat,
 * captured from a device log, or left in an app's memory after the patient
 * handed the phone to somebody else. It does NOT bound the call: LiveKit checks
 * the token at CONNECT and the session then lives on its own, so a five-minute
 * token does not produce a five-minute consultation.
 *
 * Five minutes rather than one: FR-8.2 puts a pre-call device and permission
 * check between "get a token" and "connect", and on a first run that means an
 * OS camera prompt and an OS microphone prompt, either of which a user can sit
 * on for a while. A token that expires during the permission dialog is a
 * support ticket. Five minutes rather than an hour: the LiveKit SDK's own
 * default is six HOURS, which is a reasonable default for a conference product
 * and the wrong one for a clinical consultation.
 *
 * A RECONNECT asks for a new token, which is why `in_progress` is on
 * `JOINABLE_CONSULTATION_STATUSES` — the two decisions are one decision.
 *
 * WINDOW (`video.join_window_minutes`). How early before `scheduled_start_at` a
 * token may be minted at all. Fifteen minutes is the ordinary "the waiting room
 * is open" figure: long enough for a patient to arrive early, run the pre-call
 * check and sit waiting, and for a doctor to open the consultation room and
 * read the history before the hour; short enough that the token stays tied to
 * THIS appointment rather than to the day.
 *
 * *** THERE IS DELIBERATELY NO LATE BOUND. *** It would be a second, redundant
 * expiry: a consultation stops being joinable when its STATUS moves off
 * `scheduled`/`in_progress`, and every route out — `awaiting_documentation`
 * when the call ends, `completed` when the record is finalised, `no_show` and
 * `cancelled` from M-11 — closes the gate on its own. A "you are two hours
 * late" rule on top would invent a policy the SRS does not state, and would cut
 * off a genuinely overrunning consultation mid-sentence.
 *
 * `scheduled_start_at` is NULL for an instant consultation, which has no
 * appointment time at all, so this key simply does not apply to that mode — see
 * `video.service.ts#assertJoinWindowOpen`.
 *
 * Both live in `app_config` precisely because they are the kind of trade an
 * operator should be able to retune from the panel without a release (SRS 6.6),
 * which is what `docs/erd.sql` says about them in as many words.
 */
export const VIDEO_CONFIG_FALLBACKS = {
  JOIN_TOKEN_TTL_SECONDS: 300,
  JOIN_WINDOW_MINUTES: 15,
} as const;

/** What `video.seed.ts` inserts into `app_config` on first run (`ON CONFLICT DO NOTHING` — never overwrites an admin-tuned value). */
export const VIDEO_APP_CONFIG_DEFAULTS: Record<VideoConfigKey, unknown> = {
  [VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS]: VIDEO_CONFIG_FALLBACKS.JOIN_TOKEN_TTL_SECONDS,
  [VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES]: VIDEO_CONFIG_FALLBACKS.JOIN_WINDOW_MINUTES,
};

/**
 * Bounds on the two values, enforced in the service as well as the DTO
 * (`backend/README.md`: services hold the rules, not just the HTTP layer).
 *
 * Deliberately loose — an operator tuning this should not need a release — but
 * not absent. A TTL of 2 seconds makes every join fail before the permission
 * prompt closes; a TTL of a week makes "short-lived" a lie and hands anyone who
 * ever saw one a standing key to the room. A join window of 1440 minutes means
 * a token for tomorrow's appointment can be minted today. All three are typos
 * rather than policies, and each would be discovered by a patient rather than
 * by whoever typed it.
 */
export const VIDEO_CONFIG_BOUNDS: Record<VideoConfigKey, { min: number; max: number }> = {
  [VIDEO_CONFIG_KEYS.JOIN_TOKEN_TTL_SECONDS]: { min: 60, max: 3_600 },
  [VIDEO_CONFIG_KEYS.JOIN_WINDOW_MINUTES]: { min: 0, max: 120 },
};

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * DI token for the `ConsentPort` implementation, bound in `video.module.ts` —
 * mirrors `instant.constants.ts`'s `NOTIFICATION_PORT`, `booking.constants.ts`'s
 * `BOOKING_PAYMENT_PORT` and `document.constants.ts`'s `DOCUMENT_STORAGE_PORT`.
 * Every DI token in this codebase lives in its module's `*.constants.ts`; the
 * interface it carries is in `video-consent.contract.ts`, which is where the
 * COORDINATOR's frozen block for the M-03 seam lives verbatim.
 *
 * Bound to `UnavailableConsentProvider` — which REFUSES, answering
 * `hasCurrentConsent: false` — until `modules/consent` (M-03) is merged; the
 * coordinator then rebinds it to `ConsentFacade`. Read
 * `unavailable-consent.provider.ts` before changing that binding: failing
 * CLOSED is the whole point of it.
 */
export const CONSENT_PORT = Symbol('CONSENT_PORT');

/* -------------------------------------------------------------------------- */
/* LiveKit webhook                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The webhook events this module ACTS ON. Everything else LiveKit sends
 * (`room_started`, `track_published`, `egress_*`, ...) is verified, logged and
 * answered 2xx without a write — exactly as `payment-webhook.service.ts` does
 * for a Razorpay event type it does not handle. A non-2xx starts a retry storm,
 * and a provider-side subscription change must not be able to cause one.
 */
export const LIVEKIT_EVENTS = {
  PARTICIPANT_JOINED: 'participant_joined',
  PARTICIPANT_LEFT: 'participant_left',
  /** The room emptied and LiveKit closed it. This module's "the call ended" signal. */
  ROOM_FINISHED: 'room_finished',
} as const;

/**
 * The header LiveKit signs its webhook with, lower-cased (Fastify normalises
 * header names, and `@Headers()` reads the normalised map).
 *
 * *** IT IS `Authorization`, NOT THE SDK's EXPORTED `authorizeHeader`. ***
 * `livekit-server-sdk` exports `authorizeHeader = 'Authorize'`, which is a
 * long-standing misnomer in that package — the LiveKit server itself sends
 * `Authorization`, and `WebhookReceiver.receive`'s own doc comment says
 * "`Authorization` header from the request". Both spellings are read
 * (`video-webhook.controller.ts`) so that neither a server change nor a proxy
 * that normalises the name can silently break verification.
 */
export const LIVEKIT_AUTH_HEADER = 'authorization';
/** The SDK's own (misnamed) constant, read as a fallback. See `LIVEKIT_AUTH_HEADER`. */
export const LIVEKIT_AUTH_HEADER_ALT = 'authorize';

/* -------------------------------------------------------------------------- */
/* Paging                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How many PRIOR consultations FR-8.4's consultation room carries.
 *
 * Bounded because the composition reads each one through `BookingFacade`, and
 * an unbounded history would turn one screen open into an unbounded number of
 * facade calls. Ten is more than a doctor reads at a glance and enough to see a
 * pattern; the full list is M-11's own history endpoint.
 */
export const VIDEO_PRIOR_HISTORY_LIMIT = 10;

/**
 * M-12's constants: the `app_config` keys it OWNS, their compiled-in
 * fallbacks, its error-code vocabulary and its `audit_log.entity_type` values.
 *
 * Structure copied from `identity.constants.ts` and `search.constants.ts` —
 * keys + defaults + seed source in one place, so the admin write path, the
 * read fallbacks and `payment.seed.ts` can never drift apart.
 */

/** `audit_log.entity_type` values this module writes. */
export const PAYMENT_AUDIT_ENTITY_TYPES = {
  /** One `payments.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'payment_config',
  /** A `payments` row. */
  PAYMENT: 'payment',
  /** A `refunds` row. */
  REFUND: 'refund',
  /** A manual payout being marked paid. `entity_id` is the payment id; the BANK REFERENCE lives in `metadata` — `payments.schema.ts` is explicit that there is no `payout_reference` column. */
  PAYOUT: 'payout',
  /** A verified webhook delivery. `entity_id` is the `x-razorpay-event-id`. */
  WEBHOOK: 'payment_webhook',
  /** A CSV export (FR-18.4 / SRS 6.7). */
  EXPORT: 'payment_export',
} as const;

/**
 * Error codes this module returns in `{ code, message }` bodies.
 *
 * The `PAYMENT_GATEWAY_*` half is the OUTPUT of `razorpay-error.classifier.ts`
 * — one code per classified failure kind, each with a patient-safe message
 * that never repeats gateway text. See that file for the mapping table.
 */
export const PAYMENT_ERROR_CODES = {
  /* Our own rules. */
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** `payments.consultation_id` is UNIQUE — a second order for one consultation is a conflict, not a new row. */
  PAYMENT_ALREADY_EXISTS: 'PAYMENT_ALREADY_EXISTS',
  /** A refund was asked for against a payment that never reached `paid`. */
  PAYMENT_NOT_CAPTURED: 'PAYMENT_NOT_CAPTURED',
  /** *** THE INVARIANT. *** Sum of processed+in-flight refunds would exceed what was captured. */
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  /** A refund amount that is zero, negative, or malformed. */
  REFUND_AMOUNT_INVALID: 'REFUND_AMOUNT_INVALID',
  /** The payout is already marked paid — marking it twice would double-report a manual transfer. */
  PAYOUT_ALREADY_PAID: 'PAYOUT_ALREADY_PAID',
  /** The payout was marked paid on a payment that was never captured. */
  PAYOUT_NOT_PAYABLE: 'PAYOUT_NOT_PAYABLE',
  /** A `PUT /admin/payments/config` body whose value fails this module's own shape check. */
  CONFIG_INVALID: 'PAYMENT_CONFIG_INVALID',
  /** A `PUT /admin/payments/config` naming a key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'PAYMENT_CONFIG_KEY_NOT_OWNED',
  /** The webhook HMAC did not verify, or the signature header was absent/malformed. THE ENTIRE AUTH BOUNDARY for that route. */
  WEBHOOK_SIGNATURE_INVALID: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
  /** The verified body was not a JSON object, or carried no usable event id. */
  WEBHOOK_MALFORMED: 'PAYMENT_WEBHOOK_MALFORMED',

  /* Classified gateway failures — see razorpay-error.classifier.ts. */
  GATEWAY_REJECTED: 'PAYMENT_GATEWAY_REJECTED',
  GATEWAY_UNAVAILABLE: 'PAYMENT_GATEWAY_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'PAYMENT_GATEWAY_TIMEOUT',
  GATEWAY_RATE_LIMITED: 'PAYMENT_GATEWAY_RATE_LIMITED',
  GATEWAY_ERROR: 'PAYMENT_GATEWAY_ERROR',
  DECLINED: 'PAYMENT_DECLINED',
  INSUFFICIENT_FUNDS: 'PAYMENT_INSUFFICIENT_FUNDS',
  ALREADY_PAID: 'PAYMENT_ALREADY_PAID',
  REFUND_NOT_PERMITTED: 'PAYMENT_REFUND_NOT_PERMITTED',
  AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
} as const;
export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[keyof typeof PAYMENT_ERROR_CODES];

/**
 * The `app_config` keys M-12 OWNS.
 *
 * `docs/MODULES.md` §7 assigns them here explicitly: "Configuration lives with
 * its owning module and is edited from the admin panel: ... fee and GST in
 * M-12." FR-7.5 requires both editable from the panel, and SRS 5.2 requires
 * "configuration values, including fee percentages, GST rate ... live in data,
 * not code."
 *
 * `payments.gst_rate` is the AGREED KEY NAME. `search-config.service.ts`'s own
 * comment names it as the key a search admin must not be able to reach through
 * a shared `app_config` table — which is exactly why `payment-config.service.ts`
 * enforces the same owned-key allow-list in the other direction.
 */
export const PAYMENT_CONFIG_KEYS = {
  /** FR-7.3's 20 percent. A percentage of the consultation fee, `numeric(5,2)`-shaped. */
  CONVENIENCE_FEE_PCT: 'payments.convenience_fee_pct',
  /** FR-7.3's 18 percent, charged EXCLUSIVE on the subtotal. */
  GST_RATE: 'payments.gst_rate',
} as const;
export type PaymentConfigKey = (typeof PAYMENT_CONFIG_KEYS)[keyof typeof PAYMENT_CONFIG_KEYS];

export const PAYMENT_CONFIG_KEY_LIST: readonly PaymentConfigKey[] = Object.values(PAYMENT_CONFIG_KEYS);

/**
 * Compiled-in fallbacks, exactly FR-7.3's worked example.
 *
 * Stored and compared as NUMBERS because `app_config.value` is jsonb and an
 * admin editing `20` in a panel produces a JSON number; converted to a
 * `numeric(5,2)`-shaped string at the arithmetic boundary by
 * `payment-config.service.ts`. Every `AppConfigService` read in this module
 * passes one of these, so a missing or not-yet-seeded row degrades to the SRS
 * default rather than billing nothing — the same discipline as
 * `IDENTITY_APP_CONFIG_DEFAULTS`.
 *
 * *** THE CLIENT'S CA OWNS THE GST TREATMENT. *** SRS §8: "GST wording, tax
 * treatment and invoice structure must be confirmed with the client's CA or
 * legal advisor before launch. The developer builds the billing display and
 * configuration to the confirmed structure." 18 is the rate the SRS's own
 * worked example uses; it is a default, not tax advice, and it is editable
 * from the panel with no release.
 */
export const PAYMENT_CONFIG_FALLBACKS = {
  CONVENIENCE_FEE_PCT: 20,
  GST_RATE: 18,
} as const;

/** What `payment.seed.ts` inserts into `app_config` on first run (`ON CONFLICT DO NOTHING` — never overwrites an admin-tuned value). */
export const PAYMENT_APP_CONFIG_DEFAULTS: Record<PaymentConfigKey, unknown> = {
  [PAYMENT_CONFIG_KEYS.CONVENIENCE_FEE_PCT]: PAYMENT_CONFIG_FALLBACKS.CONVENIENCE_FEE_PCT,
  [PAYMENT_CONFIG_KEYS.GST_RATE]: PAYMENT_CONFIG_FALLBACKS.GST_RATE,
};

/**
 * Bounds on the two rates, enforced in the service as well as the DTO
 * (`backend/README.md`: services hold the rules, not just the HTTP layer).
 *
 * The ceilings are deliberately loose — the platform does not get to decide
 * the client's commercial or tax rates — but they are not absent: a
 * convenience fee of 5000% or a negative GST rate is a typo, not a policy, and
 * it would reach a patient's card before anyone noticed.
 */
export const PAYMENT_RATE_BOUNDS = { min: 0, max: 100 } as const;

/**
 * ISO 4217 currency for every order this release creates.
 *
 * `payments.currency` is defaulted in the SCHEMA rather than hardcoded at the
 * call site, "so a future multi-currency change is a data change, not a code
 * change" (`payments.schema.ts`). This constant is only what the gateway call
 * sends when a payment row has not yet been read back.
 */
export const PAYMENT_DEFAULT_CURRENCY = 'INR';

/**
 * Razorpay webhook headers.
 *
 * Lower-case because Node normalises incoming header names to lower case;
 * Razorpay's own documentation spells them `X-Razorpay-Signature` and
 * `X-Razorpay-Event-Id`.
 */
export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

/**
 * The webhook events this module handles. Anything else that arrives is still
 * signature-verified and still durably recorded in `payment_events` — it is
 * simply marked processed with no state change, rather than being dropped or
 * retried forever.
 */
export const RAZORPAY_EVENTS = {
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_PROCESSED: 'refund.processed',
  REFUND_FAILED: 'refund.failed',
} as const;

/** How long a gateway call may take before we give up. An unbounded call to a payment provider would pin a request thread indefinitely — the same reasoning `llm-provider.types.ts` applies to `timeoutMs`. */
export const RAZORPAY_REQUEST_TIMEOUT_MS = 20_000;

/** Razorpay's API root. Not env-configurable: there is one production host and a test-mode key against the same host distinguishes the environment. */
export const RAZORPAY_API_BASE_URL = 'https://api.razorpay.com/v1';

/** Hard cap on rows in one CSV export, so an admin cannot ask for a stream the process has to hold in memory. */
export const PAYMENT_EXPORT_MAX_ROWS = 50_000;

/** Default and maximum page size for the admin transactions list. */
export const PAYMENT_LIST_DEFAULT_LIMIT = 50;
export const PAYMENT_LIST_MAX_LIMIT = 200;

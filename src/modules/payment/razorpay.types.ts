/**
 * Razorpay's wire shapes, as this module needs them.
 *
 * ── Why these are hand-written rather than imported from the SDK ───────────
 *
 * `razorpay@2.9.8` (the official Node SDK) was installed and read before this
 * decision was made, not guessed at. It ships real TypeScript types and is a
 * perfectly reasonable package, but three verified properties made it the
 * wrong dependency for THIS module:
 *
 *   1. `dist/api.js#normalizeError` throws a PLAIN OBJECT LITERAL, not an
 *      `Error`:  `throw { statusCode: err.response.status, error:
 *      err.response.data.error }`. No stack, no `name`, and `instanceof Error`
 *      is false — so it slips straight past the generic error handling every
 *      other module in this codebase relies on.
 *   2. That same function dereferences `err.response.status` UNCONDITIONALLY.
 *      Axios throws with NO `.response` on a network failure (DNS, refused
 *      connection, timeout), so a transport error becomes
 *      `TypeError: Cannot read properties of undefined (reading 'status')` —
 *      it destroys the very `network_or_timeout` signal this module has to
 *      classify and act on.
 *   3. `dist/utils/razorpay-utils.js#validateWebhookSignature` compares with
 *      `expectedSignature === signature`, a plain string comparison. The
 *      webhook route is `@Public()`, so that comparison IS the entire auth
 *      boundary, and it must be `crypto.timingSafeEqual`. The SDK's helper is
 *      therefore unusable here regardless of anything else.
 *
 * It also pulls in `axios` (with no default timeout configured) onto a runtime
 * that already has a global `fetch`. Weighed against two write calls and two
 * reads, `fetch` + `node:crypto` is less code, fewer dependencies and a
 * strictly better error surface.
 *
 * The ERROR ENVELOPE below is not invented: it is the SDK's own exported
 * `INormalizeError` (`dist/types/api.d.ts`), which is the shape Razorpay's API
 * actually returns. Keeping our own copy means the types are ours to narrow
 * without a dependency, and `razorpay-error.classifier.ts` reads every field
 * defensively anyway — nothing here is trusted to be present.
 */

/**
 * Razorpay's error envelope: `{ "error": { ... } }` in the response body.
 *
 * Every field is optional in OUR type even where Razorpay documents it as
 * always present. The classifier's job is to survive a shape nobody
 * anticipated, and an error path that itself throws on a missing field is the
 * worst possible failure mode for money code.
 */
export interface RazorpayErrorBody {
  /** `BAD_REQUEST_ERROR`, `GATEWAY_ERROR`, `SERVER_ERROR`. The coarse class. */
  code?: string;
  /** Human-readable, in Razorpay's words. NEVER shown to a patient — see the classifier. */
  description?: string;
  /** The request field at fault, on a validation error. */
  field?: string;
  /** Where the failure arose: `customer`, `business`, `bank`, `gateway`, `issuer`, `internal`, ... */
  source?: string;
  /** Which stage failed: `payment_initiation`, `payment_authentication`, `payment_authorization`, `payment_capture`, ... */
  step?: string;
  /** The FINE-GRAINED cause — `payment_failed`, `insufficient_funds`, `card_expired`, ... The single most useful field for classification. */
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** What a failed Razorpay call produces once `RazorpayClient` has normalised it. Mirrors the SDK's `INormalizeError`, plus the transport-failure case the SDK cannot express. */
export interface RazorpayApiError {
  /** The HTTP status, or `undefined` when the request never got a response at all. */
  statusCode?: number;
  error?: RazorpayErrorBody;
  /** Set when the failure was a transport one (DNS, refused, reset, timeout, abort) rather than an HTTP response. */
  transport?: { kind: 'network' | 'timeout'; message: string };
}

/** `orders.create` request. `amount` is in INTEGER PAISE — the gateway boundary, per `payment-money.util.ts`. */
export interface RazorpayCreateOrderRequest {
  amount: number;
  currency: string;
  /** Our own reference, max 40 chars, unique. We send `payments.id`. */
  receipt?: string;
  notes?: Record<string, string>;
}

/** The order entity Razorpay returns. Only the fields this module reads are declared. */
export interface RazorpayOrder {
  id: string;
  entity?: string;
  amount?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  receipt?: string | null;
  /** `created`, `attempted`, `paid`. */
  status?: string;
  created_at?: number;
}

/** The payment entity, as it appears both in a fetch response and inside a webhook's `payload.payment.entity`. */
export interface RazorpayPayment {
  id: string;
  entity?: string;
  amount?: number;
  currency?: string;
  /** `created`, `authorized`, `captured`, `refunded`, `failed`. */
  status?: string;
  order_id?: string | null;
  /** `upi`, `card`, `netbanking`, `wallet`, ... FR-7.1's four methods and anything Razorpay adds. */
  method?: string;
  captured?: boolean;
  amount_refunded?: number;
  /** Present on a failure. These four are what `payment.failed` carries instead of an error envelope. */
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  created_at?: number;
}

/** `payments/:id/refund` request. `amount` in integer paise; omitting it means a FULL refund, which this module never does — it always sends an explicit amount. */
export interface RazorpayCreateRefundRequest {
  amount: number;
  /** `normal` settles through the usual banking cycle; `optimum` pays for speed. Normal is right for a consultation refund. */
  speed?: 'normal' | 'optimum';
  notes?: Record<string, string>;
}

/**
 * The refund entity.
 *
 * NOTE the status vocabulary: Razorpay's refund status is only
 * `pending | processed | failed`. Our own `refund_status` enum
 * (`enums.schema.ts`) additionally has `processing`, which means something
 * Razorpay has no word for — "we have sent this to the gateway and it accepted
 * it, but no `refund.processed` webhook has confirmed settlement yet". The two
 * vocabularies are mapped, never conflated.
 */
export interface RazorpayRefund {
  id: string;
  entity?: string;
  amount?: number;
  currency?: string;
  payment_id?: string;
  /** `pending`, `processed`, `failed`. */
  status?: string;
  speed_processed?: string;
  speed_requested?: string;
  created_at?: number;
}

/**
 * A webhook delivery's envelope.
 *
 * Deliberately loose: this arrives from outside, it is NOT run through a DTO
 * (the global `ValidationPipe` uses `whitelist: true` and would silently strip
 * every field it has no decorator for), and the only thing that has vouched
 * for it is the HMAC. Everything is read defensively by
 * `payment-webhook.service.ts`.
 */
export interface RazorpayWebhookEnvelope {
  entity?: string;
  account_id?: string;
  /** `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`, ... */
  event?: string;
  contains?: string[];
  payload?: {
    payment?: { entity?: RazorpayPayment };
    refund?: { entity?: RazorpayRefund };
    order?: { entity?: RazorpayOrder };
  };
  created_at?: number;
}

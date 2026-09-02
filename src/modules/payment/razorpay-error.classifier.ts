import { HttpException, HttpStatus } from '@nestjs/common';
import { PAYMENT_ERROR_CODES } from './payment.constants';
import type { RazorpayApiError, RazorpayErrorBody } from './razorpay.types';

/**
 * Normalises every way a Razorpay call can fail into ONE typed kind, and then
 * into one of OUR `{ code, message }` bodies with a patient-safe message.
 *
 * Modelled directly on `modules/ai`'s `ProviderErrorClassifier` pattern
 * (`openai-compatible.classifier.ts` and friends): a separate object rather
 * than a method on the client, so it can be unit-tested against realistic
 * error fixtures without a network call — which is where the subtle bugs in
 * this kind of code live. It follows the same two rules: `classify` must never
 * throw, and it must never return `undefined`. A shape nobody anticipated is
 * `unknown`, never "fine".
 *
 * It also follows `identity-otp.service.ts`'s discipline about what escapes:
 * no Razorpay error object, and no Razorpay wording, ever reaches a caller. A
 * patient is told what they can act on; the gateway's own text goes to the log
 * and to `payment_events.processing_error`, never into an HTTP body.
 *
 * ── The three signals Razorpay actually gives ──────────────────────────────
 *
 * On a failed API call the body is `{ "error": { code, description, source,
 * step, reason, field, metadata } }` (verified against the official SDK's own
 * exported `INormalizeError` type in `razorpay@2.9.8`):
 *
 *   `code`        the COARSE class. Only three matter here:
 *                 `BAD_REQUEST_ERROR` (400 — our request was wrong, or the
 *                 requested state change is not allowed), `GATEWAY_ERROR` (the
 *                 bank or gateway refused the payment), `SERVER_ERROR`
 *                 (Razorpay's own fault).
 *   `reason`      the FINE-GRAINED cause, and the most useful field by far:
 *                 `insufficient_funds`, `card_expired`, `payment_timed_out`,
 *                 `gateway_technical_error`, ...
 *   `source`/`step` WHO failed and WHERE: `customer`/`bank`/`issuer` vs
 *                 `internal`/`gateway`, at `payment_authorization` vs
 *                 `payment_capture`. Used as a tie-breaker, never alone.
 *
 * A `payment.failed` WEBHOOK carries the same information flattened onto the
 * payment entity as `error_code` / `error_description` / `error_source` /
 * `error_step` / `error_reason`, with no `error` wrapper at all. `classify`
 * accepts both shapes, because the alternative is two classifiers that drift.
 *
 * ── Why the description is matched by PATTERN, not by equality ─────────────
 *
 * Some states Razorpay only distinguishes in `description` — an over-sized
 * refund and a refund against a fully-refunded payment are both
 * `BAD_REQUEST_ERROR` on HTTP 400, separated by their wording alone. That
 * wording is Razorpay's to change without notice, so it is matched loosely and
 * every such branch has a safe fallback: anything unrecognised on a 400 is
 * `invalid_request`, which is refused rather than retried. Nothing here
 * *approves* money movement on the strength of a matched string; the patterns
 * only ever choose which refusal to report.
 */

/**
 * One classified Razorpay failure.
 *
 * `network_or_timeout` is deliberately a first-class kind rather than folded
 * into `gateway_unavailable`: it is the ONE case where we genuinely do not
 * know whether the gateway acted. A refund request that timed out may still
 * have been accepted, so it must never be silently retried — which is exactly
 * why `refunds.schema.ts` has the row created BEFORE the call.
 */
export type RazorpayFailureKind =
  | 'invalid_request'
  | 'authentication_failed'
  | 'payment_declined'
  | 'insufficient_funds'
  | 'gateway_unavailable'
  | 'rate_limited'
  | 'order_already_paid'
  | 'refund_not_permitted'
  | 'amount_mismatch'
  | 'network_or_timeout'
  | 'unknown';

export interface RazorpayFailure {
  kind: RazorpayFailureKind;
  /**
   * A short summary carrying the gateway's own words, for SERVER-SIDE use
   * only: logs, `payment_events.processing_error`, `refunds.failure_reason`.
   *
   * `refunds.schema.ts` says of `failure_reason`: "Gateway's own reason...
   * Never shown verbatim to a patient." This field is that text. It never
   * appears in an HTTP response — `toHttpException` builds the client message
   * from the KIND alone.
   */
  detail: string;
  /** Razorpay's own retry hint in milliseconds, when a 429 carried one. */
  retryAfterMs?: number;
}

/** How much gateway text a `detail` carries. Enough to diagnose, short enough for a `varchar(200)` column and a log line. */
const MAX_DETAIL_LENGTH = 180;

/* -------------------------------------------------------------------------- */
/* Field readers — everything is optional, nothing is trusted to be present.   */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Reads a string field, normalising Razorpay's THREE spellings of "absent" to
 * one empty string.
 *
 * `source`, `step` and `reason` come back as a real value, as JSON `null`, OR
 * as the literal two-character string `"NA"`, depending on which endpoint and
 * which failure. Razorpay's own refund-error documentation shows the null form
 * (`"source": null, "step": null, "reason": null`) while payment failures use
 * `"NA"`. Treating `"NA"` as a meaningful reason would send it down the
 * gateway-decline branch, so it is flattened here rather than at each use.
 */
function readString(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed === 'NA' || trimmed === 'null' ? '' : trimmed;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Pulls the five interesting fields out of EITHER shape:
 *   - an API error envelope, `{ statusCode, error: { code, reason, ... } }`
 *   - a `payment.failed` webhook's payment entity, whose fields are flattened
 *     as `error_code` / `error_reason` / `error_description` / `error_source`
 *     / `error_step`.
 */
function readSignals(error: unknown): {
  statusCode: number | undefined;
  code: string;
  description: string;
  reason: string;
  source: string;
  step: string;
  transportKind: string;
  transportMessage: string;
} {
  const record = asRecord(error);
  const envelope = asRecord(record.error) as RazorpayErrorBody & Record<string, unknown>;
  const transport = asRecord(record.transport);

  return {
    statusCode: readNumber(record.statusCode) ?? readNumber(record.status),
    // Envelope first, then the flattened webhook spelling.
    code: readString(envelope.code) || readString(record.error_code),
    description: readString(envelope.description) || readString(record.error_description),
    reason: readString(envelope.reason) || readString(record.error_reason),
    source: readString(envelope.source) || readString(record.error_source),
    step: readString(envelope.step) || readString(record.error_step),
    transportKind: readString(transport.kind),
    transportMessage: readString(transport.message),
  };
}

function toDetail(parts: readonly string[]): string {
  const collapsed = parts
    .filter((part) => part.length > 0)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length === 0) return 'no detail supplied by the gateway';
  return collapsed.length > MAX_DETAIL_LENGTH ? `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…` : collapsed;
}

/* -------------------------------------------------------------------------- */
/* Reason vocabularies                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `reason` values that specifically mean the customer did not have the money,
 * as opposed to the bank refusing for some other cause. Kept apart from the
 * general decline because the two need different words to a patient: "try
 * another method" versus "there wasn't enough in the account".
 */
const INSUFFICIENT_FUNDS_REASONS = new Set(['insufficient_funds', 'insufficient_balance']);

/**
 * `reason` values that mean the gateway/bank/issuer had a technical problem,
 * i.e. RETRYABLE, as opposed to a genuine decline. A patient hitting one of
 * these should be told to try again, not to change card.
 */
const GATEWAY_TECHNICAL_REASONS = new Set([
  'gateway_technical_error',
  'gateway_error',
  'server_error',
  'network_error',
  'payment_timed_out',
  'payment_delayed',
  'issuer_down',
  'bank_down',
]);

/**
 * `error.source` is the best-documented and most stable field Razorpay
 * publishes (`customer` · `business` · `gateway` · `razorpay`, plus
 * `bank`/`issuer`/`internal`/`network` seen in the wild), which is why it — not
 * the coarse `code` and not the description — decides WHOSE fault a downstream
 * failure was.
 *
 * That matters because a real `payment.failed` webhook frequently carries
 * `error_code: "BAD_REQUEST_ERROR"` even when the actual event is an ordinary
 * customer decline at `step: payment_authorization`. Trusting `code` there
 * would report a declined card as a malformed request of ours.
 */
/** The customer's card, their bank, or the card issuer said no. A genuine decline. */
const DECLINE_SOURCES = new Set(['customer', 'bank', 'issuer']);

/** Ours or Razorpay's problem, never the customer's. Retryable. */
const NON_CUSTOMER_SOURCES = new Set(['internal', 'razorpay', 'gateway', 'network']);

/** WE sent something wrong. Not retryable, and not the patient's fault to report. */
const BUSINESS_SOURCE = 'business';

/* -------------------------------------------------------------------------- */
/* Description patterns                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A refund larger than what is left to refund. Razorpay answers 400
 * `BAD_REQUEST_ERROR` and puts the distinction in the description alone.
 *
 * We should never actually see this: `refund.service.ts` enforces the same
 * invariant locally inside a `SELECT ... FOR UPDATE` before ever calling the
 * gateway. Reaching this branch means our local ledger and Razorpay's disagree
 * — which is precisely why it maps to its own kind and its own 409 rather than
 * a generic 400.
 */
const AMOUNT_EXCEEDS_PATTERNS = [
  /refund amount .{0,40}greater than/i,
  /greater than .{0,40}(?:amount )?captured/i,
  /greater than .{0,40}refundable/i,
  /exceeds .{0,40}(?:refundable|captured|payment) amount/i,
  /amount .{0,20}(?:is )?more than .{0,40}captured/i,
];

/**
 * A payment that has nothing left to give back, or that the gateway will not
 * refund for a reason no retry will change. Every string below is one Razorpay
 * actually publishes on its refund-errors page.
 *
 * *** THE MERCHANT-BALANCE CASE IS HERE ON PURPOSE, NOT UNDER
 * `insufficient_funds`. *** "Your account does not have enough balance to carry
 * out the refund operation" is about OUR Razorpay balance, not the patient's
 * bank account. Classifying it as `insufficient_funds` would tell a patient
 * their own card was declined for lack of funds during a REFUND — an alarming
 * and completely false statement about their money. It is a business problem
 * that needs support, which is exactly what `refund_not_permitted` says.
 */
const REFUND_NOT_PERMITTED_PATTERNS = [
  /fully refunded/i,
  /already .{0,20}(?:been )?refunded/i,
  /refund has already been processed/i,
  /cannot be refunded/i,
  /not .{0,20}refundable/i,
  /refund .{0,30}not (?:allowed|permitted|possible|supported)/i,
  /payment .{0,20}(?:is )?not captured/i,
  // Our own Razorpay account balance, NOT the customer's. See the note above.
  /account does not have enough balance/i,
  // A payment older than the bank's refund window (Razorpay documents 6 months).
  /more than \d+ months? old/i,
  // A chargeback is being investigated; refunding now would double-refund.
  /blocked due to ongoing dispute/i,
];

/** An order that has already been paid — a duplicate checkout, or a replayed create. */
const ALREADY_PAID_PATTERNS = [
  /order .{0,30}already .{0,20}paid/i,
  /already been paid/i,
  /payment has already been (?:made|captured)/i,
  /amount .{0,20}already .{0,20}(?:paid|captured)/i,
];

/**
 * Razorpay's wording for a rejected API CREDENTIAL, as a SECONDARY net only.
 * HTTP 401 is the primary signal and is checked first — see `classify` step 2.
 *
 * *** VERIFIED AGAINST THE LIVE API, AND IT SURPRISED US. ***
 *
 * Razorpay's documentation gives "The api key provided is invalid" as the
 * description for a bad key. A live probe against `POST
 * https://api.razorpay.com/v1/orders` with deliberately wrong credentials
 * actually returns:
 *
 *     HTTP 401
 *     {"error":{"code":"BAD_REQUEST_ERROR","description":"Authentication failed"}}
 *
 * — no `source`, no `step`, no `reason`, and the description is the very
 * phrase the docs attribute to a PAYMENT-STEP failure instead. So the two
 * genuinely collide in wording and are separable ONLY by HTTP status. That is
 * exactly why this classifier branches on status first and treats descriptions
 * as a last resort.
 *
 * *** DO NOT ADD `/authentication failed/` TO THIS LIST. *** It would then
 * also match a customer who mistyped an OTP or failed 3-D Secure at `step:
 * payment_authentication` — turning an ordinary decline into a 503 "payments
 * are unavailable" AND raising a false alarm that our credentials are broken.
 * The 401 branch above already catches the credential case correctly, so
 * adding the phrase buys nothing and costs a misclassification.
 */
const API_CREDENTIAL_PATTERNS = [
  /\bapi (?:key|secret) (?:provided )?is invalid\b/i,
  /invalid api key/i,
  /\bapi[_ ]?key.{0,20}(?:invalid|expired|revoked)/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}

/* -------------------------------------------------------------------------- */
/* The classifier                                                              */
/* -------------------------------------------------------------------------- */

export class RazorpayErrorClassifier {
  /**
   * Never throws, never returns `undefined`. Order matters and every branch is
   * commented with WHY it sits where it does.
   */
  classify(error: unknown): RazorpayFailure {
    const s = readSignals(error);
    const detail = toDetail([s.code, s.reason, s.description, s.transportMessage]);
    // One haystack for the pattern checks, so a phrase is found wherever
    // Razorpay chose to put it.
    const haystack = `${s.description} ${s.reason}`;

    // 1. TRANSPORT FIRST. A request that never got a response has no status
    //    and no envelope, so every branch below would misread it. This is also
    //    the one outcome where we do not know whether the gateway acted.
    if (s.transportKind === 'network' || s.transportKind === 'timeout') {
      return { kind: 'network_or_timeout', detail };
    }

    // 2. AUTHENTICATION — BY HTTP STATUS FIRST.
    //    Razorpay reports a rejected API key as `BAD_REQUEST_ERROR` on HTTP
    //    401: the CODE says "bad request", the STATUS says "bad key", and only
    //    the status is right. There is no dedicated auth error code on the core
    //    Payments API, so 401/403 IS the signal. The description patterns are a
    //    secondary net for a proxy that mangles the status — and they match the
    //    API-CREDENTIAL wording only, never the payment-step "authentication
    //    failed" that a mistyped OTP produces. Never the caller's fault, so it
    //    is never reported as one (see `toHttpException`).
    if (s.statusCode === 401 || s.statusCode === 403 || matchesAny(s.description, API_CREDENTIAL_PATTERNS)) {
      return { kind: 'authentication_failed', detail };
    }

    // 3. RATE LIMITING, before the 4xx branch that would otherwise swallow it.
    if (s.statusCode === 429) {
      const retryAfterMs = readRetryAfterMs(error);
      return retryAfterMs === undefined
        ? { kind: 'rate_limited', detail }
        : { kind: 'rate_limited', retryAfterMs, detail };
    }

    // 4. RAZORPAY'S OWN FAULT — `SERVER_ERROR`, or any 5xx (500/502/503/504
    //    are all documented). Placed HERE, above every description check,
    //    because status is a contract and a description is not: a 5xx must
    //    never be re-read as a state conflict because its prose happened to
    //    contain a matching phrase.
    if (s.code === 'SERVER_ERROR' || (s.statusCode !== undefined && s.statusCode >= 500)) {
      return { kind: 'gateway_unavailable', detail };
    }

    // 5. STATE CONFLICTS, before the generic `invalid_request`. All three are
    //    HTTP 400 and are distinguishable ONLY by wording, which is why this is
    //    the one place descriptions are matched at all — and why every branch
    //    here falls through safely to `invalid_request` (a refusal) rather than
    //    to anything that lets money move. Checked most-specific first:
    //
    //    - an over-sized refund is an AMOUNT disagreement between our ledger
    //      and Razorpay's, which an admin must look at;
    //    - a fully-refunded or uncapturable payment is a STATE refusal, which
    //      is a no-op rather than an error to a cancellation flow;
    //    - an already-paid order means the patient has already been charged
    //      and must not be charged twice.
    if (matchesAny(haystack, AMOUNT_EXCEEDS_PATTERNS)) {
      return { kind: 'amount_mismatch', detail };
    }
    if (matchesAny(haystack, REFUND_NOT_PERMITTED_PATTERNS)) {
      return { kind: 'refund_not_permitted', detail };
    }
    if (matchesAny(haystack, ALREADY_PAID_PATTERNS)) {
      return { kind: 'order_already_paid', detail };
    }

    // 6. THE PAYMENT ITSELF FAILED DOWNSTREAM.
    //
    //    Entered whenever Razorpay gave ANY downstream detail — a
    //    `GATEWAY_ERROR` code, a `reason`, or a `source`. Deliberately not
    //    gated on `code`: a real `payment.failed` webhook routinely carries
    //    `error_code: "BAD_REQUEST_ERROR"` for what is plainly a customer
    //    decline at `step: payment_authorization`, and trusting the coarse code
    //    there would report a declined card as a malformed request of ours.
    //
    //    Then split, because "no money in the account", "the bank said no",
    //    "the gateway fell over" and "we sent nonsense" need four different
    //    things from the patient — and only one of them is worth retrying.
    if (s.code === 'GATEWAY_ERROR' || s.reason.length > 0 || s.source.length > 0) {
      // `reason` is the most specific signal, so it is read first.
      if (INSUFFICIENT_FUNDS_REASONS.has(s.reason)) {
        return { kind: 'insufficient_funds', detail };
      }
      if (GATEWAY_TECHNICAL_REASONS.has(s.reason)) {
        // A technical failure downstream is retryable, so it is reported as
        // unavailability rather than as a decline — telling a patient their
        // card was refused when the gateway simply fell over is both wrong and
        // alarming.
        return { kind: 'gateway_unavailable', detail };
      }

      // Then `source`, the most stable field Razorpay publishes.
      if (s.source === BUSINESS_SOURCE) {
        return { kind: 'invalid_request', detail };
      }
      if (DECLINE_SOURCES.has(s.source)) {
        return { kind: 'payment_declined', detail };
      }
      if (NON_CUSTOMER_SOURCES.has(s.source)) {
        return { kind: 'gateway_unavailable', detail };
      }

      // A `GATEWAY_ERROR` with no usable source at all is still a downstream
      // refusal, which is a decline from the patient's point of view.
      if (s.code === 'GATEWAY_ERROR') {
        return { kind: 'payment_declined', detail };
      }
    }

    // 7. A 400 we have no more specific rule for: our request was malformed,
    //    or asked for something not allowed. Refused, never retried.
    if (s.code === 'BAD_REQUEST_ERROR' || s.statusCode === 400 || s.statusCode === 404) {
      return { kind: 'invalid_request', detail };
    }

    // 8. Anything else. NOT assumed benign — landing here means Razorpay grew
    //    a failure mode worth adding a branch for, and it is reported as a
    //    failure so it shows up rather than passing silently.
    return { kind: 'unknown', detail };
  }
}

/**
 * Razorpay's own "come back in N" hint, in milliseconds. Reads the standard
 * `Retry-After` header from wherever the client attached it, in both the
 * seconds and HTTP-date spellings RFC 9110 permits.
 */
function readRetryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);
  const headers = asRecord(record.headers);

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'retry-after' || typeof value !== 'string') continue;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1_000);

    const at = Date.parse(value);
    if (Number.isFinite(at)) {
      const delta = at - Date.now();
      if (delta > 0) return delta;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Kind -> our own HTTP response                                               */
/* -------------------------------------------------------------------------- */

/**
 * THE PATIENT-SAFE MESSAGES.
 *
 * One entry per kind, exhaustively — the `Record<RazorpayFailureKind, ...>`
 * type means adding a kind without adding a message is a `tsc` error, not a
 * runtime `undefined` in a payment error body.
 *
 * Every message obeys three rules:
 *   1. It never repeats gateway text, a gateway error code, or the fact that
 *      the gateway is Razorpay. `identity-otp.service.ts` applies the same rule
 *      to Slide: a vendor failure "is never their fault, and it advertises the
 *      integration".
 *   2. It says what the patient can DO. "Try again shortly" and "try a
 *      different payment method" are different instructions and are not
 *      interchangeable.
 *   3. It never claims money moved or did not move when we do not know.
 *      `network_or_timeout` is the case that matters: it says the payment
 *      could not be confirmed, and tells them not to pay twice.
 */
const FAILURE_RESPONSES: Record<RazorpayFailureKind, { status: HttpStatus; code: string; message: string }> = {
  invalid_request: {
    // 502, not 400: the patient sent nothing wrong. WE sent something the
    // gateway would not accept, and reporting that as the caller's bad request
    // would be a lie that also hides a bug from us.
    status: HttpStatus.BAD_GATEWAY,
    code: PAYMENT_ERROR_CODES.GATEWAY_REJECTED,
    message: 'We could not set up this payment. Please try again, and contact support if it keeps happening.',
  },
  authentication_failed: {
    // Never surfaced as a 401 to the caller — their credentials are fine, ours
    // are not. Same reasoning as `identity-otp.service.ts`'s SlideAuthError
    // branch, which also answers 503 and logs loudly.
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: PAYMENT_ERROR_CODES.GATEWAY_UNAVAILABLE,
    message: 'Payments are temporarily unavailable. Please try again shortly.',
  },
  payment_declined: {
    status: HttpStatus.PAYMENT_REQUIRED,
    code: PAYMENT_ERROR_CODES.DECLINED,
    message: 'Your bank declined this payment. Please try a different payment method.',
  },
  insufficient_funds: {
    status: HttpStatus.PAYMENT_REQUIRED,
    code: PAYMENT_ERROR_CODES.INSUFFICIENT_FUNDS,
    message: 'This payment was declined for insufficient funds. Please try a different payment method.',
  },
  gateway_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: PAYMENT_ERROR_CODES.GATEWAY_UNAVAILABLE,
    message: 'Payments are temporarily unavailable. Please try again shortly.',
  },
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    code: PAYMENT_ERROR_CODES.GATEWAY_RATE_LIMITED,
    message: 'Too many payment attempts right now. Please try again in a moment.',
  },
  order_already_paid: {
    status: HttpStatus.CONFLICT,
    code: PAYMENT_ERROR_CODES.ALREADY_PAID,
    message: 'This consultation has already been paid for.',
  },
  refund_not_permitted: {
    status: HttpStatus.CONFLICT,
    code: PAYMENT_ERROR_CODES.REFUND_NOT_PERMITTED,
    message: 'This payment can no longer be refunded. Please contact support.',
  },
  amount_mismatch: {
    status: HttpStatus.CONFLICT,
    code: PAYMENT_ERROR_CODES.AMOUNT_MISMATCH,
    message: 'The amount did not match this booking. Please contact support.',
  },
  network_or_timeout: {
    // 504, and the message deliberately does NOT say the payment failed — we
    // do not know. Telling a patient to retry a possibly-successful charge is
    // how a double payment happens.
    status: HttpStatus.GATEWAY_TIMEOUT,
    code: PAYMENT_ERROR_CODES.GATEWAY_TIMEOUT,
    message: 'We could not confirm this payment with the payment provider. Please check your payment history before trying again.',
  },
  unknown: {
    status: HttpStatus.BAD_GATEWAY,
    code: PAYMENT_ERROR_CODES.GATEWAY_ERROR,
    message: 'Something went wrong while processing this payment. Please try again.',
  },
};

/** The `{ code, message }` body and status one kind maps to. Exposed so tests and the admin surface can assert the mapping without constructing an exception. */
export function responseForFailure(kind: RazorpayFailureKind): { status: HttpStatus; code: string; message: string } {
  return FAILURE_RESPONSES[kind];
}

/**
 * Turns a classified failure into the `HttpException` a caller sees.
 *
 * The gateway's own `detail` is NOT included in the body. It is the caller's
 * job to log it (`RazorpayClient` already does) and, where the failure belongs
 * to a durable row, to store it in `refunds.failure_reason` or
 * `payment_events.processing_error`.
 *
 * `retryAfterSeconds` is the one extra field that does travel, on a 429 — the
 * same convention `identity-otp.service.ts` uses for its OTP throttle, and
 * `HttpExceptionFilter` passes extras through untouched.
 */
export function toHttpException(failure: RazorpayFailure): HttpException {
  const { status, code, message } = FAILURE_RESPONSES[failure.kind];

  const body: Record<string, unknown> = { code, message };
  if (failure.kind === 'rate_limited' && failure.retryAfterMs !== undefined) {
    body.retryAfterSeconds = Math.max(1, Math.round(failure.retryAfterMs / 1_000));
  }

  return new HttpException(body, status);
}

/** Convenience for the common `catch` shape: classify, then throw our own exception. Returns `never` so callers can `throw classifyAndThrow(...)` or just call it. */
export function classifyAndThrow(classifier: RazorpayErrorClassifier, error: unknown): never {
  throw toHttpException(classifier.classify(error));
}

export type { RazorpayApiError };

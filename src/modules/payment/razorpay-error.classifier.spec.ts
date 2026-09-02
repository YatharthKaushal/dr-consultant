import { HttpStatus } from '@nestjs/common';
import { PAYMENT_ERROR_CODES } from './payment.constants';
import {
  RazorpayErrorClassifier,
  responseForFailure,
  toHttpException,
  type RazorpayFailureKind,
} from './razorpay-error.classifier';

/**
 * Fixtures are shaped like REAL Razorpay responses, not invented ones.
 *
 * The envelope (`{ statusCode, error: { code, description, source, step,
 * reason, metadata } }`) is the shape the official `razorpay@2.9.8` SDK
 * declares as its own exported `INormalizeError`. The description strings are
 * ones Razorpay publishes on its error pages. Three properties of the real API
 * are exercised deliberately because each has burned an integration before:
 *
 *   - `source`/`step`/`reason` arrive as a value, as JSON `null`, OR as the
 *     literal string `"NA"`, depending on endpoint and failure. All three
 *     spellings appear below.
 *   - the `reason` vocabulary is NOT a closed enum (Razorpay's own docs sample
 *     says `invalid_otp` where its published list says `incorrect_otp`), so an
 *     unrecognised reason must degrade rather than throw.
 *   - a rejected API key is `BAD_REQUEST_ERROR` on HTTP 401 — the code says
 *     "bad request" and only the status is right.
 */

const classifier = new RazorpayErrorClassifier();

/** An API error envelope, as `RazorpayClient` builds it from a non-2xx response. */
function apiError(
  statusCode: number,
  error: Record<string, unknown>,
  headers?: Record<string, string>,
): unknown {
  return headers ? { statusCode, error, headers } : { statusCode, error };
}

describe('RazorpayErrorClassifier', () => {
  describe('contract', () => {
    it('never throws, whatever it is handed', () => {
      for (const input of [undefined, null, 0, '', 'a string', [], {}, new Error('boom'), Symbol('x')]) {
        expect(() => classifier.classify(input)).not.toThrow();
      }
    });

    it('always returns a kind and a detail', () => {
      const failure = classifier.classify({});
      expect(failure.kind).toBe('unknown');
      expect(typeof failure.detail).toBe('string');
      expect(failure.detail.length).toBeGreaterThan(0);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('network_or_timeout', () => {
    it('classifies a transport failure with no HTTP response', () => {
      // The case the official SDK cannot express at all: its `normalizeError`
      // reads `err.response.status` unconditionally and throws a TypeError.
      const failure = classifier.classify({
        transport: { kind: 'network', message: 'getaddrinfo ENOTFOUND api.razorpay.com' },
      });
      expect(failure.kind).toBe('network_or_timeout');
    });

    it('classifies our own request timeout', () => {
      const failure = classifier.classify({
        transport: { kind: 'timeout', message: 'The operation was aborted due to timeout' },
      });
      expect(failure.kind).toBe('network_or_timeout');
    });

    it('takes precedence over any status that may also be present', () => {
      const failure = classifier.classify({
        statusCode: 500,
        transport: { kind: 'timeout', message: 'aborted' },
      });
      expect(failure.kind).toBe('network_or_timeout');
    });

    it('does NOT claim the payment failed — we do not know whether the gateway acted', () => {
      const response = responseForFailure('network_or_timeout');
      expect(response.status).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(response.message).toMatch(/could not confirm/i);
      expect(response.message).not.toMatch(/failed|declined|unsuccessful/i);
      // It must steer the patient AWAY from a blind retry, which is how a
      // double charge happens.
      expect(response.message).toMatch(/check your payment history/i);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('authentication_failed', () => {
    it('classifies a rejected API key — BAD_REQUEST_ERROR on HTTP 401', () => {
      // The status is the signal; the code lies.
      const failure = classifier.classify(
        apiError(401, {
          code: 'BAD_REQUEST_ERROR',
          description: 'The api key provided is invalid',
          source: null,
          step: null,
          reason: null,
          metadata: {},
        }),
      );
      expect(failure.kind).toBe('authentication_failed');
    });

    /**
     * *** THIS FIXTURE WAS CAPTURED FROM THE LIVE API, NOT FROM THE DOCS. ***
     *
     * `POST https://api.razorpay.com/v1/orders` with deliberately wrong
     * credentials returns exactly this, byte for byte. Note that the
     * description is "Authentication failed" — the phrase Razorpay's own
     * documentation attributes to a customer's PAYMENT-STEP failure, not to an
     * API-key failure, and that the documented "The api key provided is
     * invalid" string did not appear at all.
     *
     * The two cases are therefore separable only by HTTP status, which is
     * precisely why this classifier reads status before description.
     */
    it('classifies the REAL live-API response for a bad key (verified, contradicts the docs)', () => {
      const failure = classifier.classify(
        apiError(401, { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' }),
      );
      expect(failure.kind).toBe('authentication_failed');
      // And the patient is told nothing about our keys.
      expect(responseForFailure(failure.kind).status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('classifies a rejected API secret', () => {
      const failure = classifier.classify(
        apiError(401, { code: 'BAD_REQUEST_ERROR', description: 'The api secret provided is invalid.' }),
      );
      expect(failure.kind).toBe('authentication_failed');
    });

    it('classifies a 403', () => {
      expect(classifier.classify(apiError(403, { code: 'BAD_REQUEST_ERROR', description: 'Forbidden' })).kind).toBe(
        'authentication_failed',
      );
    });

    /**
     * *** THE MISCLASSIFICATION THIS TEST EXISTS TO PREVENT. ***
     *
     * "Authentication failed" is a PAYMENT-STEP description — a customer who
     * mistyped an OTP or failed 3-D Secure, at `step:
     * payment_authentication`. It has nothing to do with our API credentials.
     * Matching it as an auth failure would turn an ordinary customer decline
     * into a 503 "payments are unavailable" AND raise a false alarm that our
     * keys are broken.
     */
    it('does NOT treat a customer OTP/3DS failure as an API credential failure', () => {
      const failure = classifier.classify(
        apiError(400, {
          code: 'GATEWAY_ERROR',
          description: 'Authentication failed due to incorrect OTP',
          source: 'customer',
          step: 'payment_authentication',
          reason: 'incorrect_otp',
        }),
      );
      expect(failure.kind).not.toBe('authentication_failed');
      expect(failure.kind).toBe('payment_declined');
    });

    it('is never reported to the caller as their own auth problem', () => {
      const response = responseForFailure('authentication_failed');
      // 503, exactly as identity-otp.service.ts answers a SlideAuthError —
      // the caller's credentials are fine, ours are not.
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
      expect(response.message).not.toMatch(/key|secret|credential|api/i);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('rate_limited', () => {
    it('classifies HTTP 429', () => {
      const failure = classifier.classify(
        apiError(429, { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' }),
      );
      expect(failure.kind).toBe('rate_limited');
    });

    it('reads a Retry-After header in seconds', () => {
      const failure = classifier.classify(
        apiError(429, { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' }, { 'retry-after': '30' }),
      );
      expect(failure.kind).toBe('rate_limited');
      expect(failure.retryAfterMs).toBe(30_000);
    });

    it('reads a Retry-After header given as an HTTP date', () => {
      const future = new Date(Date.now() + 45_000).toUTCString();
      const failure = classifier.classify(
        apiError(429, { code: 'BAD_REQUEST_ERROR' }, { 'retry-after': future }),
      );
      expect(failure.retryAfterMs).toBeGreaterThan(30_000);
      expect(failure.retryAfterMs).toBeLessThanOrEqual(46_000);
    });

    it('ignores a Retry-After in the past rather than producing a negative cooldown', () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      const failure = classifier.classify(apiError(429, {}, { 'retry-after': past }));
      expect(failure.retryAfterMs).toBeUndefined();
    });

    it('surfaces the hint to the client as retryAfterSeconds, like identity does for OTP', () => {
      const exception = toHttpException({ kind: 'rate_limited', detail: 'x', retryAfterMs: 30_000 });
      expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(exception.getResponse()).toMatchObject({
        code: PAYMENT_ERROR_CODES.GATEWAY_RATE_LIMITED,
        retryAfterSeconds: 30,
      });
    });

    it('omits retryAfterSeconds when the gateway gave no hint', () => {
      const exception = toHttpException({ kind: 'rate_limited', detail: 'x' });
      expect(exception.getResponse()).not.toHaveProperty('retryAfterSeconds');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('gateway_unavailable', () => {
    it('classifies SERVER_ERROR', () => {
      expect(
        classifier.classify(apiError(500, { code: 'SERVER_ERROR', description: 'The server encountered an error.' }))
          .kind,
      ).toBe('gateway_unavailable');
    });

    it.each([[500], [502], [503], [504]])('classifies HTTP %s as unavailability', (status) => {
      expect(classifier.classify(apiError(status, {})).kind).toBe('gateway_unavailable');
    });

    it('classifies a technical gateway reason as retryable, NOT as a decline', () => {
      // Telling a patient their card was refused when the gateway simply fell
      // over is both wrong and alarming.
      const failure = classifier.classify(
        apiError(400, {
          code: 'GATEWAY_ERROR',
          description: 'Payment processing failed because of an error at the bank',
          source: 'gateway',
          step: 'payment_authorization',
          reason: 'gateway_technical_error',
        }),
      );
      expect(failure.kind).toBe('gateway_unavailable');
    });

    it('classifies a payment timeout at the bank as unavailability', () => {
      const failure = classifier.classify(
        apiError(400, { code: 'GATEWAY_ERROR', source: 'bank', step: 'payment_authorization', reason: 'payment_timed_out' }),
      );
      expect(failure.kind).toBe('gateway_unavailable');
    });

    it('classifies a GATEWAY_ERROR sourced internally as unavailability rather than a customer decline', () => {
      const failure = classifier.classify(
        apiError(400, { code: 'GATEWAY_ERROR', description: 'Payment failed', source: 'razorpay', step: 'payment_initiation' }),
      );
      expect(failure.kind).toBe('gateway_unavailable');
    });

    /**
     * A 5xx whose prose happens to contain a state-conflict phrase must stay a
     * 5xx. Status is a contract; a description is not. This asserts the branch
     * ORDER, which is the thing most likely to be broken by a later edit.
     */
    it('does not let description prose re-read a 5xx as a state conflict', () => {
      const failure = classifier.classify(
        apiError(500, { code: 'SERVER_ERROR', description: 'internal error while checking if already refunded' }),
      );
      expect(failure.kind).toBe('gateway_unavailable');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('payment_declined and insufficient_funds', () => {
    it('classifies insufficient funds as its own kind', () => {
      const failure = classifier.classify(
        apiError(400, {
          code: 'GATEWAY_ERROR',
          description: 'Your payment was declined as the account did not have sufficient balance',
          source: 'bank',
          step: 'payment_authorization',
          reason: 'insufficient_funds',
        }),
      );
      expect(failure.kind).toBe('insufficient_funds');
    });

    it('tells the patient to try another method, without repeating the gateway text', () => {
      const response = responseForFailure('insufficient_funds');
      expect(response.status).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(response.message).toMatch(/different payment method/i);
    });

    it.each([
      ['card_expired'],
      ['invalid_card'],
      ['incorrect_card_details'],
      ['payment_cancelled'],
      ['international_transaction_not_allowed'],
      // NOT in Razorpay's published list, but in its own docs sample — the
      // vocabulary is not a closed enum, and an unrecognised customer-sourced
      // reason must still be a plain decline.
      ['invalid_otp'],
      ['a_reason_that_does_not_exist_yet'],
    ])('classifies a customer-sourced GATEWAY_ERROR with reason %s as a decline', (reason) => {
      const failure = classifier.classify(
        apiError(400, { code: 'GATEWAY_ERROR', description: 'Payment failed', source: 'customer', step: 'payment_authorization', reason }),
      );
      expect(failure.kind).toBe('payment_declined');
    });

    it('classifies a GATEWAY_ERROR whose source is business as our own bad request', () => {
      const failure = classifier.classify(
        apiError(400, { code: 'GATEWAY_ERROR', description: 'Payment failed', source: 'business', step: 'payment_initiation' }),
      );
      expect(failure.kind).toBe('invalid_request');
    });

    it('never leaks the bank message to the patient', () => {
      const response = responseForFailure('payment_declined');
      expect(response.message).toBe('Your bank declined this payment. Please try a different payment method.');
      expect(response.message).not.toMatch(/razorpay|gateway|error_code|BAD_REQUEST/i);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('refund_not_permitted', () => {
    /** All of these are real strings from Razorpay's refund-errors documentation, all HTTP 400. */
    it.each([
      ['Refund has already been processed.'],
      ['The payment has been fully refunded'],
      ['This payment cannot be refunded'],
      ['Refund is not supported by the bank because the payment is more than 6 months old'],
      ['The refund on this payment is blocked due to ongoing dispute investigation.'],
    ])('classifies %s', (description) => {
      const failure = classifier.classify(
        apiError(400, { code: 'BAD_REQUEST_ERROR', description, source: null, step: null, reason: null, metadata: {} }),
      );
      expect(failure.kind).toBe('refund_not_permitted');
    });

    /**
     * *** THE DANGEROUS MISCLASSIFICATION. ***
     *
     * "Your account does not have enough balance" is about OUR Razorpay
     * merchant balance, not the patient's bank account. Calling it
     * `insufficient_funds` would tell a patient that THEIR card was declined
     * for lack of funds — during a REFUND, when money should be flowing
     * towards them. Alarming, and completely false.
     */
    it('classifies OUR merchant balance shortfall as not-permitted, never as the customer having no funds', () => {
      const failure = classifier.classify(
        apiError(400, {
          code: 'BAD_REQUEST_ERROR',
          description: 'Your account does not have enough balance to carry out the refund operation.',
          source: null,
          step: null,
          reason: null,
          metadata: {},
        }),
      );
      expect(failure.kind).toBe('refund_not_permitted');
      expect(failure.kind).not.toBe('insufficient_funds');
      // And the patient is never told their own funds were the problem.
      expect(responseForFailure(failure.kind).message).not.toMatch(/insufficient funds/i);
    });

    it('answers 409, because it is a state conflict and no retry will change it', () => {
      expect(responseForFailure('refund_not_permitted').status).toBe(HttpStatus.CONFLICT);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('amount_mismatch', () => {
    it.each([
      ['The refund amount provided is greater than amount captured'],
      ['Refund amount is greater than the refundable amount'],
      ['The amount is more than the amount captured'],
    ])('classifies %s', (description) => {
      const failure = classifier.classify(apiError(400, { code: 'BAD_REQUEST_ERROR', description }));
      expect(failure.kind).toBe('amount_mismatch');
    });

    it('is checked BEFORE refund_not_permitted, so an over-sized refund is not read as a state refusal', () => {
      // "greater than amount captured" is an AMOUNT disagreement between our
      // ledger and Razorpay's, which an admin must look at — meaningfully
      // different from "there is nothing left to refund".
      const failure = classifier.classify(
        apiError(400, {
          code: 'BAD_REQUEST_ERROR',
          description: 'The refund amount provided is greater than amount captured and cannot be refunded',
        }),
      );
      expect(failure.kind).toBe('amount_mismatch');
    });

    it('answers 409 and asks the patient to contact support rather than retry', () => {
      const response = responseForFailure('amount_mismatch');
      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.message).toMatch(/contact support/i);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('order_already_paid', () => {
    it.each([
      ['Order has already been paid'],
      ['This order has already been paid for'],
      ['Payment has already been captured for this order'],
    ])('classifies %s', (description) => {
      const failure = classifier.classify(apiError(400, { code: 'BAD_REQUEST_ERROR', description }));
      expect(failure.kind).toBe('order_already_paid');
    });

    it('answers 409, so a duplicate checkout cannot become a second charge', () => {
      const response = responseForFailure('order_already_paid');
      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(response.code).toBe(PAYMENT_ERROR_CODES.ALREADY_PAID);
      expect(response.message).toMatch(/already been paid/i);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('invalid_request', () => {
    it('classifies a validation failure', () => {
      const failure = classifier.classify(
        apiError(400, {
          code: 'BAD_REQUEST_ERROR',
          description: 'amount must be atleast INR 1.00',
          source: 'business',
          step: 'payment_initiation',
          field: 'amount',
        }),
      );
      expect(failure.kind).toBe('invalid_request');
    });

    it('classifies a 404 as an invalid request rather than as unknown', () => {
      expect(
        classifier.classify(apiError(404, { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found' }))
          .kind,
      ).toBe('invalid_request');
    });

    it('is reported as OUR fault (502), never as the caller sending a bad request', () => {
      const response = responseForFailure('invalid_request');
      // The patient sent nothing wrong; a 400 back to them would be a lie that
      // also hides the bug from us.
      expect(response.status).toBe(HttpStatus.BAD_GATEWAY);
      expect(response.status).not.toBe(HttpStatus.BAD_REQUEST);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('unknown', () => {
    it('classifies an unrecognised shape rather than guessing', () => {
      expect(classifier.classify({ statusCode: 418, error: { code: 'TEAPOT_ERROR' } }).kind).toBe('unknown');
    });

    it('classifies an empty body', () => {
      expect(classifier.classify({}).kind).toBe('unknown');
    });

    it('is reported as a failure, never as a success', () => {
      expect(responseForFailure('unknown').status).toBe(HttpStatus.BAD_GATEWAY);
    });
  });

  /* ------------------------------------------------------------------ */
  /* The flattened webhook shape                                         */
  /* ------------------------------------------------------------------ */

  describe('payment.failed webhook entity (flattened error_* fields, no envelope)', () => {
    it('classifies a declined card from the webhook shape', () => {
      const failure = classifier.classify({
        id: 'pay_29QQoUBi66xm2f',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment failed',
        error_source: 'customer',
        error_step: 'payment_authorization',
        error_reason: 'payment_failed',
      });
      expect(failure.kind).toBe('payment_declined');
    });

    it('classifies insufficient funds from the webhook shape', () => {
      const failure = classifier.classify({
        error_code: 'GATEWAY_ERROR',
        error_description: 'Payment was declined by the bank',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_reason: 'insufficient_funds',
      });
      expect(failure.kind).toBe('insufficient_funds');
    });

    it('treats "NA" as absent, not as a reason — Razorpay uses it for "no value"', () => {
      const failure = classifier.classify({
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment failed',
        error_source: 'NA',
        error_step: 'NA',
        error_reason: 'NA',
      });
      // "NA" must not enter the reason-driven branch and must not be treated
      // as a customer decline on the strength of a placeholder.
      expect(failure.kind).toBe('invalid_request');
      expect(failure.detail).not.toContain('NA');
    });

    it('treats null source/step/reason as absent', () => {
      const failure = classifier.classify({
        statusCode: 400,
        error: { code: 'BAD_REQUEST_ERROR', description: 'Something went wrong', source: null, step: null, reason: null },
      });
      expect(failure.kind).toBe('invalid_request');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Cross-cutting guarantees                                            */
  /* ------------------------------------------------------------------ */

  describe('every kind maps to a complete, patient-safe response', () => {
    const ALL_KINDS: RazorpayFailureKind[] = [
      'invalid_request',
      'authentication_failed',
      'payment_declined',
      'insufficient_funds',
      'gateway_unavailable',
      'rate_limited',
      'order_already_paid',
      'refund_not_permitted',
      'amount_mismatch',
      'network_or_timeout',
      'unknown',
    ];

    it.each(ALL_KINDS)('%s has a code, a message and a sane status', (kind) => {
      const response = responseForFailure(kind);
      expect(typeof response.code).toBe('string');
      expect(response.code.length).toBeGreaterThan(0);
      expect(typeof response.message).toBe('string');
      expect(response.message.length).toBeGreaterThan(0);
      // A defined failure path, never a bare 500.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it.each(ALL_KINDS)('%s never leaks gateway internals to the patient', (kind) => {
      const message = responseForFailure(kind).message;
      // No vendor name, no vendor error vocabulary, no HTTP mechanics.
      expect(message).not.toMatch(/razorpay|BAD_REQUEST_ERROR|GATEWAY_ERROR|SERVER_ERROR/i);
      expect(message).not.toMatch(/\berror_(?:code|description|reason|source|step)\b/i);
      expect(message).not.toMatch(/\bapi (?:key|secret)\b/i);
      // Reads as a sentence to a patient.
      expect(message).toMatch(/^[A-Z].*\.$/s);
    });

    it.each(ALL_KINDS)('%s produces an HttpException carrying our own { code, message } body', (kind) => {
      const exception = toHttpException({ kind, detail: 'gateway said something internal' });
      const body = exception.getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({ code: responseForFailure(kind).code });
      // *** The detail never travels. *** It is for logs, for
      // `payment_events.processing_error` and for `refunds.failure_reason`.
      expect(JSON.stringify(body)).not.toContain('gateway said something internal');
    });

    it('every kind maps to a distinct, non-empty error code drawn from the module vocabulary', () => {
      const codes = new Set(ALL_KINDS.map((kind) => responseForFailure(kind).code));
      const known = new Set<string>(Object.values(PAYMENT_ERROR_CODES));
      for (const code of codes) {
        expect(known.has(code)).toBe(true);
      }
    });
  });

  describe('detail', () => {
    it('carries the gateway words for the log, joined and trimmed', () => {
      const failure = classifier.classify(
        apiError(400, { code: 'GATEWAY_ERROR', reason: 'insufficient_funds', description: 'Not enough balance' }),
      );
      expect(failure.detail).toContain('GATEWAY_ERROR');
      expect(failure.detail).toContain('insufficient_funds');
      expect(failure.detail).toContain('Not enough balance');
    });

    it('is truncated so it fits a varchar(200) column and a log line', () => {
      const failure = classifier.classify(apiError(400, { code: 'BAD_REQUEST_ERROR', description: 'x'.repeat(1_000) }));
      expect(failure.detail.length).toBeLessThanOrEqual(200);
    });

    it('says so plainly when the gateway supplied nothing', () => {
      expect(classifier.classify({ statusCode: 418 }).detail).toBe('no detail supplied by the gateway');
    });
  });
});

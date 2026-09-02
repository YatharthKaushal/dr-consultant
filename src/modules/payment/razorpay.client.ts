import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../../config/env/env.validation';
import {
  RAZORPAY_API_BASE_URL,
  RAZORPAY_REQUEST_TIMEOUT_MS,
} from './payment.constants';
import { RazorpayErrorClassifier, toHttpException } from './razorpay-error.classifier';
import type {
  RazorpayApiError,
  RazorpayCreateOrderRequest,
  RazorpayCreateRefundRequest,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayRefund,
} from './razorpay.types';

/**
 * The ONLY file in this codebase that talks to Razorpay over the wire.
 *
 * Same contract `identity-otp.service.ts` holds for Slide: every caller gets
 * back either a typed result or a plain Nest `HttpException`, and no gateway
 * error object ever escapes this file. Nothing downstream needs to know which
 * payment provider we use, which is what keeps `payments.schema.ts`'s "no
 * `gateway` column" decision honest at the code level too.
 *
 * ── Hand-rolled `fetch`, not the official SDK ──────────────────────────────
 *
 * `razorpay@2.9.8` was installed and its source read before this was decided.
 * The reasoning is recorded in full at the top of `razorpay.types.ts`; the
 * short version is that its error normaliser throws a non-`Error` object
 * literal, CRASHES with a `TypeError` on any transport failure (it reads
 * `err.response.status` unconditionally, and axios sets no `.response` on a
 * network error), and its webhook signature helper uses `===` rather than a
 * constant-time comparison. All three are disqualifying for money code, and
 * only four calls are needed.
 *
 * ── What this client guarantees ────────────────────────────────────────────
 *
 *   - EVERY call is bounded by `RAZORPAY_REQUEST_TIMEOUT_MS`. An unbounded
 *     call to a payment provider pins a request thread indefinitely.
 *   - A transport failure is reported AS a transport failure. That distinction
 *     is the whole reason `RazorpayApiError.transport` exists: on a timeout we
 *     do not know whether the gateway acted, and `refunds.schema.ts`'s
 *     row-before-call ordering depends on us being honest about that.
 *   - Credentials never appear in a log line, an error, or a thrown body.
 *   - NO RETRIES, anywhere. `orders.create` and `refunds.create` both MOVE
 *     MONEY or create an obligation to; retrying one whose outcome is unknown
 *     is exactly how a double charge or a double refund happens. Retry policy
 *     belongs to a caller that can first go and ask what actually happened —
 *     which is what `PaymentContract.reconcileWithGateway` is for.
 */
@Injectable()
export class RazorpayClient {
  private readonly logger = new Logger(RazorpayClient.name);
  private readonly classifier = new RazorpayErrorClassifier();

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;

  constructor() {
    const env = getEnv();
    this.keyId = env.RAZORPAY_KEY_ID;
    this.keySecret = env.RAZORPAY_KEY_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  }

  /**
   * The PUBLISHABLE key the mobile client needs to open Razorpay Checkout.
   *
   * Safe to return to a client — it is half of a Basic-auth pair and is
   * useless without the secret, which is exactly why Razorpay splits them.
   * `CreatedOrder.gatewayKeyId` carries it to the app.
   */
  getPublishableKeyId(): string {
    return this.keyId;
  }

  /** The webhook HMAC secret. Read by `payment-webhook.service.ts` and by nothing else. */
  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  /** `POST /orders` — `amount` in INTEGER PAISE. */
  async createOrder(request: RazorpayCreateOrderRequest): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('POST', '/orders', request, 'create order');
  }

  /** `GET /orders/:id` — used by reconciliation to ask what the gateway thinks, never trusting local state. */
  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('GET', `/orders/${encodeURIComponent(orderId)}`, undefined, 'fetch order');
  }

  /** `GET /orders/:id/payments` — the authoritative answer to "was this order actually paid, and by which payment". */
  async fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const result = await this.call<{ items?: RazorpayPayment[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
      undefined,
      'fetch order payments',
    );
    return Array.isArray(result.items) ? result.items : [];
  }

  /** `GET /payments/:id`. */
  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.call<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`, undefined, 'fetch payment');
  }

  /**
   * `POST /payments/:id/refund` — `amount` in INTEGER PAISE.
   *
   * NOT retried on failure, and not retried on timeout least of all: Razorpay
   * may have accepted a refund whose response we never saw. The `refunds` row
   * already exists by the time this is called (`refunds.schema.ts`: "the row
   * is created BEFORE the gateway call, so a crash mid-call leaves evidence
   * rather than a silent gap"), so a timed-out refund is a row with no
   * `gateway_refund_id` that a human or a reconciliation sweep can resolve —
   * not a lost refund, and not a double one.
   */
  async createRefund(paymentId: string, request: RazorpayCreateRefundRequest): Promise<RazorpayRefund> {
    return this.call<RazorpayRefund>(
      'POST',
      `/payments/${encodeURIComponent(paymentId)}/refund`,
      request,
      'create refund',
    );
  }

  /* ---------------------------------------------------------------------- */

  /**
   * One HTTP call, with the timeout, the auth header, the error normalisation
   * and the logging that every Razorpay call needs and none should repeat.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown | undefined,
    operation: string,
  ): Promise<T> {
    const url = `${RAZORPAY_API_BASE_URL}${path}`;
    // `AbortSignal.timeout` rather than a hand-rolled timer: no dangling
    // handle to clear, and it aborts the socket rather than merely resolving
    // a race, so a hung connection is actually released.
    const signal = AbortSignal.timeout(RAZORPAY_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal,
        headers: {
          // HTTP Basic, `key_id:key_secret` — what Razorpay's API expects and
          // what the official SDK's axios `auth` option produces.
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // *** The case the official SDK cannot express. *** No response at all:
      // DNS failure, refused connection, reset socket, or our own timeout.
      const isTimeout = isAbortLike(error);
      const message = error instanceof Error ? error.message : String(error);
      const apiError: RazorpayApiError = {
        transport: { kind: isTimeout ? 'timeout' : 'network', message },
      };
      this.logger.error(`Razorpay ${operation} failed before a response (${isTimeout ? 'timeout' : 'network'}): ${message}`);
      throw toHttpException(this.classifier.classify(apiError));
    }

    const payload = await this.readJson(response);

    if (!response.ok) {
      const apiError: RazorpayApiError = {
        statusCode: response.status,
        error: asErrorBody(payload),
      };
      // Retry-After is attached where the classifier looks for it, so a 429
      // hint survives into the client's `retryAfterSeconds`.
      const withHeaders = { ...apiError, headers: headersToObject(response.headers) };
      const failure = this.classifier.classify(withHeaders);
      // Logged server-side WITH the gateway's own words; the thrown body gets
      // none of them.
      this.logger.error(`Razorpay ${operation} failed (HTTP ${response.status}, ${failure.kind}): ${failure.detail}`);
      throw toHttpException(failure);
    }

    return payload as T;
  }

  /** A non-JSON body from Razorpay (an HTML error page from a proxy, say) must not throw a `SyntaxError` that the classifier would then read as a transport failure. */
  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
}

/** True for our own `AbortSignal.timeout` firing, and for an abort from anywhere else. */
function isAbortLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === 'TimeoutError' || record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

/** Pulls `{ error: {...} }` out of a response body without trusting any of it to be there. */
function asErrorBody(payload: unknown): RazorpayApiError['error'] {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = (payload as { error?: unknown }).error;
  return typeof candidate === 'object' && candidate !== null ? (candidate as RazorpayApiError['error']) : undefined;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

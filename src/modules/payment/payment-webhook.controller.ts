import { BadRequestException, Controller, Headers, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../shared/auth/auth.decorator';
import { PaymentWebhookService, type WebhookResult } from './payment-webhook.service';
import {
  PAYMENT_ERROR_CODES,
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
} from './payment.constants';
import { RazorpayClient } from './razorpay.client';

/**
 * `POST /api/payments/webhook` — the Razorpay callback.
 *
 * Note the `/api` global prefix (`main.ts#setGlobalPrefix`): the URL to
 * register in the Razorpay dashboard is `https://<host>/api/payments/webhook`,
 * not `/payments/webhook`.
 *
 * ── Why this controller is shaped the way it is ───────────────────────────
 *
 * `@Public()` — Razorpay has no bearer token to send. `docs/MODULES.md` calls
 * the caller a "service account: non-human access for third-party callbacks
 * such as the payment gateway webhook, with no access to clinical screens."
 * THE HMAC SIGNATURE IS THE ENTIRE AUTHENTICATION, which is why it is checked
 * on the first line of the handler, before anything is parsed or written.
 *
 * `@Req()` with `request.rawBody`, NOT `@Body()` — two independent reasons:
 *
 *   1. The HMAC must be computed over the exact bytes Razorpay signed.
 *      Re-serialising a parsed object does not reproduce them (key order and
 *      number formatting are not preserved), so a signature check against
 *      `JSON.stringify(body)` would be both wrong and unsafe. `main.ts` passes
 *      `{ rawBody: true }` to `NestFactory.create` so `@nestjs/platform-fastify`
 *      keeps the Buffer.
 *   2. The global `ValidationPipe` runs with `whitelist: true`, which SILENTLY
 *      STRIPS every property no DTO decorator claims. A DTO here would quietly
 *      empty `payload.payment.entity` — the handler would see a well-formed
 *      event with no data in it, and mark it processed. Taking the body raw
 *      makes that impossible.
 *
 * *** This endpoint returns 2xx for everything except a bad signature. ***
 * Razorpay retries on a non-2xx, and once an event is durably recorded in
 * `payment_events` a retry achieves nothing but load. A handler failure is
 * recorded in `processing_error` with `processed_at` left null for the sweep.
 */
@Controller('payments')
export class PaymentWebhookController {
  constructor(
    private readonly webhooks: PaymentWebhookService,
    private readonly gateway: RazorpayClient,
  ) {}

  @Post('webhook')
  @Public()
  async handle(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers(RAZORPAY_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(RAZORPAY_EVENT_ID_HEADER) eventId: string | undefined,
  ): Promise<WebhookResult> {
    const rawBody = request.rawBody;

    // *** THE AUTH BOUNDARY. Nothing below this line runs for an unverified
    // body, and nothing above it touches a table. ***
    if (!Buffer.isBuffer(rawBody) || !this.webhooks.verifySignature(rawBody, signature, this.gateway.getWebhookSecret())) {
      this.webhooks.rejectUnverified();
    }

    // Only AFTER the signature verifies. A missing event id on a verified body
    // is a genuine malformity — the id is what the whole idempotency guarantee
    // is keyed on, and without it we cannot promise not to double-process.
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.WEBHOOK_MALFORMED,
        message: `Missing ${RAZORPAY_EVENT_ID_HEADER} header.`,
      });
    }

    return this.webhooks.record({ eventId, rawBody, signatureVerified: true });
  }
}

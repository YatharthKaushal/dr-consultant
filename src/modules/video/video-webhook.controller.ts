import { Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../shared/auth/auth.decorator';
import { LIVEKIT_AUTH_HEADER, LIVEKIT_AUTH_HEADER_ALT } from './video.constants';
import { VideoWebhookService, type VideoWebhookResult } from './video-webhook.service';

/**
 * `POST /api/video/webhook` — the LiveKit callback.
 *
 * Note the `/api` global prefix (`main.ts#setGlobalPrefix`): the URL to
 * configure in `livekit.yaml`'s `webhook.urls` is
 * `https://<host>/api/video/webhook`, not `/video/webhook`. The path is
 * exported as `VIDEO_WEBHOOK_PATH` because `main.ts` needs it to exempt this
 * route from Fastify's JSON parser, and a literal in two places would silently
 * stop matching the day the route moves.
 *
 * ── Why this controller is shaped the way it is ───────────────────────────
 *
 * Modelled directly on `payment-webhook.controller.ts`, because it is in
 * exactly the same position and the reasoning transfers line for line.
 *
 * `@Public()` — LiveKit has no bearer token to send. `docs/MODULES.md` calls
 * this caller a "service account: non-human access for third-party callbacks",
 * and *** THE SIGNATURE IS THE ENTIRE AUTHENTICATION ***, which is why it is
 * checked on the first line of the handler, before anything is parsed or
 * written.
 *
 * `@Req()` with `request.rawBody`, NOT `@Body()` — two independent reasons:
 *
 *   1. LiveKit's `Authorization` JWT carries a `sha256` claim over the EXACT
 *      BYTES it sent. Re-serialising a parsed object does not reproduce them
 *      (key order and number formatting are not preserved), so verification
 *      against `JSON.stringify(body)` would reject every genuine delivery.
 *      `main.ts` passes `{ rawBody: true }` to `NestFactory.create`, and
 *      `shared/http/webhook-safe-json.parser.ts` keeps the Buffer populated
 *      even for a body Fastify could not parse.
 *   2. The global `ValidationPipe` runs with `whitelist: true`, which SILENTLY
 *      STRIPS every property no DTO decorator claims. A DTO here would quietly
 *      empty `participant` — the handler would see a well-formed event with no
 *      participant in it. Taking the body raw makes that impossible.
 *
 * *** This endpoint returns 2xx for everything except a bad signature. ***
 * LiveKit retries on a non-2xx, and a retry storm on an event that will never
 * process helps nobody. See `video-webhook.service.ts` for the one honest cost
 * of that choice.
 *
 * `@HttpCode(200)` rather than Nest's default 201 for a `@Post`: nothing here
 * is CREATED from the caller's point of view, and a 201 on a webhook is the
 * kind of small oddity that makes a provider's delivery log harder to read.
 * Both are 2xx, so neither triggers a retry.
 */
@Controller('video')
export class VideoWebhookController {
  constructor(private readonly webhooks: VideoWebhookService) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers(LIVEKIT_AUTH_HEADER) authorization: string | undefined,
    /**
     * The SDK exports `authorizeHeader = 'Authorize'`, a long-standing
     * misnomer in `livekit-server-sdk`. The LiveKit server sends
     * `Authorization`, but both are read so that neither a server change nor a
     * proxy that rewrites the name can silently break verification — the
     * failure mode of getting this wrong is every delivery 401ing and every
     * session's metadata quietly going missing.
     */
    @Headers(LIVEKIT_AUTH_HEADER_ALT) authorize: string | undefined,
  ): Promise<VideoWebhookResult> {
    const rawBody = request.rawBody;
    const authHeader = authorization ?? authorize;

    // *** THE AUTH BOUNDARY. Nothing below this line runs for an unverified
    // body, and nothing above it touches a table. ***
    const delivery = Buffer.isBuffer(rawBody) ? await this.webhooks.verify(rawBody, authHeader) : null;
    if (delivery === null) {
      this.webhooks.rejectUnverified();
    }

    return this.webhooks.handle(delivery);
  }
}

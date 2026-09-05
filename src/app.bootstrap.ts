import fastifyMultipart from '@fastify/multipart';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { getEnv } from './config/env/env.validation';
import { DOCUMENT_UPLOAD_HARD_CEILING_BYTES } from './modules/document/document.constants';
import { PAYMENT_WEBHOOK_PATH } from './modules/payment/payment.constants';
import { VIDEO_WEBHOOK_PATH } from './modules/video/video.constants';
import { registerWebhookSafeJsonParser } from './shared/http/webhook-safe-json.parser';

/**
 * *** THE ONE DEFINITION OF WHAT THIS APPLICATION IS. ***
 *
 * Builds and configures the Nest application, stopping just short of
 * `listen()`. `main.ts` calls this and then listens; an end-to-end test calls
 * it and then uses `app.inject()`.
 *
 * ── WHY THIS IS NOT INLINE IN `main.ts` ────────────────────────────────────
 *
 * Because an end-to-end test that configures the app itself is not testing
 * this application — it is testing a similar one. Every line below changes
 * what a request does:
 *
 *   - `setGlobalPrefix('api')` decides whether any URL in the test is even
 *     the right URL;
 *   - `ValidationPipe({ whitelist: true })` is what STRIPS unknown fields and
 *     rejects bad DTOs, so a test without it cannot catch a validation bug and
 *     will happily pass a payload production would refuse;
 *   - `{ rawBody: true }` and the webhook parser are the entire reason a
 *     signed webhook works at all.
 *
 * A test that reproduces this by hand drifts the first time one line here
 * changes, and drifts SILENTLY — it keeps passing while production diverges.
 * So there is one definition and both callers share it.
 *
 * *** IT DELIBERATELY DOES NOT `listen()`. *** Fastify seals its content-type
 * parsers at `ready()`, which `listen()` triggers; the webhook parser must be
 * registered after `init()` and before that. Returning an initialised but
 * unlistening app is what lets both callers respect that ordering — and it is
 * why `app.inject()` works here without binding a port.
 */
export async function createConfiguredApp(): Promise<NestFastifyApplication> {
  // Memoized — `main.ts` has already called this and exited on a bad
  // environment, and a test calling it first gets the same validation.
  const env = getEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: read the real client IP from X-Forwarded-For when behind a
    // load balancer, so per-IP OTP rate limiting (otp_challenges) sees each
    // caller's own IP rather than the proxy's.
    //
    // *** maxParamLength: 200. ***
    //
    // `find-my-way` (Fastify's router) defaults this to 100 and answers a
    // bare 414 for any `:param` segment longer than that — before the
    // request reaches any guard, pipe or controller. `GET /care-hub/shared/
    // :token` (`carehub-share.controller.ts`) is the one route in this
    // codebase whose path param is not an id: `carehub.service.ts#mintShareLink`
    // mints `v1.<base64url(JSON({c: contentItemId, e: expiresAtSeconds}))>.
    // <base64url(hmac-sha256)>`, which is consistently ~126 characters for a
    // uuid `contentItemId` and a 10-digit unix-seconds expiry. Left at the
    // default, EVERY token this feature has ever minted 414s against its own
    // route — found by driving a real, server-minted token through
    // `app.inject()` in `carehub.endpoint.spec.ts`, not a contrived edge
    // case. 200 leaves headroom above the current fixed length without
    // materially widening what the router will match for any other route.
    new FastifyAdapter({ logger: false, trustProxy: env.TRUST_PROXY, maxParamLength: 200 }),
    // *** rawBody: REQUIRED BY THE RAZORPAY WEBHOOK (M-12). ***
    //
    // `@nestjs/platform-fastify` only preserves the unparsed request body when
    // this is set: its `useBodyParser` does `if (rawBody === true &&
    // Buffer.isBuffer(body)) req.rawBody = body`, and without the flag
    // `request.rawBody` is simply `undefined`. Verified by reading the
    // installed adapter (11.2.1), not assumed.
    //
    // `payment-webhook.controller.ts` computes
    // `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` over those exact bytes
    // and compares it against `x-razorpay-signature`. That check is the ENTIRE
    // authentication for a `@Public()` route that can mark a consultation
    // paid, so it has to be the bytes Razorpay actually signed — re-serialising
    // the parsed object does not reproduce them (JSON round-tripping preserves
    // neither key order nor number formatting).
    //
    // Cost is one retained Buffer per request with a parsed body; it is not
    // retained for multipart, which never goes through this parser.
    { rawBody: true },
  );

  // `@fastify/multipart` — registered globally so any module's controller
  // can call `request.file()`/`request.parts()`. Two routes use it today,
  // both through `multipart-file.util.ts`: `modules/document`'s
  // `POST /documents` (patient uploads) and `modules/doctor`'s
  // `POST /doctors/me/documents` (a doctor's own credential documents).
  // `limits.fileSize` is the TRANSPORT hard ceiling — a defensive backstop
  // above the real, business-rule cap a patient actually hits
  // (`documents.max_file_size_mb`, default 15MB, enforced in
  // `patient-file.service.ts`). Set explicitly rather than left to default:
  // `@fastify/multipart` falls back to `fastify.initialConfig.bodyLimit`
  // (1MiB) whenever `limits.fileSize` is omitted (see
  // `node_modules/@fastify/multipart/index.js`), which would silently cap
  // every upload at 1MiB.
  //
  // Fastify's OWN `bodyLimit` (left at its 1MiB default below — NOT raised)
  // is unrelated and does not need to change: `@fastify/multipart` registers
  // its content-type parser as a no-op (`setMultipart` only flags the
  // request and returns immediately; it never buffers the body itself), so
  // Fastify's generic body-buffering path — the one `bodyLimit` actually
  // gates — never runs for a multipart request. The real byte ceiling for a
  // multipart body is busboy's own `fileSize` limit, configured here.
  // Verified by reading the installed plugin's source, not assumed.
  await app.register(fastifyMultipart, {
    limits: { fileSize: DOCUMENT_UPLOAD_HARD_CEILING_BYTES, files: 1 },
  });

  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.CORS_ORIGIN ?? true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Required for DatabaseModule.onApplicationShutdown to drain the pool.
  app.enableShutdownHooks();

  // *** EVERY SIGNED WEBHOOK MUST SURVIVE A BODY THAT IS NOT VALID JSON. ***
  //
  // Fastify's stock JSON parser answers 400 before any controller runs, which
  // would make an authentic-but-unparseable delivery unrecordable AND have the
  // provider retry it forever. Both webhooks here verify a signature over the
  // RAW BYTES, so both need the exemption for the same reason: Razorpay's HMAC
  // (M-12) and LiveKit's `WebhookReceiver` (M-14).
  //
  // ONLY these paths are exempted; every other route keeps Fastify's exact
  // previous behaviour, byte for byte. The rule and its reasoning live in
  // `shared/http/webhook-safe-json.parser.ts` — shared rather than inside one
  // module, because two modules now depend on it and a rule cannot live inside
  // one of its two consumers.
  //
  // Each path is imported from the module that owns the route rather than
  // written as a literal here, so it cannot silently stop matching the day a
  // route moves.
  //
  // *** ORDERING IS LOAD-BEARING. *** This must run AFTER `app.init()` and
  // BEFORE `app.listen()`. Nest registers its own `application/json` parser
  // (the one `{ rawBody: true }` configures) during `init()`, so replacing it
  // any earlier means `removeContentTypeParser` finds nothing to remove and
  // Nest then throws "Content type parser 'application/json' already present"
  // on top of ours. Fastify seals its parsers at `ready()`, which `listen()`
  // triggers, so it cannot go any later. `init()` is idempotent and `listen()`
  // calls it again harmlessly.
  await app.init();
  registerWebhookSafeJsonParser(app.getHttpAdapter().getInstance(), [
    PAYMENT_WEBHOOK_PATH,
    VIDEO_WEBHOOK_PATH,
  ]);

  return app;
}

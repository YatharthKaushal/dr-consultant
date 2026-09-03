import fastifyMultipart from '@fastify/multipart';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { getEnv } from './config/env/env.validation';
import { DOCUMENT_UPLOAD_HARD_CEILING_BYTES } from './modules/document/document.constants';
import { registerWebhookSafeJsonParser } from './modules/payment/payment-webhook.body-parser';
import { PAYMENT_WEBHOOK_PATH } from './modules/payment/payment.constants';

async function bootstrap(): Promise<void> {
  // Validate the environment before anything else is constructed. On a missing
  // required variable this prints the offending names and exits(1) — it never
  // returns, so nothing below runs against a half-configured process.
  const env = getEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: read the real client IP from X-Forwarded-For when behind a
    // load balancer, so per-IP OTP rate limiting (otp_challenges) sees each
    // caller's own IP rather than the proxy's.
    new FastifyAdapter({ logger: false, trustProxy: env.TRUST_PROXY }),
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

  // *** M-12: the Razorpay webhook must survive a body that is not valid JSON.
  //
  // Fastify's stock JSON parser answers 400 before any controller runs, which
  // would make an authentic-but-unparseable delivery unrecordable AND have
  // Razorpay retry it forever. Only the webhook path is exempted; every other
  // route keeps Fastify's exact previous behaviour. The rule and its reasoning
  // live in the payment module, next to the code that depends on them.
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
  registerWebhookSafeJsonParser(app.getHttpAdapter().getInstance(), PAYMENT_WEBHOOK_PATH);

  await app.listen(env.PORT, '0.0.0.0');

  Logger.log(`Server listening on http://localhost:${env.PORT}/api [${env.NODE_ENV}]`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nApplication failed to start: ${message}\n\n`);
  process.exit(1);
});

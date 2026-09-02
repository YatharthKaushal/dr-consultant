import fastifyMultipart from '@fastify/multipart';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { getEnv } from './config/env/env.validation';
import { DOCUMENT_UPLOAD_HARD_CEILING_BYTES } from './modules/document/document.constants';

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
  );

  // `@fastify/multipart` — registered globally so any module's controller
  // can call `request.file()`/`request.parts()` (currently only `modules/
  // document`'s `POST /documents`, via `multipart-file.util.ts`).
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

  await app.listen(env.PORT, '0.0.0.0');

  Logger.log(`Server listening on http://localhost:${env.PORT}/api [${env.NODE_ENV}]`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nApplication failed to start: ${message}\n\n`);
  process.exit(1);
});

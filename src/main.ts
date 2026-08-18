import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { getEnv } from './config/env/env.validation';

async function bootstrap(): Promise<void> {
  // Validate the environment before anything else is constructed. On a missing
  // required variable this prints the offending names and exits(1) — it never
  // returns, so nothing below runs against a half-configured process.
  const env = getEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
  );

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

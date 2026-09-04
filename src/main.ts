import { Logger } from '@nestjs/common';
import { createConfiguredApp } from './app.bootstrap';
import { getEnv } from './config/env/env.validation';

async function bootstrap(): Promise<void> {
  // Validate the environment before anything else is constructed. On a missing
  // required variable this prints the offending names and exits(1) — it never
  // returns, so nothing below runs against a half-configured process.
  const env = getEnv();

  // Everything about WHAT this application is lives in `app.bootstrap.ts`, so
  // that an end-to-end test boots the same app rather than a lookalike. This
  // file owns only the part a test must NOT do: bind a port.
  const app = await createConfiguredApp();

  await app.listen(env.PORT, '0.0.0.0');

  Logger.log(`Server listening on http://localhost:${env.PORT}/api [${env.NODE_ENV}]`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nApplication failed to start: ${message}\n\n`);
  process.exit(1);
});

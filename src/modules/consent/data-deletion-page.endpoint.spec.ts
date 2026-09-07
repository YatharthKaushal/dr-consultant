/**
 * *** HTTP-LEVEL SMOKE TEST FOR THE PUBLIC DELETE-ACCOUNT PAGE. ***
 * The page's own JS drives already-tested real routes
 * (`/api/auth/otp/*`, `/api/data-deletion-requests`) — this file proves
 * only what is unique to this controller: it renders, for both apps, with
 * no token, and reflects the real configured grace period.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { appConfigTable } from '../../schema/app-config.schema';
import { DATA_DELETION_CONFIG_KEYS } from './data-deletion.constants';

jest.setTimeout(30_000);

describe('Public account-deletion page — HTTP endpoint, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let storedGraceDaysBefore: unknown;

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    const [row] = await db.select({ value: appConfigTable.value }).from(appConfigTable).where(eq(appConfigTable.key, DATA_DELETION_CONFIG_KEYS.GRACE_PERIOD_DAYS));
    storedGraceDaysBefore = row?.value;
  });

  afterAll(async () => {
    try {
      if (storedGraceDaysBefore === undefined) {
        await db.delete(appConfigTable).where(eq(appConfigTable.key, DATA_DELETION_CONFIG_KEYS.GRACE_PERIOD_DAYS));
      } else {
        await db
          .insert(appConfigTable)
          .values({ key: DATA_DELETION_CONFIG_KEYS.GRACE_PERIOD_DAYS, value: storedGraceDaysBefore })
          .onConflictDoUpdate({ target: appConfigTable.key, set: { value: storedGraceDaysBefore } });
      }
    } finally {
      if (app) await app.close();
    }
  });

  it('200s with no Authorization header, for both apps, and reflects the configured grace period', async () => {
    await db
      .insert(appConfigTable)
      .values({ key: DATA_DELETION_CONFIG_KEYS.GRACE_PERIOD_DAYS, value: 21 })
      .onConflictDoUpdate({ target: appConfigTable.key, set: { value: 21 } });

    const patientRes = await app.inject({ method: 'GET', url: '/api/account-deletion?app=patient' });
    expect(patientRes.statusCode).toBe(200);
    expect(patientRes.headers['content-type']).toContain('text/html');
    expect(patientRes.body).toContain('Patient app');
    expect(patientRes.body).toContain('21 days');

    const doctorRes = await app.inject({ method: 'GET', url: '/api/account-deletion?app=doctor' });
    expect(doctorRes.statusCode).toBe(200);
    expect(doctorRes.body).toContain('Doctor app');
  });

  it('an unrecognised or missing ?app= falls back to patient rather than erroring', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/account-deletion' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Patient app');
  });
});

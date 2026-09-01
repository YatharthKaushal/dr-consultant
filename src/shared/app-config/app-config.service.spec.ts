import type { Database } from '../../config/db/database.config';
import { AppConfigService } from './app-config.service';

function createFakeDb(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { select, from, where, limit };
}

describe('AppConfigService', () => {
  it('returns the stored numeric value when the row exists', async () => {
    const db = createFakeDb([{ value: 5 }]);
    const service = new AppConfigService(db as unknown as Database);

    await expect(service.getNumber('otp.verify.max_attempts_per_challenge', 3)).resolves.toBe(5);
  });

  it('falls back when the row is missing', async () => {
    const db = createFakeDb([]);
    const service = new AppConfigService(db as unknown as Database);

    await expect(service.getNumber('otp.verify.max_attempts_per_challenge', 3)).resolves.toBe(3);
  });

  it('falls back when the stored value is not a number', async () => {
    const db = createFakeDb([{ value: 'not-a-number' }]);
    const service = new AppConfigService(db as unknown as Database);

    await expect(service.getNumber('otp.verify.max_attempts_per_challenge', 3)).resolves.toBe(3);
  });

  it('returns the stored JSON value, or the fallback when absent', async () => {
    const present = createFakeDb([{ value: { sms: true } }]);
    await expect(
      new AppConfigService(present as unknown as Database).getJson('search.crisis_keywords', { sms: false }),
    ).resolves.toEqual({ sms: true });

    const absent = createFakeDb([]);
    await expect(
      new AppConfigService(absent as unknown as Database).getJson('search.crisis_keywords', { sms: false }),
    ).resolves.toEqual({ sms: false });
  });

  it('memoizes a read for the TTL window, so a second call within it does not hit the database', async () => {
    const db = createFakeDb([{ value: 5 }]);
    const service = new AppConfigService(db as unknown as Database);

    await service.getNumber('otp.verify.max_attempts_per_challenge', 3);
    await service.getNumber('otp.verify.max_attempts_per_challenge', 3);

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidate()', async () => {
    const db = createFakeDb([{ value: 5 }]);
    const service = new AppConfigService(db as unknown as Database);

    await service.getNumber('otp.verify.max_attempts_per_challenge', 3);
    service.invalidate('otp.verify.max_attempts_per_challenge');
    await service.getNumber('otp.verify.max_attempts_per_challenge', 3);

    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

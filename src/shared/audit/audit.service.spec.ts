import type { Database } from '../../config/db/database.config';
import { AuditService } from './audit.service';
import type { AuditEntry } from './audit.types';

const ENTRY: AuditEntry = {
  actorType: 'admin',
  actorId: 'admin-1',
  action: 'create',
  entityType: 'admin_role',
  entityId: 'admin-2',
};

/** A minimal stand-in for `Database`/`DatabaseTransaction` — only `insert().values()` is exercised. */
function createFakeExecutor(valuesImpl: () => Promise<unknown>) {
  const values = jest.fn(valuesImpl);
  const insert = jest.fn().mockReturnValue({ values });
  return { insert, values };
}

describe('AuditService', () => {
  it('writes through the default db when no transaction handle is given', async () => {
    const db = createFakeExecutor(() => Promise.resolve());
    const service = new AuditService(db as unknown as Database);

    await service.write(ENTRY);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'admin_role' }));
  });

  it('writes through the provided transaction handle, not the default db', async () => {
    const db = createFakeExecutor(() => Promise.resolve());
    const tx = createFakeExecutor(() => Promise.resolve());
    const service = new AuditService(db as unknown as Database);

    await service.write(ENTRY, tx as unknown as Database);

    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('propagates a failure in transactional mode, so the caller\'s transaction rolls back', async () => {
    const db = createFakeExecutor(() => Promise.resolve());
    const tx = createFakeExecutor(() => Promise.reject(new Error('insert failed')));
    const service = new AuditService(db as unknown as Database);

    await expect(service.write(ENTRY, tx as unknown as Database)).rejects.toThrow('insert failed');
  });

  it('swallows a failure in best-effort mode, so a login is never failed by a log-write error', async () => {
    const db = createFakeExecutor(() => Promise.reject(new Error('insert failed')));
    const service = new AuditService(db as unknown as Database);

    await expect(service.write(ENTRY)).resolves.toBeUndefined();
  });

  it('defaults optional fields to null rather than undefined', async () => {
    const db = createFakeExecutor(() => Promise.resolve());
    const service = new AuditService(db as unknown as Database);

    await service.write(ENTRY);

    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: null, metadata: null, ipAddress: null }),
    );
  });
});

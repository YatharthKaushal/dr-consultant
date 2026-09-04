import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import { AUDIT_RETENTION_SWEEP_BATCH_SIZE, AUDIT_RETENTION_SWEEP_MAX_BATCHES } from './audit.constants';
import type { AuditRepository } from './audit.repository';
import { AuditRetentionSweepService } from './audit-retention-sweep.service';

function createService(retentionDays = 0) {
  const repo = { deleteEligibleBatch: jest.fn().mockResolvedValue([]) } as unknown as jest.Mocked<AuditRepository>;
  const appConfig = { getNumber: jest.fn().mockResolvedValue(retentionDays) } as unknown as jest.Mocked<AppConfigService>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  const service = new AuditRetentionSweepService(repo, appConfig, audit);
  return { service, repo, appConfig, audit };
}

describe('AuditRetentionSweepService', () => {
  /** *** THE SHIPPED DEFAULT. *** See `audit.constants.ts#AUDIT_CONFIG_FALLBACKS` / this service's own header. */
  it('does nothing when retentionDays resolves to 0 (the shipped default)', async () => {
    const { service, repo } = createService(0);

    const result = await service.sweep();

    expect(result).toEqual({ enabled: false, retentionDays: 0, deleted: 0, batches: 0, truncated: false });
    expect(repo.deleteEligibleBatch).not.toHaveBeenCalled();
  });

  it('deletes only login/verify-eligible rows older than the configured window, in one batch when short', async () => {
    const { service, repo } = createService(90);
    repo.deleteEligibleBatch.mockResolvedValue([1, 2, 3]);

    const now = new Date('2026-09-04T00:00:00Z');
    const result = await service.sweep(now);

    expect(repo.deleteEligibleBatch).toHaveBeenCalledTimes(1);
    const [cutoff, actions, batchSize] = repo.deleteEligibleBatch.mock.calls[0]!;
    expect(cutoff).toEqual(new Date('2026-06-06T00:00:00Z'));
    expect(actions).toEqual(['login', 'verify']);
    expect(batchSize).toBe(AUDIT_RETENTION_SWEEP_BATCH_SIZE);
    expect(result).toEqual({ enabled: true, retentionDays: 90, deleted: 3, batches: 1, truncated: false });
  });

  it('pages across full batches until a short page ends the pass', async () => {
    const { service, repo } = createService(30);
    const fullBatch = Array.from({ length: AUDIT_RETENTION_SWEEP_BATCH_SIZE }, (_, i) => i);
    repo.deleteEligibleBatch.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce([999]);

    const result = await service.sweep();

    expect(repo.deleteEligibleBatch).toHaveBeenCalledTimes(2);
    expect(result.deleted).toBe(AUDIT_RETENTION_SWEEP_BATCH_SIZE + 1);
    expect(result.batches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('reports truncated when it hits AUDIT_RETENTION_SWEEP_MAX_BATCHES with rows still eligible', async () => {
    const { service, repo } = createService(30);
    const fullBatch = Array.from({ length: AUDIT_RETENTION_SWEEP_BATCH_SIZE }, (_, i) => i);
    repo.deleteEligibleBatch.mockResolvedValue(fullBatch);

    const result = await service.sweep();

    expect(repo.deleteEligibleBatch).toHaveBeenCalledTimes(AUDIT_RETENTION_SWEEP_MAX_BATCHES);
    expect(result.truncated).toBe(true);
  });

  it('audits its own deletions, best-effort, once per non-empty pass', async () => {
    const { service, repo, audit } = createService(30);
    repo.deleteEligibleBatch.mockResolvedValue([1]);

    await service.sweep();

    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        actorId: null,
        action: 'delete',
        entityType: 'audit_log_retention_purge',
        entityId: 'audit_log',
        metadata: expect.objectContaining({ deleted: 1, retentionDays: 30, eligibleActions: ['login', 'verify'] }),
      }),
    );
  });

  it('writes no audit entry when nothing was deleted', async () => {
    const { service, audit } = createService(30);

    await service.sweep();

    expect(audit.write).not.toHaveBeenCalled();
  });

  it('degrades a malformed or out-of-bounds stored window to disabled', async () => {
    const { service, repo } = createService(-5);

    const result = await service.sweep();

    expect(result.enabled).toBe(false);
    expect(repo.deleteEligibleBatch).not.toHaveBeenCalled();
  });
});

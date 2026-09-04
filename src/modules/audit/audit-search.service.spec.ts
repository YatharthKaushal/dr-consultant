import type { AuditLogRow } from '../../schema/audit-log.schema';
import type { AuditRepository } from './audit.repository';
import { AuditSearchService } from './audit-search.service';

function row(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: 1,
    actorType: 'doctor',
    actorId: 'doc-1',
    action: 'read',
    entityType: 'clinical_record',
    entityId: 'rec-1',
    consultationId: 'c-1',
    metadata: { event: 'record_read' },
    ipAddress: '203.0.113.9',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    ...overrides,
  };
}

function createService() {
  const repo = { listForAdmin: jest.fn() } as unknown as jest.Mocked<AuditRepository>;
  return { service: new AuditSearchService(repo), repo };
}

describe('AuditSearchService', () => {
  it('delegates to the repository with the filter as given', async () => {
    const { service, repo } = createService();
    repo.listForAdmin.mockResolvedValue([]);

    const filter = { actorType: 'doctor' as const, limit: 50, offset: 0 };
    await service.search(filter);

    expect(repo.listForAdmin).toHaveBeenCalledWith(filter);
  });

  /** *** THE SRS §6.2 SEAM. *** Never `ipAddress`, even though the underlying row carries one — same precedent `ClinicalAuditEntryView` sets. */
  it('never leaks ipAddress into the returned view', async () => {
    const { service, repo } = createService();
    repo.listForAdmin.mockResolvedValue([row()]);

    const [result] = await service.search({ limit: 50, offset: 0 });

    expect(result).not.toHaveProperty('ipAddress');
    expect(result).toEqual({
      id: 1,
      actorType: 'doctor',
      actorId: 'doc-1',
      action: 'read',
      entityType: 'clinical_record',
      entityId: 'rec-1',
      consultationId: 'c-1',
      metadata: { event: 'record_read' },
      createdAt: row().createdAt,
    });
  });

  it('maps every row, preserving order', async () => {
    const { service, repo } = createService();
    repo.listForAdmin.mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);

    const results = await service.search({ limit: 50, offset: 0 });

    expect(results.map((r) => r.id)).toEqual([1, 2]);
  });
});

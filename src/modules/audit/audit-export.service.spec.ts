import type { AuditLogRow } from '../../schema/audit-log.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AuditRepository } from './audit.repository';
import { AuditExportService } from './audit-export.service';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

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
  const repo = { listForAdmin: jest.fn().mockResolvedValue([]) } as unknown as jest.Mocked<AuditRepository>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  return { service: new AuditExportService(repo, audit), repo, audit };
}

describe('AuditExportService', () => {
  it('re-runs the filtered query capped at AUDIT_EXPORT_MAX_ROWS from offset 0', async () => {
    const { service, repo } = createService();
    await service.exportCsv({ actorType: 'doctor' }, ADMIN_ID);

    expect(repo.listForAdmin).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'doctor', offset: 0 }));
  });

  it('renders a CSV with no ipAddress column and a UTF-8 BOM', async () => {
    const { service, repo } = createService();
    repo.listForAdmin.mockResolvedValue([row()]);

    const result = await service.exportCsv({}, ADMIN_ID);

    expect(result.content.charCodeAt(0)).toBe(0xfeff);
    expect(result.content).not.toContain('203.0.113.9');
    expect(result.content).toContain('id,actor_type,actor_id,action,entity_type,entity_id,consultation_id,metadata,created_at');
    expect(result.content).toContain('1,doctor,doc-1,read,clinical_record,rec-1,c-1');
    expect(result.rowCount).toBe(1);
  });

  it('audits the export itself, including the filter used', async () => {
    const { service, audit } = createService();
    await service.exportCsv({ actorType: 'admin', action: 'export' }, ADMIN_ID);

    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        actorId: ADMIN_ID,
        action: 'export',
        entityType: 'audit_log_export',
        entityId: 'audit_log',
        metadata: expect.objectContaining({
          rowCount: 0,
          filter: expect.objectContaining({ actorType: 'admin', action: 'export' }),
        }),
      }),
    );
  });

  it('serialises non-null metadata as a JSON string field, and null as null', async () => {
    const { service, repo } = createService();
    repo.listForAdmin.mockResolvedValue([row({ metadata: { a: 1 } }), row({ id: 2, metadata: null })]);

    const result = await service.exportCsv({}, ADMIN_ID);

    expect(result.content).toContain('"{""a"":1}"');
  });
});

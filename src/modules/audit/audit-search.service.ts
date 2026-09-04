import { Injectable } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import type { AuditLogFilter, AuditLogView } from './audit.types';
import { toAuditLogView } from './audit-mapper.util';

/**
 * `audit.read` (M-21's search half). Search by actor (`actorType`+
 * `actorId`), module (`entityType`), date range and `action` — FR-name-less
 * but `docs/MODULES.md` M-21's own feature line: "Log search by actor,
 * module and date, with export."
 *
 * A thin pass-through over `AuditRepository.listForAdmin` — there is no rule
 * to hold here beyond composing the filter and stripping `ipAddress`
 * (`toAuditLogView`), which is exactly the shape
 * `search.service.ts#listQueryLogs` already uses for `search_queries`.
 */
@Injectable()
export class AuditSearchService {
  constructor(private readonly repo: AuditRepository) {}

  async search(filter: AuditLogFilter): Promise<AuditLogView[]> {
    const rows = await this.repo.listForAdmin(filter);
    return rows.map(toAuditLogView);
  }
}

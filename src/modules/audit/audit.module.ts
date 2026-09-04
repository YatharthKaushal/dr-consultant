import { Module } from '@nestjs/common';
import { AuditAdminController } from './audit-admin.controller';
import { AuditConfigRepository } from './audit-config.repository';
import { AuditConfigService } from './audit-config.service';
import { AuditExportService } from './audit-export.service';
import { AuditRepository } from './audit.repository';
import { AuditRetentionSweepService } from './audit-retention-sweep.service';
import { AuditSearchService } from './audit-search.service';

/**
 * M-21: Audit, Compliance and Data Rights — the READ half only (search,
 * export, client-configurable retention over `audit_log`). Named `AuditModule`
 * like every other domain module (`PaymentModule`, `GovernanceModule`) is
 * named after its own domain — `app.module.ts` imports it under an alias
 * (`AuditModule as AuditReadModule`) purely to avoid a *file-scope* name
 * collision with `shared/audit/audit.module.ts`'s own `AuditModule` (the
 * `@Global()` module that provides `AuditService`, the WRITE side every
 * other module already calls). The two are unrelated providers in unrelated
 * files; nothing here re-exports or wraps `AuditService`.
 *
 * *** THIS MODULE OWNS NO TABLE OF ITS OWN. *** `audit_log` is written by
 * `shared/audit/audit.service.ts` (global, unchanged by this build) on
 * behalf of every other module. This module only reads it
 * (`AuditRepository`), plus writes the two things that ARE its own:
 * `app_config['audit.retention_days']` (`AuditConfigRepository`) and, when a
 * retention sweep actually deletes rows, its own `system`-attributed
 * `audit_log` entry recording that it did (`AuditRetentionSweepService`,
 * through the shared `AuditService` like every other module).
 *
 * *** NO `<domain>.contract.ts`/`<domain>.facade.ts`. *** Same reasoning
 * `governance.module.ts`'s header gives for why IT has none: nothing is
 * named as depending on this module (`docs/MODULES.md`'s M-21 section lists
 * no downstream consumer), every read this module offers is reached through
 * `AuditAdminController`, and inventing a public surface with no caller
 * would be speculative, not additive.
 *
 * Data-deletion execution (`data_deletion_requests`, the OTHER half of M-21)
 * is a separate, parallel build against `modules/consent` and is
 * DELIBERATELY not imported or referenced here — this module never reads or
 * writes that table.
 */
@Module({
  controllers: [AuditAdminController],
  providers: [
    AuditRepository,
    AuditSearchService,
    AuditExportService,
    AuditConfigRepository,
    AuditConfigService,
    AuditRetentionSweepService,
  ],
})
export class AuditModule {}

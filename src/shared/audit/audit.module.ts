import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global so every module can `@Inject(AuditService)` without importing this
 * module explicitly — same shape as `DatabaseModule`/`EventsModule`.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

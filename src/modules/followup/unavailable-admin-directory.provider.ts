import { Injectable, Logger } from '@nestjs/common';
import type { AdminDirectoryPort } from './followup-admin-directory.contract';

/**
 * The null object bound to `ADMIN_DIRECTORY_PORT`. Returns `[]`, never
 * throws: no admin push goes out, but the `safety_alerts` row this module
 * writes is still the durable, authoritative side of FR-13.4, readable today
 * at `GET /admin/safety-alerts` (`governance.read_queues`). A missing push
 * to admins must never block or fail the alert write itself.
 */
@Injectable()
export class UnavailableAdminDirectoryProvider implements AdminDirectoryPort {
  private readonly logger = new Logger(UnavailableAdminDirectoryProvider.name);

  async listAdminIdsWithPermission(permission: string): Promise<string[]> {
    this.logger.debug(`No admin directory provider configured; notifying no admins for permission "${permission}".`);
    return [];
  }
}

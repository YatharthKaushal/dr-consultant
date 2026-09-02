import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { StorageProviderService } from './storage-provider.service';
import { UpdateStorageProviderDto } from './storage.dto';
import { toPublicStorageProvider } from './storage.mapper';

/**
 * The whole admin surface for blob storage. Admin-only (`@AccountType`), and
 * split across two permissions exactly like `AiAdminController`:
 *
 *   - `storage.read`   — see which providers are configured and how each is
 *                        doing. Bundled into `operations`: diagnosing "why
 *                        are uploads failing" is day-to-day support work.
 *   - `storage.manage` — edit a provider's config/active state/priority.
 *                        `super_admin` ONLY: misconfiguring storage breaks
 *                        uploads platform-wide, same weight class as
 *                        `ai.manage`.
 *
 * `:id` goes through `createUuidValidationPipe` — see `uuid-param.pipe.ts`.
 *
 * No POST, no DELETE: exactly two rows always exist, seeded once by
 * `storage.seed.ts`. See `storage-providers.schema.ts`.
 */
@Controller('admin/storage')
@AccountType('admin')
export class StorageAdminController {
  constructor(private readonly providers: StorageProviderService) {}

  @Get('providers')
  @RequirePermission(PERMISSIONS.STORAGE_READ)
  async listProviders() {
    const rows = await this.providers.adminList();
    return rows.map(toPublicStorageProvider);
  }

  @Get('providers/:id')
  @RequirePermission(PERMISSIONS.STORAGE_READ)
  async getProvider(@Param('id', createUuidValidationPipe('id')) id: string) {
    return toPublicStorageProvider(await this.providers.adminGetById(id));
  }

  @Patch('providers/:id')
  @RequirePermission(PERMISSIONS.STORAGE_MANAGE)
  async updateProvider(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateStorageProviderDto,
  ) {
    return toPublicStorageProvider(await this.providers.adminUpdate(auth.accountId, id, dto));
  }
}

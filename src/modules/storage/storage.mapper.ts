import type { StorageProviderConfig, StorageProviderRow } from '../../schema/storage-providers.schema';

/**
 * Row -> response projection for the admin endpoints.
 *
 * An EXPLICIT field list, never a spread of the row — same discipline as
 * `ai.mapper.ts#toPublicAgentProfile`, even though nothing on this row is
 * currently secret (see `storage-providers.schema.ts`'s comment on why there
 * is no encrypted-credential column here at all). Writing every field out by
 * hand means a future column cannot silently widen this API response; a new
 * field is invisible until someone chooses to add it here.
 */
export interface PublicStorageProvider {
  id: string;
  provider: string;
  isActive: boolean;
  priority: number;
  config: StorageProviderConfig;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastFailureKind: string | null;
  cooldownUntil: Date | null;
  lastSucceededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicStorageProvider(row: StorageProviderRow): PublicStorageProvider {
  return {
    id: row.id,
    provider: row.provider,
    isActive: row.isActive,
    priority: row.priority,
    config: row.config,
    consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt,
    lastFailureKind: row.lastFailureKind,
    cooldownUntil: row.cooldownUntil,
    lastSucceededAt: row.lastSucceededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

import type { McpClientRow } from '../../schema/mcp-clients.schema';
import type { PublicMcpClient } from './mcp.contract';

/**
 * `mcp_clients` row -> the shape anything outside this module may see.
 *
 * Field-by-field, never a spread. A spread would carry `hashedKey` out of the
 * module the moment someone stopped thinking about it, which is precisely the
 * mistake this project cannot afford to make once — so the omission is
 * structural (the return type has no such field) and mechanical (nothing here
 * copies unlisted columns). `mcp.mapper.spec.ts` asserts the absence against
 * a row that carries a digest.
 */
export function toPublicMcpClient(row: McpClientRow): PublicMcpClient {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyLast4: row.keyLast4,
    scopes: row.scopes,
    isActive: row.isActive,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

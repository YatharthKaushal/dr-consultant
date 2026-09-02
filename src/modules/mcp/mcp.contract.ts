/**
 * An MCP client as everything outside this module sees it. NOTE what is
 * absent: `hashedKey`, and any field from which a usable credential could be
 * reconstructed. `keyPrefix`/`keyLast4` are identification only — they are
 * what an admin reads in a listing to tell two integrations apart.
 *
 * There is no variant of this type that carries the plaintext key. The key is
 * returned by exactly one method (`McpClientService#create`), in its own
 * separate return type, and never enters a row projection at all — which is
 * what makes "no endpoint returns a key" a property of the type system rather
 * than of remembering to omit a field.
 */
export interface PublicMcpClient {
  id: string;
  name: string;
  keyPrefix: string;
  keyLast4: string;
  /** Tool names this client may call. */
  scopes: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The one-time creation response. `plaintextKey` exists in this object, in
 * the HTTP response it becomes, and nowhere else — not in the database, not
 * in the audit log, not in any subsequent read.
 */
export interface CreatedMcpClient {
  client: PublicMcpClient;
  /** Shown once. Unrecoverable afterwards: rotating means creating a new client. */
  plaintextKey: string;
}

/** The authenticated caller behind an MCP request, attached to the Fastify request by `McpClientGuard`. */
export interface McpClientContext {
  clientId: string;
  name: string;
  scopes: readonly string[];
}

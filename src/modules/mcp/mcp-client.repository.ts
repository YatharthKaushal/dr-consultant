import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { mcpClientsTable, type McpClientRow } from '../../schema/mcp-clients.schema';
import { mcpRequestAttemptsTable } from '../../schema/mcp-request-attempts.schema';

/** A Drizzle db handle or an open transaction — same `Executor` pattern the availability repositories use. */
type Executor = Database | DatabaseTransaction;

export interface McpClientInsert {
  name: string;
  hashedKey: string;
  keyPrefix: string;
  keyLast4: string;
  scopes: string[];
}

export interface McpClientUpdate {
  name?: string;
  scopes?: string[];
  isActive?: boolean;
}

/** `mcp_clients` and its rate-limit counter table. */
@Injectable()
export class McpClientRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<McpClientRow | null> {
    const [row] = await executor.select().from(mcpClientsTable).where(eq(mcpClientsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByName(name: string, executor: Executor = this.db): Promise<McpClientRow | null> {
    const [row] = await executor.select().from(mcpClientsTable).where(eq(mcpClientsTable.name, name)).limit(1);
    return row ?? null;
  }

  /** The authentication lookup. `key_prefix` is unique, so this is a single-row index hit. */
  async findByKeyPrefix(keyPrefix: string, executor: Executor = this.db): Promise<McpClientRow | null> {
    const [row] = await executor.select().from(mcpClientsTable).where(eq(mcpClientsTable.keyPrefix, keyPrefix)).limit(1);
    return row ?? null;
  }

  async list(executor: Executor = this.db): Promise<McpClientRow[]> {
    return executor.select().from(mcpClientsTable).orderBy(mcpClientsTable.name);
  }

  async create(data: McpClientInsert, executor: Executor = this.db): Promise<McpClientRow> {
    const [row] = await executor.insert(mcpClientsTable).values(data).returning();
    if (!row) {
      throw new Error('mcp_clients insert returned no row — should be unreachable.');
    }
    return row;
  }

  async update(id: string, data: McpClientUpdate, executor: Executor = this.db): Promise<McpClientRow | null> {
    const [row] = await executor
      .update(mcpClientsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(mcpClientsTable.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string, executor: Executor = this.db): Promise<McpClientRow | null> {
    const [row] = await executor.delete(mcpClientsTable).where(eq(mcpClientsTable.id, id)).returning();
    return row ?? null;
  }

  /**
   * Best-effort `last_used_at` stamp. Deliberately NOT awaited by the auth
   * path's critical section and deliberately not transactional: it is an
   * operational nicety for the admin listing, and failing an otherwise valid
   * MCP request because a timestamp write failed would be a self-inflicted
   * outage — the same reasoning `audit.service.ts` applies to best-effort
   * audit writes.
   */
  async touchLastUsed(id: string, executor: Executor = this.db): Promise<void> {
    await executor.update(mcpClientsTable).set({ lastUsedAt: new Date() }).where(eq(mcpClientsTable.id, id));
  }

  /* ---------------------------------------------------------------------- */
  /* Rate-limit counter — `otp_request_attempts` precedent                    */
  /* ---------------------------------------------------------------------- */

  async recordRequestAttempt(mcpClientId: string, executor: Executor = this.db): Promise<void> {
    await executor.insert(mcpRequestAttemptsTable).values({ mcpClientId });
  }

  async countRequestAttemptsSince(mcpClientId: string, since: Date, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(mcpRequestAttemptsTable)
      .where(and(eq(mcpRequestAttemptsTable.mcpClientId, mcpClientId), gte(mcpRequestAttemptsTable.createdAt, since)));
    return row?.value ?? 0;
  }
}

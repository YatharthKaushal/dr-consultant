import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  agentProfilesTable,
  type AgentProfileConfig,
  type AgentProfileRow,
} from '../../schema/agent-profiles.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface AgentProfileCreate {
  name: string;
  provider: string;
  model: string;
  baseUrl?: string | null;
  config?: AgentProfileConfig;
  priority?: number;
  isActive?: boolean;
}

export interface AgentProfileUpdate {
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string | null;
  config?: AgentProfileConfig;
  priority?: number;
  isActive?: boolean;
}

/** `agent_profiles` table CRUD. */
@Injectable()
export class AgentProfileRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<AgentProfileRow | null> {
    const [row] = await executor.select().from(agentProfilesTable).where(eq(agentProfilesTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByName(name: string, executor: Executor = this.db): Promise<AgentProfileRow | null> {
    const [row] = await executor.select().from(agentProfilesTable).where(eq(agentProfilesTable.name, name)).limit(1);
    return row ?? null;
  }

  /** Every profile, active or not, in the order rotation would try them — the admin management list. */
  async list(executor: Executor = this.db): Promise<AgentProfileRow[]> {
    return executor
      .select()
      .from(agentProfilesTable)
      .orderBy(asc(agentProfilesTable.priority), asc(agentProfilesTable.name));
  }

  async create(data: AgentProfileCreate, executor: Executor = this.db): Promise<AgentProfileRow> {
    const [row] = await executor.insert(agentProfilesTable).values(data).returning();
    if (!row) {
      throw new Error('agent_profiles insert returned no row — should be unreachable.');
    }
    return row;
  }

  /** `updated_at` is set here rather than by a DB trigger — the column has a `defaultNow()` for inserts only, same as every other table in this schema. */
  async update(id: string, data: AgentProfileUpdate, executor: Executor = this.db): Promise<AgentProfileRow | null> {
    const [row] = await executor
      .update(agentProfilesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(agentProfilesTable.id, id))
      .returning();
    return row ?? null;
  }

  /** Returns whether a row was actually deleted. `agent_credentials` rows cascade (FK `ON DELETE CASCADE`) — the decision to ALLOW that is made in `agent-profile.service.ts`, not here. */
  async deleteById(id: string, executor: Executor = this.db): Promise<boolean> {
    const deleted = await executor
      .delete(agentProfilesTable)
      .where(eq(agentProfilesTable.id, id))
      .returning({ id: agentProfilesTable.id });
    return deleted.length > 0;
  }

  /** True when at least one profile is active — the cheap half of the `isAvailable()` short-circuit, before credentials are even looked at. */
  async hasActive(executor: Executor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(agentProfilesTable)
      .where(eq(agentProfilesTable.isActive, true));
    return (row?.count ?? 0) > 0;
  }
}

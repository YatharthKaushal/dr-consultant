import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { agentCredentialsTable, type AgentCredentialRow } from '../../schema/agent-credentials.schema';
import { agentProfilesTable, type AgentProfileRow } from '../../schema/agent-profiles.schema';
import type { LlmFailureKind } from './ai.constants';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface AgentCredentialCreate {
  profileId: string;
  label: string;
  /** Already AES-256-GCM encrypted by `ai-crypto.service.ts`. This repository never sees a plaintext key. */
  encryptedKey: string;
  keyLast4: string;
  priority?: number;
  isActive?: boolean;
}

/** Admin-editable fields only. The health columns are NOT here — they are written exclusively by `recordSuccess`/`recordFailure`. */
export interface AgentCredentialUpdate {
  label?: string;
  encryptedKey?: string;
  keyLast4?: string;
  priority?: number;
  isActive?: boolean;
}

/**
 * One credential paired with the profile that owns it — what rotation needs
 * for a single attempt (the key to decrypt, plus the provider/model/base URL
 * to call). Returned pre-joined so building the candidate list is one query,
 * not one per profile.
 */
export interface RotationCandidate {
  credential: AgentCredentialRow;
  profile: AgentProfileRow;
}

/** `agent_credentials` table CRUD, plus the rotation candidate query. */
@Injectable()
export class AgentCredentialRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<AgentCredentialRow | null> {
    const [row] = await executor
      .select()
      .from(agentCredentialsTable)
      .where(eq(agentCredentialsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  /** The credential plus its profile — the credential-test endpoint needs both, and one join beats two round trips. */
  async findByIdWithProfile(id: string, executor: Executor = this.db): Promise<RotationCandidate | null> {
    const [row] = await executor
      .select({ credential: agentCredentialsTable, profile: agentProfilesTable })
      .from(agentCredentialsTable)
      .innerJoin(agentProfilesTable, eq(agentCredentialsTable.profileId, agentProfilesTable.id))
      .where(eq(agentCredentialsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByProfileAndLabel(
    profileId: string,
    label: string,
    executor: Executor = this.db,
  ): Promise<AgentCredentialRow | null> {
    const [row] = await executor
      .select()
      .from(agentCredentialsTable)
      .where(and(eq(agentCredentialsTable.profileId, profileId), eq(agentCredentialsTable.label, label)))
      .limit(1);
    return row ?? null;
  }

  /** Every credential under one profile, active or not, in rotation order — the admin per-profile list. */
  async listByProfile(profileId: string, executor: Executor = this.db): Promise<AgentCredentialRow[]> {
    return executor
      .select()
      .from(agentCredentialsTable)
      .where(eq(agentCredentialsTable.profileId, profileId))
      .orderBy(asc(agentCredentialsTable.priority), asc(agentCredentialsTable.id));
  }

  async countByProfile(profileId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(agentCredentialsTable)
      .where(eq(agentCredentialsTable.profileId, profileId));
    return row?.count ?? 0;
  }

  /**
   * Every ACTIVE credential of every ACTIVE profile, ordered
   * `(profile.priority, credential.priority, credential.id)`.
   *
   * The trailing `credential.id` is not decoration: without a total order,
   * two credentials with equal priorities come back in whatever order the
   * planner felt like, so "which key gets used" would drift between requests
   * and a failure would be unreproducible. With it, the same configuration
   * always tries the same key first.
   *
   * Deliberately does NOT filter on `cooldown_until` even though it could.
   * Skipping a cooled-down credential is a POLICY decision and policy lives
   * in `ai-rotation.service.ts` (`backend/README.md` §2 — "services hold the
   * rules; repositories hold the SQL"); putting the predicate here as well
   * would mean two places to change it and one of them silently wrong. The
   * candidate set is small — a handful of profiles times a handful of keys —
   * so filtering the tail of it in memory costs nothing measurable, and it
   * keeps the skip unit-testable against a mocked repository.
   */
  async listRotationCandidates(executor: Executor = this.db): Promise<RotationCandidate[]> {
    return executor
      .select({ credential: agentCredentialsTable, profile: agentProfilesTable })
      .from(agentCredentialsTable)
      .innerJoin(agentProfilesTable, eq(agentCredentialsTable.profileId, agentProfilesTable.id))
      .where(and(eq(agentCredentialsTable.isActive, true), eq(agentProfilesTable.isActive, true)))
      .orderBy(asc(agentProfilesTable.priority), asc(agentCredentialsTable.priority), asc(agentCredentialsTable.id));
  }

  async create(data: AgentCredentialCreate, executor: Executor = this.db): Promise<AgentCredentialRow> {
    const [row] = await executor.insert(agentCredentialsTable).values(data).returning();
    if (!row) {
      throw new Error('agent_credentials insert returned no row — should be unreachable.');
    }
    return row;
  }

  async update(
    id: string,
    data: AgentCredentialUpdate,
    executor: Executor = this.db,
  ): Promise<AgentCredentialRow | null> {
    const [row] = await executor
      .update(agentCredentialsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(agentCredentialsTable.id, id))
      .returning();
    return row ?? null;
  }

  async deleteById(id: string, executor: Executor = this.db): Promise<boolean> {
    const deleted = await executor
      .delete(agentCredentialsTable)
      .where(eq(agentCredentialsTable.id, id))
      .returning({ id: agentCredentialsTable.id });
    return deleted.length > 0;
  }

  /**
   * Health write after a successful attempt. Clears `cooldown_until` — a key
   * that just worked is by definition not cooling down, even if a stale
   * cooldown from a previous minute is still in the future.
   *
   * Note what is NOT touched: `is_active`. Nothing in this module ever writes
   * it. See `ai-rotation.service.ts`.
   */
  async recordSuccess(id: string, at: Date, executor: Executor = this.db): Promise<void> {
    await executor
      .update(agentCredentialsTable)
      .set({ consecutiveFailures: 0, lastSucceededAt: at, cooldownUntil: null, updatedAt: at })
      .where(eq(agentCredentialsTable.id, id));
  }

  /**
   * Health write after a failed attempt.
   *
   * `consecutive_failures` is incremented with a SQL expression rather than
   * read-modify-written in JS: two concurrent requests can be attempting the
   * same credential at the same time, and `SET x = x + 1` in the database is
   * the only version of this that does not lose one of them.
   *
   * `cooldownUntil` of `null` means "this failure earns no cooldown" (a
   * `transient` blip that is about to be retried), not "clear the existing
   * one" — an existing cooldown is left alone rather than being cleared by a
   * failure, which is why this is a conditional set rather than a blanket one.
   */
  async recordFailure(
    id: string,
    params: { at: Date; kind: LlmFailureKind; cooldownUntil: Date | null },
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(agentCredentialsTable)
      .set({
        consecutiveFailures: sql`${agentCredentialsTable.consecutiveFailures} + 1`,
        lastFailureAt: params.at,
        lastFailureKind: params.kind,
        ...(params.cooldownUntil ? { cooldownUntil: params.cooldownUntil } : {}),
        updatedAt: params.at,
      })
      .where(eq(agentCredentialsTable.id, id));
  }
}

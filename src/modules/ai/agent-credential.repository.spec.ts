import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../config/db/database.config';
import { agentCredentialsTable } from '../../schema/agent-credentials.schema';
import { agentProfilesTable } from '../../schema/agent-profiles.schema';
import { AgentCredentialRepository } from './agent-credential.repository';

/**
 * The rotation ORDER BY and the active-only WHERE are the two guarantees that
 * live in SQL rather than in a service, so they cannot be covered by
 * `ai-rotation.service.spec.ts` (which consumes whatever order it is given).
 * They are asserted here instead, against a stubbed query builder, by
 * comparing the arguments the repository passes with the exact drizzle
 * expressions they are supposed to be.
 *
 * Without this, "the same configuration always tries the same key first" is
 * an untested claim — and an unstable order would make a production failure
 * unreproducible.
 */
function stubDb() {
  const orderBy = jest.fn().mockResolvedValue([]);
  const where = jest.fn(() => ({ orderBy }));
  const innerJoin = jest.fn(() => ({ where }));
  const from = jest.fn(() => ({ innerJoin, where }));
  const select = jest.fn(() => ({ from }));

  const set = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));
  const update = jest.fn(() => ({ set }));

  const db = { select, update } as unknown as Database;
  return { db, select, from, innerJoin, where, orderBy, update, set };
}

describe('AgentCredentialRepository', () => {
  describe('listRotationCandidates', () => {
    it('orders by (profile.priority, credential.priority, credential.id) — the stable rotation order', () => {
      const { db, orderBy } = stubDb();

      void new AgentCredentialRepository(db).listRotationCandidates();

      expect(orderBy).toHaveBeenCalledWith(
        asc(agentProfilesTable.priority),
        asc(agentCredentialsTable.priority),
        // The tiebreak. Without it, two credentials of equal priority come
        // back in whatever order the planner chose, so "which key is tried
        // first" drifts between requests.
        asc(agentCredentialsTable.id),
      );
    });

    it('restricts to ACTIVE credentials of ACTIVE profiles, and filters on nothing else', () => {
      const { db, where } = stubDb();

      void new AgentCredentialRepository(db).listRotationCandidates();

      // Exact equality, not a partial match: it pins the filter to these two
      // predicates and NOTHING else — in particular there is deliberately no
      // `cooldown_until` predicate here. Skipping a cooled-down credential is
      // a policy decision that lives in `ai-rotation.service.ts`; duplicating
      // it in SQL would give it two homes and let one drift silently out of
      // step with the other.
      expect(where).toHaveBeenCalledTimes(1);
      expect(where).toHaveBeenCalledWith(
        and(eq(agentCredentialsTable.isActive, true), eq(agentProfilesTable.isActive, true)),
      );
    });

    it('joins the profile in, so one query serves the whole candidate list', () => {
      const { db, innerJoin } = stubDb();

      void new AgentCredentialRepository(db).listRotationCandidates();

      expect(innerJoin).toHaveBeenCalledWith(
        agentProfilesTable,
        eq(agentCredentialsTable.profileId, agentProfilesTable.id),
      );
    });

  });

  describe('listByProfile', () => {
    it('orders by (priority, id) so the admin list matches rotation order', () => {
      const { db, orderBy } = stubDb();

      void new AgentCredentialRepository(db).listByProfile('profile-1');

      expect(orderBy).toHaveBeenCalledWith(asc(agentCredentialsTable.priority), asc(agentCredentialsTable.id));
    });
  });

  describe('recordSuccess', () => {
    it('resets the failure counter, stamps the success and CLEARS any stale cooldown', async () => {
      const { db, set } = stubDb();
      const at = new Date('2026-05-01T10:00:00.000Z');

      await new AgentCredentialRepository(db).recordSuccess('credential-1', at);

      expect(set).toHaveBeenCalledWith({
        consecutiveFailures: 0,
        lastSucceededAt: at,
        cooldownUntil: null,
        updatedAt: at,
      });
    });

    it('never touches is_active', async () => {
      const { db, set } = stubDb();

      await new AgentCredentialRepository(db).recordSuccess('credential-1', new Date());

      expect((set as jest.Mock).mock.calls[0][0]).not.toHaveProperty('isActive');
    });
  });

  describe('recordFailure', () => {
    it('increments the counter with a SQL expression, not a read-modify-write', async () => {
      const { db, set } = stubDb();
      const at = new Date('2026-05-01T10:00:00.000Z');

      await new AgentCredentialRepository(db).recordFailure('credential-1', {
        at,
        kind: 'rate_limited',
        cooldownUntil: new Date('2026-05-01T10:01:00.000Z'),
      });

      const fields = (set as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      // A number here would mean two concurrent requests could lose one
      // another's increment.
      expect(typeof fields.consecutiveFailures).toBe('object');
      expect(fields.lastFailureAt).toBe(at);
      expect(fields.lastFailureKind).toBe('rate_limited');
      expect(fields.cooldownUntil).toEqual(new Date('2026-05-01T10:01:00.000Z'));
    });

    it('omits cooldownUntil when the failure earns none, leaving an existing cooldown alone', async () => {
      // `null` means "this failure adds no cooldown", NOT "clear the one
      // already there" — a failure must never shorten a cooldown.
      const { db, set } = stubDb();

      await new AgentCredentialRepository(db).recordFailure('credential-1', {
        at: new Date(),
        kind: 'transient',
        cooldownUntil: null,
      });

      expect((set as jest.Mock).mock.calls[0][0]).not.toHaveProperty('cooldownUntil');
    });

    it('never touches is_active', async () => {
      const { db, set } = stubDb();

      await new AgentCredentialRepository(db).recordFailure('credential-1', {
        at: new Date(),
        kind: 'invalid_key',
        cooldownUntil: new Date(),
      });

      expect((set as jest.Mock).mock.calls[0][0]).not.toHaveProperty('isActive');
    });
  });
});

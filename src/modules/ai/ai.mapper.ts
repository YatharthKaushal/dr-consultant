import type { AgentCredentialRow } from '../../schema/agent-credentials.schema';
import type { AgentProfileConfig, AgentProfileRow } from '../../schema/agent-profiles.schema';
import { maskedKey } from './ai-redaction.util';
import type { LlmFailureKind } from './ai.constants';

/**
 * Row -> response projections for the admin endpoints.
 *
 * These are EXPLICIT field lists, never a spread of the row. That is not
 * style: `agent_credentials.encrypted_key` must never leave this module, and
 * a `{ ...row }` mapper would leak it the moment anyone stopped reading
 * carefully. Writing every field out by hand means adding a column cannot
 * silently widen an API response — a new field is invisible until someone
 * chooses to add it here. `ai.mapper.spec.ts` asserts this directly.
 */

export interface PublicAgentProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  config: AgentProfileConfig;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicAgentProfile(row: AgentProfileRow): PublicAgentProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    config: row.config,
    priority: row.priority,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A credential as the admin panel sees it: everything needed to manage and
 * diagnose a key, and nothing that could reconstruct one.
 *
 * `encryptedKey` is absent. So is any derivative of it beyond `keyLast4`,
 * which is four characters and is what `maskedKey` renders as `****1234`.
 * There is deliberately no "reveal key" endpoint anywhere in this module: an
 * admin who needs the key already has it (they typed it in), and an admin who
 * does not should not be able to extract one from the panel.
 */
export interface PublicAgentCredential {
  id: string;
  profileId: string;
  label: string;
  /** The ONLY rendering of the key anything outside this module ever sees. */
  maskedKey: string;
  keyLast4: string;
  priority: number;
  isActive: boolean;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastFailureKind: string | null;
  cooldownUntil: Date | null;
  lastSucceededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicAgentCredential(row: AgentCredentialRow): PublicAgentCredential {
  return {
    id: row.id,
    profileId: row.profileId,
    label: row.label,
    maskedKey: maskedKey(row.keyLast4),
    keyLast4: row.keyLast4,
    priority: row.priority,
    isActive: row.isActive,
    consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt,
    lastFailureKind: row.lastFailureKind,
    cooldownUntil: row.cooldownUntil,
    lastSucceededAt: row.lastSucceededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The result of `POST /admin/ai/credentials/:id/test` — a live probe, so it
 * answers with what happened rather than throwing. A failed probe is a
 * successful REQUEST: the admin asked "does this key work", and "no, the
 * provider says the quota is exhausted" is the answer they asked for, not an
 * error in our API.
 *
 * `detail` has already been through `redactSecret()` with the key that was
 * actually used — vendor error text is not trusted to be free of key
 * material. See `ai-redaction.util.ts`.
 */
export interface CredentialTestResult {
  ok: boolean;
  /** Null on success. */
  failureKind: LlmFailureKind | null;
  /** Null on success. Redacted vendor text on failure. */
  detail: string | null;
  latencyMs: number;
  /** The credential's health columns as they stand AFTER this probe was recorded. */
  credential: PublicAgentCredential;
}

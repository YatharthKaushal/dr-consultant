import type { AgentCredentialRow } from '../../schema/agent-credentials.schema';
import type { AgentProfileRow } from '../../schema/agent-profiles.schema';
import { toPublicAgentCredential, toPublicAgentProfile } from './ai.mapper';

const PLAINTEXT_KEY = 'sk-proj-THISISTHEPLAINTEXTKEY-0000';
const CIPHERTEXT = 'v1:aXZpdmlfaXZpdg:dGFndGFndGFndGFndGFn:Y2lwaGVydGV4dGNpcGhlcnRleHQ';

function profileRow(overrides: Partial<AgentProfileRow> = {}): AgentProfileRow {
  return {
    id: 'profile-1',
    name: 'Primary OpenRouter',
    provider: 'openai_compatible',
    model: 'meta-llama/llama-3.3-70b-instruct',
    baseUrl: 'https://openrouter.ai/api/v1',
    config: { temperature: 0.1, maxTokens: 1_024, timeoutMs: 20_000 },
    priority: 10,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function credentialRow(overrides: Partial<AgentCredentialRow> = {}): AgentCredentialRow {
  return {
    id: 'credential-1',
    profileId: 'profile-1',
    label: 'production key A',
    encryptedKey: CIPHERTEXT,
    keyLast4: '0000',
    priority: 10,
    isActive: true,
    consecutiveFailures: 2,
    lastFailureAt: new Date('2026-03-01T10:00:00.000Z'),
    lastFailureKind: 'rate_limited',
    cooldownUntil: new Date('2026-03-01T10:01:00.000Z'),
    lastSucceededAt: new Date('2026-02-28T09:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('toPublicAgentProfile', () => {
  it('projects every profile field', () => {
    const row = profileRow();

    expect(toPublicAgentProfile(row)).toEqual({
      id: 'profile-1',
      name: 'Primary OpenRouter',
      provider: 'openai_compatible',
      model: 'meta-llama/llama-3.3-70b-instruct',
      baseUrl: 'https://openrouter.ai/api/v1',
      config: { temperature: 0.1, maxTokens: 1_024, timeoutMs: 20_000 },
      priority: 10,
      isActive: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it('keeps a null baseUrl null rather than inventing a default', () => {
    expect(toPublicAgentProfile(profileRow({ baseUrl: null })).baseUrl).toBeNull();
  });
});

describe('toPublicAgentCredential', () => {
  it('renders the key as ****last4 and exposes the health columns', () => {
    const row = credentialRow();

    expect(toPublicAgentCredential(row)).toEqual({
      id: 'credential-1',
      profileId: 'profile-1',
      label: 'production key A',
      maskedKey: '****0000',
      keyLast4: '0000',
      priority: 10,
      isActive: true,
      consecutiveFailures: 2,
      lastFailureAt: row.lastFailureAt,
      lastFailureKind: 'rate_limited',
      cooldownUntil: row.cooldownUntil,
      lastSucceededAt: row.lastSucceededAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it('has no encryptedKey field at all', () => {
    const result = toPublicAgentCredential(credentialRow()) as unknown as Record<string, unknown>;

    expect(result).not.toHaveProperty('encryptedKey');
    expect(Object.keys(result)).not.toContain('encryptedKey');
  });
});

/**
 * The rule this module exists to keep, asserted rather than trusted: NOTHING
 * a mapper produces may contain key material — not the plaintext, and not the
 * ciphertext either (which is useless without the master key, but is still
 * the thing an attacker with the env var needs, and has no business on an
 * admin screen).
 *
 * Serialising the whole output and searching it catches what a field-by-field
 * assertion would miss: a nested object, a field added later, a `toJSON` that
 * widens the shape. If someone adds `...row` to a mapper, this fails.
 */
describe('no plaintext or ciphertext key escapes a mapper', () => {
  const secrets = [PLAINTEXT_KEY, CIPHERTEXT, 'THISISTHEPLAINTEXTKEY'];

  it('holds for a credential projection', () => {
    const serialised = JSON.stringify(toPublicAgentCredential(credentialRow()));

    for (const secret of secrets) {
      expect(serialised).not.toContain(secret);
    }
    // The masked form IS present — that is the point.
    expect(serialised).toContain('****0000');
  });

  it('holds for a list of credentials', () => {
    const rows = [
      credentialRow({ id: 'a', encryptedKey: `${CIPHERTEXT}-a`, keyLast4: 'aaaa' }),
      credentialRow({ id: 'b', encryptedKey: `${CIPHERTEXT}-b`, keyLast4: 'bbbb' }),
    ];

    const serialised = JSON.stringify(rows.map(toPublicAgentCredential));

    expect(serialised).not.toContain(CIPHERTEXT);
    expect(serialised).toContain('****aaaa');
    expect(serialised).toContain('****bbbb');
  });

  it('holds for a profile projection (which never sees a key in the first place)', () => {
    const serialised = JSON.stringify(toPublicAgentProfile(profileRow()));

    for (const secret of secrets) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('holds even when a key-shaped string is hiding in an unrelated column', () => {
    // A `label` an admin typed carelessly. The mapper must not be the thing
    // that decides what is secret — but it must also not be surprised by it.
    const row = credentialRow({ label: 'do not paste keys here' });

    expect(JSON.stringify(toPublicAgentCredential(row))).not.toContain(CIPHERTEXT);
  });
});

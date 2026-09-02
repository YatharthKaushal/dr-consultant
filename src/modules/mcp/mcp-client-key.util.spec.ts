import { MCP_KEY_PREFIX, extractKeyPrefix, generateMcpKey, hashMcpKey, spendDecoyVerification, verifyMcpKey } from './mcp-client-key.util';

// scrypt at N=16384 is deliberately slow; a handful of derivations per test
// comfortably exceeds Jest's 5s default.
jest.setTimeout(30_000);

describe('generateMcpKey', () => {
  it('produces a recognisably-prefixed key', async () => {
    const key = await generateMcpKey();
    expect(key.plaintextKey.startsWith(MCP_KEY_PREFIX)).toBe(true);
  });

  it('produces a different key every time', async () => {
    const [a, b] = await Promise.all([generateMcpKey(), generateMcpKey()]);
    expect(a.plaintextKey).not.toBe(b.plaintextKey);
    expect(a.hashedKey).not.toBe(b.hashedKey);
  });

  it('derives keyPrefix and keyLast4 from the key itself', async () => {
    const key = await generateMcpKey();
    expect(key.plaintextKey.startsWith(key.keyPrefix)).toBe(true);
    expect(key.plaintextKey.endsWith(key.keyLast4)).toBe(true);
    expect(key.keyLast4).toHaveLength(4);
  });

  it('keeps keyPrefix within the column width', async () => {
    const key = await generateMcpKey();
    expect(key.keyPrefix.length).toBeLessThanOrEqual(16);
  });

  /* ---------------------------------------------------------------------- */
  /* The property the whole design rests on                                  */
  /* ---------------------------------------------------------------------- */

  it('NEVER stores the plaintext key in the hash', async () => {
    const key = await generateMcpKey();
    expect(key.hashedKey).not.toContain(key.plaintextKey);
    // Nor the secret half of it.
    expect(key.hashedKey).not.toContain(key.plaintextKey.slice(MCP_KEY_PREFIX.length));
  });

  it('stores a self-describing scrypt digest, not the key', async () => {
    const key = await generateMcpKey();
    expect(key.hashedKey).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('salts, so the same key hashed twice yields different digests', async () => {
    const key = await generateMcpKey();
    const again = await hashMcpKey(key.plaintextKey);
    expect(again).not.toBe(key.hashedKey);
    // ...and both still verify.
    await expect(verifyMcpKey(key.plaintextKey, again)).resolves.toBe(true);
  });
});

describe('verifyMcpKey', () => {
  it('accepts the correct key', async () => {
    const key = await generateMcpKey();
    await expect(verifyMcpKey(key.plaintextKey, key.hashedKey)).resolves.toBe(true);
  });

  it('rejects a wrong key', async () => {
    const key = await generateMcpKey();
    const other = await generateMcpKey();
    await expect(verifyMcpKey(other.plaintextKey, key.hashedKey)).resolves.toBe(false);
  });

  it('rejects a key differing in a single character', async () => {
    const key = await generateMcpKey();
    const tampered = `${key.plaintextKey.slice(0, -1)}${key.plaintextKey.endsWith('A') ? 'B' : 'A'}`;
    await expect(verifyMcpKey(tampered, key.hashedKey)).resolves.toBe(false);
  });

  it('exercises the constant-time comparison path — equal-length digests, differing content', async () => {
    const key = await generateMcpKey();
    const other = await generateMcpKey();
    // Both derive a 32-byte digest, so `timingSafeEqual` is genuinely reached
    // (it throws on unequal lengths, which would surface as an exception
    // rather than `false` if the lengths ever diverged).
    await expect(verifyMcpKey(other.plaintextKey, key.hashedKey)).resolves.toBe(false);
    await expect(verifyMcpKey(key.plaintextKey, key.hashedKey)).resolves.toBe(true);
  });

  describe('malformed stored hash — returns false, never throws', () => {
    it.each([
      ['empty string', ''],
      ['not a digest at all', 'plaintext-key-stored-by-mistake'],
      ['wrong algorithm tag', 'bcrypt$1$2$3$c2FsdA==$aGFzaA=='],
      ['too few segments', 'scrypt$16384$8$c2FsdA=='],
      ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA==$aGFzaA=='],
      ['empty salt', 'scrypt$16384$8$1$$aGFzaA=='],
      ['N of 1', 'scrypt$1$8$1$c2FsdA==$aGFzaA=='],
    ])('%s', async (_label, stored) => {
      await expect(verifyMcpKey('mcp_whatever', stored)).resolves.toBe(false);
    });
  });

  it('a corrupt row can never become an authentication bypass', async () => {
    await expect(verifyMcpKey('', '')).resolves.toBe(false);
  });
});

describe('extractKeyPrefix', () => {
  it('is pure string slicing, safe on arbitrary untrusted input', () => {
    expect(extractKeyPrefix('short')).toBe('short');
    expect(extractKeyPrefix('')).toBe('');
  });

  it('agrees with the prefix generateMcpKey stored', async () => {
    const key = await generateMcpKey();
    expect(extractKeyPrefix(key.plaintextKey)).toBe(key.keyPrefix);
  });
});

describe('spendDecoyVerification', () => {
  it('always resolves false', async () => {
    await expect(spendDecoyVerification('mcp_anything')).resolves.toBe(false);
  });

  it('actually does scrypt work, so an unknown prefix is not answered instantly', async () => {
    const started = process.hrtime.bigint();
    await spendDecoyVerification('mcp_anything');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // A no-op would be microseconds. One scrypt round at N=16384 is
    // milliseconds; 1ms is a floor loose enough not to flake on fast CI.
    expect(elapsedMs).toBeGreaterThan(1);
  });
});

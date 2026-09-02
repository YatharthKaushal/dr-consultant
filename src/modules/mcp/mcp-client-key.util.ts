import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * scrypt cost parameters. N=16384/r=8/p=1 is the widely-used interactive
 * baseline (~16 MB, low tens of milliseconds) — appropriate here because
 * verification sits on the hot path of every MCP request, unlike a password
 * hash checked once per login. The presented secret is 256 bits of CSPRNG
 * output, not a human-chosen password, so the work factor is defence against
 * a stolen-database offline attack rather than against guessing.
 *
 * `maxmem` must be set explicitly: Node's default 32 MB limit sits close
 * enough to N=16384's 128*N*r = 16 MB requirement that raising N later would
 * throw at runtime rather than fail a test.
 */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;
const SECRET_LENGTH_BYTES = 32;

/** Every key starts with this, so a leaked string is recognisable as a credential in a log or a paste. */
export const MCP_KEY_PREFIX = 'mcp_';
/** Characters of the key stored as `key_prefix` — the authentication lookup handle. */
const KEY_PREFIX_LENGTH = 12;

export interface GeneratedMcpKey {
  /** Shown to the admin exactly once, at creation. Never stored, never returned again. */
  plaintextKey: string;
  hashedKey: string;
  keyPrefix: string;
  keyLast4: string;
}

/**
 * Mints a new client key: 256 bits of CSPRNG entropy, base64url-encoded, with
 * a recognisable prefix.
 *
 * `keyPrefix` is a slice of the key itself rather than a separate random
 * value, so the client's `Authorization` header alone is enough to find the
 * row — no separate client id needs to be transmitted. It is not a secret:
 * knowing 8 characters of a 43-character random string leaves the remaining
 * 35 to guess, and the row it identifies still requires a full
 * constant-time verification against the scrypt digest.
 */
export async function generateMcpKey(): Promise<GeneratedMcpKey> {
  const plaintextKey = MCP_KEY_PREFIX + randomBytes(SECRET_LENGTH_BYTES).toString('base64url');
  return {
    plaintextKey,
    hashedKey: await hashMcpKey(plaintextKey),
    keyPrefix: extractKeyPrefix(plaintextKey),
    keyLast4: plaintextKey.slice(-4),
  };
}

/** The lookup handle for a presented key. Pure string slicing — safe to call on untrusted input. */
export function extractKeyPrefix(plaintextKey: string): string {
  return plaintextKey.slice(0, KEY_PREFIX_LENGTH);
}

/** `scrypt$N$r$p$<salt-b64>$<hash-b64>`. Self-describing so a future cost increase can be rolled out per row. */
export async function hashMcpKey(plaintextKey: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const derived = await scryptAsync(plaintextKey, salt, KEY_LENGTH_BYTES, SCRYPT_PARAMS);
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Constant-time verification. Returns `false` — never throws — for a
 * malformed stored hash or an unparsable presented key, so a corrupt row can
 * never become an authentication bypass or a 500.
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, so
 * the length is checked first; a length mismatch means the stored digest was
 * produced with a different `keylen` entirely, which is not a secret worth
 * protecting the timing of.
 */
export async function verifyMcpKey(plaintextKey: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) {
    return false;
  }

  try {
    const derived = await scryptAsync(plaintextKey, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    if (derived.length !== parsed.hash.length) {
      return false;
    }
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    // Out-of-range scrypt parameters from a corrupt row, etc.
    return false;
  }
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseStoredHash(storedHash: string): ParsedHash | null {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [string, string, string, string, string, string];
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 1 || r <= 0 || p <= 0) {
    return null;
  }
  const salt = Buffer.from(rawSalt, 'base64');
  const hash = Buffer.from(rawHash, 'base64');
  if (salt.length === 0 || hash.length === 0) {
    return null;
  }
  return { N, r, p, salt, hash };
}

/**
 * A pre-computed digest of a value nothing can present, used to spend the
 * same scrypt work on a request whose key prefix matches no row as on one
 * that does.
 *
 * Without it, "unknown prefix" returns in microseconds while "known prefix,
 * wrong key" takes a full scrypt round — turning response latency into an
 * oracle for which key prefixes are real, and letting an attacker confirm a
 * partially-leaked key. Built lazily and cached, since it is identical for
 * every call.
 */
let decoyHashPromise: Promise<string> | null = null;

export async function spendDecoyVerification(presentedKey: string): Promise<false> {
  decoyHashPromise ??= hashMcpKey(MCP_KEY_PREFIX + randomBytes(SECRET_LENGTH_BYTES).toString('base64url'));
  await verifyMcpKey(presentedKey, await decoyHashPromise);
  return false;
}

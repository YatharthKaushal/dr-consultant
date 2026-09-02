import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getEnv } from '../../config/env/env.validation';
import { lastFour } from './ai-redaction.util';

/**
 * Ciphertext format version. Prefixed to every stored value so a future
 * change of algorithm or key-derivation can be rolled out by teaching
 * `decrypt` a second version rather than by a flag day: `decrypt` dispatches
 * on this, `encrypt` always writes the current one.
 */
const FORMAT_VERSION = 'v1';

/** 96 bits — the IV size AES-GCM is specified for, and the only one where the counter construction is collision-safe without extra hashing. */
const IV_BYTES = 12;

/** 128 bits — the full GCM tag. Truncating it weakens forgery resistance for no meaningful storage saving. */
const AUTH_TAG_BYTES = 16;

const KEY_BYTES = 32;

const ALGORITHM = 'aes-256-gcm';

/**
 * The AES-256-GCM envelope around `agent_credentials.encrypted_key`.
 *
 * Stored format, four `:`-separated fields:
 *
 *     v1:<iv>:<authTag>:<ciphertext>          (each field base64url)
 *
 * Self-describing on purpose. The alternative — a bare base64 blob with the
 * IV and tag at fixed offsets — is indistinguishable from a corrupted value
 * by eye, cannot be version-checked, and turns "we changed the tag length"
 * into a silent data-loss bug. Four labelled fields cost ~5 bytes a row and
 * make a wrong value obvious in `psql`.
 *
 * GCM, not CBC: it authenticates as well as encrypts. A tampered ciphertext
 * fails the tag check and `decrypt` throws, rather than yielding plausible
 * garbage that then gets sent to a third party as an API key.
 *
 * The master key comes from `AI_CREDENTIAL_ENCRYPTION_KEY` (64 hex chars =
 * 32 bytes), validated at boot by `env.validation.ts` so a bad key fails the
 * process rather than every LLM call. It is read ONCE in the constructor: a
 * per-call `getEnv()` would be re-reading a secret on a hot path for nothing,
 * and holding it in one field makes it obvious there is exactly one place
 * that has it.
 *
 * Scope note — what this does and does not protect:
 *   - It protects against a database dump, a stolen backup, a `SELECT *` by
 *     someone with read access to Postgres but not to the application's
 *     environment, and against an admin-panel bug leaking key material,
 *     because the ciphertext is useless without the env var.
 *   - It does NOT protect against an attacker who already has the running
 *     process's environment. Nothing short of an HSM/KMS would, and that is a
 *     deliberate deferral: the client's provider account is the asset, and
 *     splitting the key custody would need infrastructure this deployment
 *     does not have.
 */
@Injectable()
export class AiCryptoService {
  private readonly masterKey: Buffer;

  constructor() {
    const { AI_CREDENTIAL_ENCRYPTION_KEY } = getEnv();
    this.masterKey = Buffer.from(AI_CREDENTIAL_ENCRYPTION_KEY, 'hex');

    // Defensive: `env.validation.ts`'s regex already guarantees 64 hex
    // characters, so this is unreachable through a normal boot. It is here
    // because a 31-byte key would otherwise surface as an opaque
    // `createCipheriv` throw on the first admin credential save, long after
    // the mistake was made.
    if (this.masterKey.length !== KEY_BYTES) {
      throw new Error(
        `AI_CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${this.masterKey.length}.`,
      );
    }
  }

  /**
   * Encrypts a plaintext provider API key. A fresh random IV per call, so the
   * same key stored twice produces two different ciphertexts and the table
   * never reveals that two profiles share a credential.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [FORMAT_VERSION, b64(iv), b64(authTag), b64(ciphertext)].join(':');
  }

  /**
   * Decrypts a stored value back to the plaintext key. Called ONLY by
   * `ai-rotation.service.ts`, immediately before an attempt, and the result
   * is never stored, logged or returned.
   *
   * Throws on a malformed value, an unknown version, a wrong master key, or a
   * tampered ciphertext (GCM tag mismatch) — every one of which means "this
   * credential cannot be used", which rotation handles by moving to the next
   * one. The thrown message deliberately says nothing about the key or the
   * ciphertext beyond what went structurally wrong.
   */
  decrypt(stored: string): string {
    const parts = stored.split(':');
    if (parts.length !== 4) {
      throw new Error('Stored credential is malformed: expected 4 colon-separated fields.');
    }

    const [version, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
    if (version !== FORMAT_VERSION) {
      throw new Error(`Stored credential has unsupported format version "${version}".`);
    }

    const iv = Buffer.from(ivPart, 'base64url');
    const authTag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');

    // `createDecipheriv`/`setAuthTag` reject wrong lengths with an opaque
    // message; checking first means a truncated row says which field is wrong.
    if (iv.length !== IV_BYTES) {
      throw new Error(`Stored credential has a ${iv.length}-byte IV, expected ${IV_BYTES}.`);
    }
    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new Error(`Stored credential has a ${authTag.length}-byte auth tag, expected ${AUTH_TAG_BYTES}.`);
    }

    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);
    // `final()` is what verifies the tag — a wrong master key or a tampered
    // ciphertext throws here, it does not return garbage.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * The only fragment of a key anything outside this module ever sees.
   * Re-exported from the util here so callers have one obvious place to get
   * both halves of "store the key" — see `agent-credential.service.ts`.
   */
  lastFour(plaintext: string): string {
    return lastFour(plaintext);
  }

  /**
   * True when `stored` round-trips to `plaintext` under the current master
   * key. Constant-time, so it cannot be used as an oracle to recover a key
   * byte-by-byte through timing. Not used on any request path — it exists for
   * the no-op-update check in `agent-credential.service.ts`, which must not
   * write (or audit) a "rotation" that re-saves the identical key.
   */
  matches(stored: string, plaintext: string): boolean {
    let decrypted: string;
    try {
      decrypted = this.decrypt(stored);
    } catch {
      return false;
    }

    const a = Buffer.from(decrypted, 'utf8');
    const b = Buffer.from(plaintext, 'utf8');
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

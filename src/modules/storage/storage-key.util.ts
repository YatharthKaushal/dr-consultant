import { BadRequestException } from '@nestjs/common';
import { STORAGE_PROVIDER_CODES, STORAGE_ERROR_CODES, type StorageProviderCode } from './storage.constants';

/**
 * Every stored object's key is self-describing: `<provider>:<category>/
 * <objectId>`, e.g. `s3:doctor-documents/3f2c...-e1.pdf` or
 * `cloudinary:patient-files/3f2c...`. This is the whole mechanism that lets
 * `StorageFacade.getSignedUrl`/`delete` route to the correct adapter with NO
 * separate "provider" parameter and no database lookup by id — the key
 * carries its own routing information, and a consuming module's schema needs
 * nothing more than the plain `text` column `patient_files.storage_key`/
 * `doctor_documents.storage_key` already are.
 *
 * The object-identifying part after `<category>/` (the `objectId`) is
 * whatever the adapter that created it chose — a UUID plus the original
 * extension for S3, a bare UUID for Cloudinary (see each adapter). This util
 * does not care what shape it takes; it only owns the `<provider>:` prefix
 * and the `<category>/` separator.
 */

export interface ParsedStorageKey {
  provider: StorageProviderCode;
  category: string;
  objectId: string;
  /** `<category>/<objectId>` — everything after the `<provider>:` prefix, unparsed. What an adapter actually needs to address the object (`StorageProviderAdapter#getSignedUrl`/`#delete`'s `objectRef`). */
  rest: string;
}

export function buildStorageKey(provider: StorageProviderCode, category: string, objectId: string): string {
  return `${provider}:${category}/${objectId}`;
}

/**
 * Parses a storage key back into its provider and adapter-addressable
 * remainder.
 *
 * Throws the same `{code: STORAGE_KEY_INVALID, message}` `BadRequestException`
 * shape every other deliberate throw in this codebase uses, rather than
 * returning `null` — every call site (`storage-rotation.service.ts#getSignedUrl`/
 * `#delete`) is a public `StorageContract` method being asked to act on a
 * SPECIFIC key a caller supplied, so a malformed key is that caller's input
 * error and a clean 400 is the right answer; forcing every call site to
 * separately null-check and construct the same exception would just spread
 * this one decision across the module.
 */
export function parseStorageKey(key: string): ParsedStorageKey {
  const colonIndex = key.indexOf(':');
  if (colonIndex <= 0) {
    throw invalidKey(key);
  }

  const provider = key.slice(0, colonIndex);
  const rest = key.slice(colonIndex + 1);
  if (!isStorageProviderCode(provider) || rest.length === 0) {
    throw invalidKey(key);
  }

  const slashIndex = rest.indexOf('/');
  if (slashIndex <= 0 || slashIndex === rest.length - 1) {
    throw invalidKey(key);
  }

  const category = rest.slice(0, slashIndex);
  const objectId = rest.slice(slashIndex + 1);
  return { provider, category, objectId, rest };
}

function invalidKey(key: string): BadRequestException {
  return new BadRequestException({
    code: STORAGE_ERROR_CODES.STORAGE_KEY_INVALID,
    message: `"${key}" is not a valid storage key.`,
  });
}

function isStorageProviderCode(value: string): value is StorageProviderCode {
  return (STORAGE_PROVIDER_CODES as readonly string[]).includes(value);
}

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { v2 as cloudinary, type UploadApiErrorResponse, type UploadApiOptions, type UploadApiResponse } from 'cloudinary';
import { getEnv } from '../../config/env/env.validation';
import { CloudinaryClassifier } from './cloudinary-storage.classifier';
import { buildStorageKey } from './storage-key.util';
import type { StorageErrorClassifier, StorageProviderAdapter, StoredObjectResult } from './storage-provider.types';
import type { StoreFileInput } from './storage.contract';

/** The slice of `storage_providers.config` this adapter reads. */
interface CloudinaryAdapterConfig {
  cloudName?: string;
}

/** Per-call Cloudinary account credentials — see the class comment on why these travel in every options object instead of via `cloudinary.config()`. */
interface CloudinaryCredentials {
  cloud_name: string;
  api_key: string;
  api_secret: string;
}

/**
 * Every object this adapter touches uses the SAME two settings, always:
 *
 *   - `resource_type: 'raw'` — Cloudinary buckets uploads into `image`/
 *     `video`/`raw`. This module offers no image-transformation features on
 *     its contract (`StorageContract` has no crop/resize/format parameter),
 *     so opting into Cloudinary's image pipeline would be depending on a
 *     capability nothing here exposes — and `raw` is also the only mode that
 *     stores the exact bytes given without Cloudinary re-encoding them,
 *     which is what a domain-agnostic "store bytes" primitive needs to
 *     guarantee. `image`/`auto` are deliberately never used.
 *   - `type: 'authenticated'` — Cloudinary's DEFAULT upload type (`'upload'`)
 *     is PUBLIC: anyone who learns the public_id can fetch the object
 *     directly from Cloudinary's CDN, no signature, no expiry, forever. That
 *     is the opposite of an S3 bucket with public access blocked (this
 *     platform's S3 posture), and would be the wrong default for patient
 *     files and doctor credential documents. `'authenticated'` makes the
 *     object UNREACHABLE without a valid signature — confirmed against
 *     Cloudinary's own docs (`control_access_to_media`) — and needs no
 *     account-level setup beyond a normal API key/secret, unlike token-based
 *     ("strict transformations") authentication, which needs a separately
 *     configured `auth_token` account secret this deployment does not have.
 */
const RESOURCE_TYPE = 'raw';
const DELIVERY_TYPE = 'authenticated';

/**
 * `cloudinary@2.11.0` — the official Node SDK.
 *
 * SIGNED URLS: THIS IS THE PART MOST LIKELY TO SURPRISE, and it did.
 * Cloudinary's access-control model is NOT a drop-in analog of S3's
 * presigned GET, for two independent reasons documented here because they
 * shaped the design:
 *
 *   1. **There are two different "signed URL" mechanisms**, and only one fits
 *      without extra account configuration. `cloudinary.url(publicId,
 *      {sign_url: true, type: 'authenticated'})` produces a URL with a
 *      SIGNATURE but NO ENFORCED EXPIRY by default — the signature proves the
 *      URL was not tampered with, but the link itself is valid indefinitely
 *      unless the Cloudinary account has "token-based authentication"
 *      enabled with a separate `auth_token` secret (an account-level feature
 *      this deployment has not set up, and setting it up is a client
 *      decision, not a code one). `utils.private_download_url(publicId,
 *      format, {expires_at, ...})`, by contrast, DOES enforce a real,
 *      server-checked expiry (default: one hour if `expires_at` is omitted;
 *      verified against Cloudinary's own support documentation) and needs
 *      only the API key/secret this deployment already has. This adapter
 *      uses `private_download_url` for exactly that reason — it is the one
 *      mechanism that is an honest match for "give me a link that stops
 *      working after N seconds."
 *   2. **`private_download_url` is not a CDN delivery URL — it is a signed
 *      request to Cloudinary's `/download` ADMIN API endpoint**, verified by
 *      reading the installed SDK's own implementation
 *      (`node_modules/cloudinary/lib/utils/index.js`): it HMAC-signs
 *      `{public_id, type, attachment, expires_at, timestamp}` with the API
 *      secret and points at `api_url('download', options)`, i.e.
 *      `https://api.cloudinary.com/v1_1/<cloud_name>/<resource_type>/
 *      download?...&signature=...`. Every fetch through it round-trips
 *      through Cloudinary's API layer and is NOT edge-cached, unlike a normal
 *      `res.cloudinary.com` delivery URL (or an S3 object served through
 *      CloudFront). For this module's use case — a signed link to hand to
 *      one caller for one download, not a public asset served at volume —
 *      that trade is the right one, but it is a real, honest difference from
 *      S3 worth stating plainly rather than papering over.
 *
 * Both signing operations (`private_download_url` for reads,
 * `sign_request`'s HMAC for the multipart calls) are computed LOCALLY, same
 * as S3's `getSignedUrl` — verified by reading the source: neither makes a
 * network call before returning.
 */
@Injectable()
export class CloudinaryStorageAdapter implements StorageProviderAdapter {
  readonly provider = 'cloudinary' as const;
  readonly classifier: StorageErrorClassifier = new CloudinaryClassifier();

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.CLOUDINARY_API_KEY) && Boolean(env.CLOUDINARY_API_SECRET);
  }

  async upload(input: StoreFileInput, config: CloudinaryAdapterConfig): Promise<StoredObjectResult> {
    const credentials = this.requireCredentials(config);
    // The extension travels as a literal part of `publicId`, not as a
    // separate Cloudinary `format`: raw-resource uploads that rely on
    // Cloudinary's own filename/format detection are documented to DROP the
    // extension unless `use_filename` is set, which brings in naming
    // behaviour this adapter does not want (collision avoidance, "unique
    // filename" suffixes). Setting `public_id` explicitly sidesteps all of
    // that — for `resource_type: 'raw'` the given public_id is stored
    // verbatim, dots included.
    const objectId = `${randomUUID()}${extensionOf(input.fileName)}`;
    const publicId = `${input.category}/${objectId}`;

    // `UploadApiOptions` carries a `[futureKey: string]: any` index signature
    // (verified in the installed SDK's own type declarations), so the
    // spread-in `cloud_name`/`api_key`/`api_secret` — not individually
    // declared fields — type-check cleanly here without a cast.
    const uploadOptions: UploadApiOptions = {
      ...credentials,
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
      public_id: publicId,
      // This deployment mints its own id (a UUID) and must never let
      // Cloudinary rename it out from under the key this module returns.
      use_filename: false,
      unique_filename: false,
      overwrite: false,
    };
    const result = await this.uploadBuffer(input.buffer, uploadOptions);

    return {
      storageKey: buildStorageKey('cloudinary', input.category, objectId),
      sizeBytes: result.bytes ?? input.buffer.byteLength,
    };
  }

  /** See the class comment — `private_download_url`, not `cloudinary.url({sign_url:true})`, is the real analog of S3's presigned GET. */
  async getSignedUrl(objectRef: string, expirySeconds: number, config: CloudinaryAdapterConfig): Promise<string> {
    const credentials = this.requireCredentials(config);
    const publicId = this.publicIdFromRef(objectRef);
    const expiresAt = Math.floor(Date.now() / 1_000) + expirySeconds;

    const options: CloudinaryCredentials & {
      resource_type: typeof RESOURCE_TYPE;
      type: typeof DELIVERY_TYPE;
      expires_at: number;
      attachment: boolean;
    } = {
      ...credentials,
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
      expires_at: expiresAt,
      // Not forced to an attachment/download disposition — matches S3's
      // presigned GET, which streams the object with whatever ContentType it
      // was uploaded with rather than forcing a browser download prompt. A
      // caller that wants a forced download applies that itself.
      attachment: false,
    };

    // `format` is intentionally '' — see the class-level note on why the
    // extension already lives inside `publicId` for a raw resource, so there
    // is no separate stored `format` for Cloudinary to match. An empty
    // string is dropped by the SDK's own `clear_blank` before signing
    // (verified against `lib/utils/index.js`), so this is equivalent to
    // omitting the parameter entirely, not signing a literal empty value.
    return cloudinary.utils.private_download_url(publicId, '', options);
  }

  async delete(objectRef: string, config: CloudinaryAdapterConfig): Promise<void> {
    const credentials = this.requireCredentials(config);
    const publicId = this.publicIdFromRef(objectRef);

    // `destroy`'s declared options type (unlike `UploadApiOptions`) has NO
    // index signature, so `cloud_name`/`api_key`/`api_secret` are typed onto
    // this variable explicitly rather than spread into a literal passed
    // directly at the call site — the same shape of fix `getSignedUrl` above
    // needed for `private_download_url`.
    const destroyOptions: CloudinaryCredentials & { resource_type: typeof RESOURCE_TYPE; type: typeof DELIVERY_TYPE } = {
      ...credentials,
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
    };

    // `uploader.destroy` resolves normally (never rejects) for an object
    // that does not exist — it returns `{ result: 'not found' }` rather than
    // throwing, per Cloudinary's own documented behaviour. Deliberately not
    // inspected here: treating "already gone" as success makes `delete()`
    // idempotent, exactly matching S3's `DeleteObject`, which is likewise
    // silent on a missing key. A REAL failure (bad credentials, network) DOES
    // reject, and is classified normally.
    await cloudinary.uploader.destroy(publicId, destroyOptions);
  }

  /** `objectRef` is `<category>/<objectId>` (`parseStorageKey`'s `rest`) — already exactly the public_id this adapter gave the object at upload time. */
  private publicIdFromRef(objectRef: string): string {
    return objectRef;
  }

  /**
   * Wraps `uploader.upload_stream` (a Node `Transform` stream taking a
   * callback, not Promise-returning — unlike `uploader.destroy`, which the
   * installed SDK's own type declarations show DOES return a `Promise`
   * directly) in a Promise, the standard pattern for this API.
   */
  private uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (error?: UploadApiErrorResponse, result?: UploadApiResponse) => {
        if (error) {
          reject(error);
          return;
        }
        if (!result) {
          reject(new Error('Cloudinary upload_stream returned neither a result nor an error.'));
          return;
        }
        resolve(result);
      });
      stream.end(buffer);
    });
  }

  /**
   * Deliberately a plain `Error`, not a `{code, message}` domain exception —
   * same reasoning as `S3StorageAdapter#requireBucket`: it is caught and
   * classified by `CloudinaryClassifier`, which does not recognise it and
   * falls through to `unknown`, correctly rotating away from and cooling
   * down a provider an admin activated without finishing its config.
   */
  private requireCredentials(config: CloudinaryAdapterConfig): CloudinaryCredentials {
    const env = getEnv();
    if (!config.cloudName) {
      throw new Error(
        'Cloudinary storage provider has no cloudName configured — set config.cloudName via PATCH /admin/storage/providers/:id.',
      );
    }
    return {
      cloud_name: config.cloudName,
      api_key: env.CLOUDINARY_API_KEY ?? '',
      api_secret: env.CLOUDINARY_API_SECRET ?? '',
    };
  }
}

function extensionOf(fileName: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(fileName);
  return match ? match[0].toLowerCase() : '';
}

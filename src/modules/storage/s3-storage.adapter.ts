import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3GetUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../../config/env/env.validation';
import { S3Classifier } from './s3-storage.classifier';
import { buildStorageKey } from './storage-key.util';
import type { StorageErrorClassifier, StorageProviderAdapter, StoredObjectResult } from './storage-provider.types';
import type { StoreFileInput } from './storage.contract';

/** The slice of `storage_providers.config` this adapter reads. `bucket` is required for a real operation; its absence is handled as a thrown error the classifier falls through to `unknown` for (see `requireBucket`), not a special code — see the class comment. */
interface S3AdapterConfig {
  bucket?: string;
  region?: string;
  endpoint?: string;
}

/**
 * `@aws-sdk/client-s3@3.1124.0` + `@aws-sdk/s3-request-presigner@3.1124.0` —
 * the official, modular AWS SDK v3. Chosen over the monolithic v2 `aws-sdk`
 * because it is what the ecosystem has moved to and what a fresh install
 * resolves cleanly with no peer-dependency friction against this repo's
 * other dependencies (verified: `npm install` added exactly these two
 * packages plus their own transitive `@aws-sdk/*`/`@smithy/*` tree, no
 * conflicts).
 */
@Injectable()
export class S3StorageAdapter implements StorageProviderAdapter {
  readonly provider = 's3' as const;
  readonly classifier: StorageErrorClassifier = new S3Classifier();

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.S3_ACCESS_KEY_ID) && Boolean(env.S3_SECRET_ACCESS_KEY);
  }

  async upload(input: StoreFileInput, config: S3AdapterConfig): Promise<StoredObjectResult> {
    const client = this.buildClient(config);
    const bucket = this.requireBucket(config);
    const objectId = `${randomUUID()}${extensionOf(input.fileName)}`;
    const key = `${input.category}/${objectId}`;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: input.buffer,
        ContentType: input.contentType,
      }),
    );

    return { storageKey: buildStorageKey('s3', input.category, objectId), sizeBytes: input.buffer.byteLength };
  }

  /**
   * `@aws-sdk/s3-request-presigner`'s `getSignedUrl` computes an HMAC
   * signature LOCALLY — it makes NO network call to S3 at all, and so it
   * cannot fail with "bucket not found" or "access denied": those would only
   * surface later, when the URL is actually fetched by whoever holds it. In
   * practice the only ways this method can throw are a missing `bucket`
   * config (`requireBucket`, below) or a malformed `objectRef`. Still async,
   * still wrapped in the same try/catch discipline as every other adapter
   * method in `storage-rotation.service.ts`, both for interface uniformity
   * and because a future SDK version or S3-compatible host behind a custom
   * `endpoint` is not guaranteed to keep that property.
   */
  async getSignedUrl(objectRef: string, expirySeconds: number, config: S3AdapterConfig): Promise<string> {
    const client = this.buildClient(config);
    const bucket = this.requireBucket(config);
    const command = new GetObjectCommand({ Bucket: bucket, Key: objectRef });
    return presignS3GetUrl(client, command, { expiresIn: expirySeconds });
  }

  async delete(objectRef: string, config: S3AdapterConfig): Promise<void> {
    const client = this.buildClient(config);
    const bucket = this.requireBucket(config);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectRef }));
  }

  /**
   * Built fresh on EVERY call from the config object passed in, never cached
   * on this instance. `S3StorageAdapter` is a singleton Nest provider (one
   * instance for the process lifetime), so caching a client here would mean
   * an admin editing the bucket/region via `PATCH /admin/storage/providers/
   * :id` would not take effect until a restart. Constructing an `S3Client` is
   * a cheap, local, no-I/O operation (it does not open a connection — the
   * underlying HTTP handler connects lazily per request), so there is no
   * warm-connection cost to lose by rebuilding it every time. See the
   * matching note on `storage-rotation.service.ts`.
   */
  private buildClient(config: S3AdapterConfig): S3Client {
    const env = getEnv();
    return new S3Client({
      region: config.region ?? 'us-east-1',
      endpoint: config.endpoint,
      // A custom `endpoint` means an S3-COMPATIBLE host (Cloudflare R2, MinIO,
      // a self-hosted gateway) rather than AWS itself, and those almost
      // always need path-style addressing (`endpoint/bucket/key`) rather than
      // virtual-hosted-style (`bucket.endpoint/key`). Real AWS S3 accepts
      // either, so forcing it only when `endpoint` is set is safe both ways.
      forcePathStyle: Boolean(config.endpoint),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
  }

  /**
   * Deliberately a plain `Error`, not a `{code, message}` domain exception:
   * this is thrown from deep inside an adapter method, caught by
   * `storage-rotation.service.ts`, and run through `this.classifier.classify`
   * exactly like a real SDK error would be. It matches nothing in
   * `S3Classifier`'s known-name/status tables, so it falls through to
   * `unknown` — which rotates away from this misconfigured provider and cools
   * it down, precisely the right behaviour for "an admin activated this
   * provider without finishing its config." No special-casing needed.
   */
  private requireBucket(config: S3AdapterConfig): string {
    if (!config.bucket) {
      throw new Error('S3 storage provider has no bucket configured — set config.bucket via PATCH /admin/storage/providers/:id.');
    }
    return config.bucket;
  }
}

function extensionOf(fileName: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(fileName);
  return match ? match[0].toLowerCase() : '';
}

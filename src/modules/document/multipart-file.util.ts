import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Transport-level error codes this util raises. Named constants rather than
 * inline string literals, so both consuming modules (and their tests) can
 * refer to them without retyping the string.
 *
 * Deliberately NOT folded into `DOCUMENT_ERROR_CODES`: these describe
 * MULTIPART TRANSPORT failures (no file part, unreadable stream, wrong
 * content type), not anything about documents. This util is domain-free and
 * is consumed by `modules/doctor` as well — codes owned by one domain module
 * would be the wrong home for a failure neither domain caused.
 */
export const MULTIPART_ERROR_CODES = {
  /** 400. The request parsed, but carried no file part at all. */
  NO_FILE: 'MULTIPART_NO_FILE',
  /** 413. Over the transport hard ceiling — `main.ts`'s `limits.fileSize`, busboy aborts the stream. */
  FILE_TOO_LARGE: 'MULTIPART_FILE_TOO_LARGE',
  /** 400. The request was not `multipart/form-data`. */
  CONTENT_TYPE_INVALID: 'MULTIPART_CONTENT_TYPE_INVALID',
  /** 400. Anything else the plugin threw while reading the stream. */
  PARSE_FAILED: 'MULTIPART_PARSE_FAILED',
} as const;

/** One parsed multipart request: the file part plus every accompanying form field. */
export interface ParsedMultipartFile {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Every non-file field on the request, coerced to `string`. A repeated field name keeps only its first value. */
  fields: Record<string, string>;
}

/**
 * Reads exactly ONE file part, plus every accompanying form field, from a
 * Fastify multipart (`multipart/form-data`) request. Requires `@fastify/
 * multipart` to already be registered on the adapter (`main.ts`).
 *
 * Deliberately generic — nothing here depends on any DTO shape from this
 * module. It lives in `modules/document` because this module needed it
 * first, not because the utility is document-specific, and it now has TWO
 * callers: `document.controller.ts`'s `POST /documents` (patient uploads)
 * and `doctor.controller.ts`'s `POST /doctors/me/documents` (a doctor's own
 * credential documents). The latter is the M-05 retrofit this comment used
 * to describe as future work: `doctor.dto.ts` previously carried a
 * `CreateDoctorDocumentDto.storageKey` that trusted any caller-supplied
 * string as a real object-store key, and that trust hole was closed by
 * routing the doctor's upload through a real `StorageFacade.store()` call,
 * using this same helper to read the file off the wire. `backend/README.md`
 * §4's "grow by feature keeping the domain prefix" is about where a module's
 * OWN tables/routes live, not about a small stateless utility with no
 * `document`-owned data in it.
 *
 * Field-reading order: `data.fields` is read AFTER `toBuffer()` resolves,
 * never before. Per `@fastify/multipart`'s own README, busboy parses a
 * multipart body as one serial stream — a field placed AFTER the file part
 * in the request body is only visible once the file part has been fully
 * consumed. Reading fields first would silently drop any field a client
 * happens to place after the file input in its `FormData`, which no caller
 * of this function controls.
 */
export async function parseSingleFileRequest(request: FastifyRequest): Promise<ParsedMultipartFile> {
  const file = await callMultipart(() => request.file());

  if (!file) {
    throw new BadRequestException({ code: MULTIPART_ERROR_CODES.NO_FILE, message: 'No file was uploaded.' });
  }

  const buffer = await callMultipart(() => file.toBuffer());

  /*
   * *** DO NOT REMOVE — @fastify/multipart's own size-limit check RACES. ***
   *
   * `limits.fileSize` (registered in `main.ts`) is supposed to make
   * `toBuffer()` throw `FST_REQ_FILE_TOO_LARGE` on an over-ceiling upload.
   * It usually does. It does not always.
   *
   * Read the plugin's own `toBuffer()` (`node_modules/@fastify/multipart/
   * index.js`): the check lives INSIDE the chunk loop —
   *
   *     for await (const chunk of this.file) {
   *       fileChunks.push(chunk)
   *       if (throwFileSizeLimit && this.file.truncated) { ...throw... }
   *     }
   *
   * — so it only fires if busboy emits ANOTHER chunk after it has set
   * `truncated`. When the stream ends on the very chunk that trips the limit,
   * the loop exits, no error is ever constructed, and `Buffer.concat` returns
   * a SILENTLY TRUNCATED buffer that looks completely normal to the caller.
   *
   * This was caught live, not theorised: the identical 26MB upload against
   * `POST /doctors/me/documents` returned 413 on one run and 201 Created on
   * the next. On the 201 run the platform stored a truncated file and told
   * the doctor their credential document had uploaded successfully.
   *
   * `modules/document`'s patient path happened to be shielded from this by
   * its own lower business-rule cap (`documents.max_file_size_mb`, 15MB — a
   * buffer truncated at the 25MB transport ceiling still trips it), but that
   * is accidental protection, not a rule, and it does not extend to any
   * caller without a business cap below the ceiling.
   *
   * Re-reading the flag here closes the race deterministically for EVERY
   * caller of this util, at the transport layer where it belongs.
   */
  if (file.file?.truncated) {
    throw new PayloadTooLargeException({
      code: MULTIPART_ERROR_CODES.FILE_TOO_LARGE,
      message: 'The uploaded file is too large.',
    });
  }

  const fields: Record<string, string> = {};
  for (const [key, entryOrList] of Object.entries(file.fields)) {
    const entry = Array.isArray(entryOrList) ? entryOrList[0] : entryOrList;
    if (entry && entry.type === 'field' && !(key in fields)) {
      fields[key] = String(entry.value);
    }
  }

  return {
    buffer,
    fileName: file.filename,
    contentType: file.mimetype,
    sizeBytes: buffer.length,
    fields,
  };
}

/**
 * Runs a `@fastify/multipart` call and translates its raw, non-`HttpException`
 * plugin errors (`@fastify/error`-created, carrying a `code`/`statusCode` but
 * NOT an `HttpException`) into this codebase's `{ code, message }` shape —
 * otherwise they would fall through `HttpExceptionFilter`'s branch 4 as a
 * generic, unhelpful 500. `FST_REQ_FILE_TOO_LARGE` is the one a real caller
 * actually hits: a file over the transport hard ceiling (`main.ts`'s
 * `limits.fileSize`, see `document.constants.ts`'s `DOCUMENT_UPLOAD_HARD_
 * CEILING_BYTES`) throws here; a file under that ceiling but over the
 * business-rule cap succeeds here and is rejected later, by the caller, with
 * `DOCUMENT_ERROR_CODES.FILE_TOO_LARGE`.
 */
async function callMultipart<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;

    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
      throw new PayloadTooLargeException({ code: MULTIPART_ERROR_CODES.FILE_TOO_LARGE, message: 'The uploaded file is too large.' });
    }
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      throw new BadRequestException({ code: MULTIPART_ERROR_CODES.CONTENT_TYPE_INVALID, message: 'Request must be multipart/form-data.' });
    }
    if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
      throw error;
    }
    throw new BadRequestException({ code: MULTIPART_ERROR_CODES.PARSE_FAILED, message: 'Could not read the uploaded file.' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

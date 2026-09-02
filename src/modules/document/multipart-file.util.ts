import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

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
 * module. It lives in `modules/document` today because this module needed
 * it first, not because the utility is document-specific: a LATER pass
 * reuses this exact function for `modules/doctor`'s own document-upload
 * retrofit (see `doctor.dto.ts`'s `CreateDoctorDocumentDto.storageKey`
 * comment — that trust hole is closed by routing the doctor's own upload
 * through a real storage call, using this same helper to read the file off
 * the wire). `backend/README.md` §4's "grow by feature keeping the domain
 * prefix" is about where a module's OWN tables/routes live, not about a
 * small stateless utility with no `document`-owned data in it.
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
    throw new BadRequestException({ code: 'MULTIPART_NO_FILE', message: 'No file was uploaded.' });
  }

  const buffer = await callMultipart(() => file.toBuffer());

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
      throw new PayloadTooLargeException({ code: 'MULTIPART_FILE_TOO_LARGE', message: 'The uploaded file is too large.' });
    }
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      throw new BadRequestException({ code: 'MULTIPART_CONTENT_TYPE_INVALID', message: 'Request must be multipart/form-data.' });
    }
    if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
      throw error;
    }
    throw new BadRequestException({ code: 'MULTIPART_PARSE_FAILED', message: 'Could not read the uploaded file.' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

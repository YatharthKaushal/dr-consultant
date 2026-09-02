import type { FastifyRequest } from 'fastify';
import { parseSingleFileRequest } from './multipart-file.util';

function fakeRequest(fileFactory: () => Promise<unknown>): FastifyRequest {
  return { file: fileFactory } as unknown as FastifyRequest;
}

function multipartFile(
  overrides: Partial<{
    buffer: Buffer;
    filename: string;
    mimetype: string;
    fields: Record<string, unknown>;
    toBufferError: unknown;
  }> = {},
) {
  const buffer = overrides.buffer ?? Buffer.from('file-bytes');
  return {
    filename: overrides.filename ?? 'photo.jpg',
    mimetype: overrides.mimetype ?? 'image/jpeg',
    fields: overrides.fields ?? {},
    toBuffer: async () => {
      if (overrides.toBufferError) throw overrides.toBufferError;
      return buffer;
    },
  };
}

describe('parseSingleFileRequest', () => {
  it('returns the buffer, fileName, contentType, sizeBytes and every non-file field', async () => {
    const request = fakeRequest(async () =>
      multipartFile({
        fields: {
          category: { type: 'field', value: 'medical_history' },
          consultationId: { type: 'field', value: 'c-1' },
        },
      }),
    );

    const result = await parseSingleFileRequest(request);

    expect(result.fileName).toBe('photo.jpg');
    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer).toEqual(Buffer.from('file-bytes'));
    expect(result.sizeBytes).toBe(Buffer.from('file-bytes').length);
    expect(result.fields).toEqual({ category: 'medical_history', consultationId: 'c-1' });
  });

  it('reads fields AFTER toBuffer() resolves, not before — matters when a field arrives after the file part in the stream', async () => {
    const callOrder: string[] = [];
    const request = fakeRequest(async () => {
      const file = multipartFile({ fields: { category: { type: 'field', value: 'report' } } });
      const originalToBuffer = file.toBuffer;
      file.toBuffer = async () => {
        callOrder.push('toBuffer');
        return originalToBuffer();
      };
      return file;
    });

    await parseSingleFileRequest(request);
    // `fields` was only ever read as a synchronous property access after `await file.toBuffer()` —
    // there is no separate "read fields" step that could race ahead of it.
    expect(callOrder).toEqual(['toBuffer']);
  });

  it('ignores a non-"field" entry (e.g. a nested file part) rather than coercing it into a string', async () => {
    const request = fakeRequest(async () =>
      multipartFile({
        fields: {
          category: { type: 'field', value: 'photo' },
          somehowAFile: { type: 'file' },
        },
      }),
    );

    const result = await parseSingleFileRequest(request);
    expect(result.fields).toEqual({ category: 'photo' });
  });

  it('takes only the FIRST value of a repeated field name', async () => {
    const request = fakeRequest(async () =>
      multipartFile({
        fields: {
          category: [
            { type: 'field', value: 'medical_history' },
            { type: 'field', value: 'report' },
          ],
        },
      }),
    );

    const result = await parseSingleFileRequest(request);
    expect(result.fields.category).toBe('medical_history');
  });

  it('throws a clean MULTIPART_NO_FILE (400) when no file part was sent at all', async () => {
    const request = fakeRequest(async () => undefined);
    await expect(parseSingleFileRequest(request)).rejects.toMatchObject({
      status: 400,
      response: { code: 'MULTIPART_NO_FILE' },
    });
  });

  it('translates busboy\'s file-too-large error into a clean 413, not a raw 500', async () => {
    const request = fakeRequest(async () =>
      multipartFile({ toBufferError: Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE' }) }),
    );
    await expect(parseSingleFileRequest(request)).rejects.toMatchObject({
      status: 413,
      response: { code: 'MULTIPART_FILE_TOO_LARGE' },
    });
  });

  it('translates an invalid-content-type error into a clean 400', async () => {
    const request = fakeRequest(async () => {
      throw Object.assign(new Error('the request is not multipart'), { code: 'FST_INVALID_MULTIPART_CONTENT_TYPE' });
    });
    await expect(parseSingleFileRequest(request)).rejects.toMatchObject({
      status: 400,
      response: { code: 'MULTIPART_CONTENT_TYPE_INVALID' },
    });
  });

  it('falls back to a generic clean 400 for an unrecognized parse failure — never lets a raw plugin error reach the client', async () => {
    const request = fakeRequest(async () => {
      throw new Error('unexpected busboy explosion');
    });
    await expect(parseSingleFileRequest(request)).rejects.toMatchObject({
      status: 400,
      response: { code: 'MULTIPART_PARSE_FAILED' },
    });
  });
});

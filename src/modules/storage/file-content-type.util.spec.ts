import { sniffMimeType, verifyDeclaredContentType } from './file-content-type.util';

/* -------------------------------------------------------------------------- */
/* Fixtures — real magic bytes, not placeholders                               */
/* -------------------------------------------------------------------------- */

/** A buffer starting with `signature`, padded out with filler so it is a realistic length rather than exactly the signature. */
function fileStartingWith(signature: number[], totalLength = 64): Buffer {
  const buffer = Buffer.alloc(totalLength, 0x00);
  Buffer.from(signature).copy(buffer, 0);
  return buffer;
}

const JPEG = fileStartingWith([0xff, 0xd8, 0xff, 0xe0]);
const PNG = fileStartingWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = fileStartingWith([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7

/** RIFF....WEBP — the size field at bytes 4-7 is deliberately arbitrary, exactly as in a real file. */
function webp(): Buffer {
  const buffer = Buffer.alloc(64, 0x00);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(56, 4);
  buffer.write('WEBP', 8, 'latin1');
  return buffer;
}

/** An ISO-BMFF header: a 4-byte box size, then "ftyp" at offset 4, then the brand at offset 8. */
function isoBmff(brand: string): Buffer {
  const buffer = Buffer.alloc(64, 0x00);
  buffer.writeUInt32BE(0x18, 0);
  buffer.write('ftyp', 4, 'latin1');
  buffer.write(brand, 8, 'latin1');
  return buffer;
}

/* -------------------------------------------------------------------------- */

describe('sniffMimeType', () => {
  it('recognises JPEG', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
  });

  it('recognises PNG, including the CRLF/EOF bytes of the 8-byte signature', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
  });

  it('recognises PDF', () => {
    expect(sniffMimeType(PDF)).toBe('application/pdf');
  });

  it('recognises WEBP', () => {
    expect(sniffMimeType(webp())).toBe('image/webp');
  });

  it('does NOT accept a bare RIFF container that is not WEBP — AVI and WAV share the prefix', () => {
    const avi = Buffer.alloc(64, 0x00);
    avi.write('RIFF', 0, 'latin1');
    avi.write('AVI ', 8, 'latin1');

    expect(sniffMimeType(avi)).toBeNull();
  });

  describe('HEIC/HEIF — the offset-based one', () => {
    it.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'])(
      'recognises ISO-BMFF brand %s',
      (brand) => {
        expect(sniffMimeType(isoBmff(brand))).toBe('image/heic');
      },
    );

    it('reads "ftyp" at offset 4, NOT offset 0 — the first four bytes are the box size and vary per file', () => {
      const small = isoBmff('heic');
      small.writeUInt32BE(0x18, 0);
      const large = isoBmff('heic');
      large.writeUInt32BE(0x7ffff0, 0); // a completely different size field

      expect(sniffMimeType(small)).toBe('image/heic');
      expect(sniffMimeType(large)).toBe('image/heic');
    });

    it('rejects an ISO-BMFF file whose brand is not a HEIF-family still image (e.g. an MP4)', () => {
      expect(sniffMimeType(isoBmff('isom'))).toBeNull();
      expect(sniffMimeType(isoBmff('mp42'))).toBeNull();
    });
  });

  describe('unrecognised and degenerate input — never throws', () => {
    it('returns null for an empty buffer', () => {
      expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
    });

    it('returns null for a buffer shorter than any signature', () => {
      expect(sniffMimeType(Buffer.from([0xff]))).toBeNull();
    });

    it('returns null for a truncated JPEG-ish prefix that does not complete the signature', () => {
      expect(sniffMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
    });

    it('returns null for a ZIP (the classic "renamed to .jpg" payload)', () => {
      expect(sniffMimeType(fileStartingWith([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    });

    it('returns null for an ELF executable', () => {
      expect(sniffMimeType(fileStartingWith([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
    });

    it('returns null for plain text / HTML', () => {
      expect(sniffMimeType(Buffer.from('<!DOCTYPE html><html><body>hi</body></html>', 'utf8'))).toBeNull();
    });
  });
});

describe('verifyDeclaredContentType', () => {
  describe('truthful declarations pass and return the verified type', () => {
    it.each([
      [JPEG, 'image/jpeg'],
      [PNG, 'image/png'],
      [PDF, 'application/pdf'],
      [webp(), 'image/webp'],
    ])('accepts %#: bytes matching their declared type', (buffer, declared) => {
      expect(verifyDeclaredContentType(buffer as Buffer, declared as string)).toBe(declared);
    });

    it('is case- and whitespace-insensitive about the declared string', () => {
      expect(verifyDeclaredContentType(PDF, '  APPLICATION/PDF  ')).toBe('application/pdf');
    });
  });

  describe('the HEIF equivalence class — both spellings describe the same container', () => {
    it('accepts HEIC bytes declared as image/heic', () => {
      expect(verifyDeclaredContentType(isoBmff('heic'), 'image/heic')).toBe('image/heic');
    });

    it('accepts HEIC bytes declared as image/heif — a real iOS upload path, and an exact-match check would falsely reject it', () => {
      expect(verifyDeclaredContentType(isoBmff('heic'), 'image/heif')).toBe('image/heif');
    });

    it('accepts the generic mif1 brand under either spelling', () => {
      expect(verifyDeclaredContentType(isoBmff('mif1'), 'image/heic')).toBe('image/heic');
      expect(verifyDeclaredContentType(isoBmff('mif1'), 'image/heif')).toBe('image/heif');
    });
  });

  describe('lying declarations are rejected — the whole point of this util', () => {
    it('rejects a ZIP declared as image/jpeg', () => {
      expect(verifyDeclaredContentType(fileStartingWith([0x50, 0x4b, 0x03, 0x04]), 'image/jpeg')).toBeNull();
    });

    it('rejects an ELF executable declared as application/pdf', () => {
      expect(verifyDeclaredContentType(fileStartingWith([0x7f, 0x45, 0x4c, 0x46]), 'application/pdf')).toBeNull();
    });

    it('rejects HTML declared as image/png', () => {
      expect(verifyDeclaredContentType(Buffer.from('<html></html>', 'utf8'), 'image/png')).toBeNull();
    });

    it('rejects PNG bytes declared as image/jpeg — the declared type must be TRUTHFUL, not merely allowlisted', () => {
      expect(verifyDeclaredContentType(PNG, 'image/jpeg')).toBeNull();
    });

    it('rejects a PDF declared as an image (the profile_photo attack shape)', () => {
      expect(verifyDeclaredContentType(PDF, 'image/jpeg')).toBeNull();
    });

    it('rejects an image declared as a PDF', () => {
      expect(verifyDeclaredContentType(JPEG, 'application/pdf')).toBeNull();
    });

    it('rejects a non-HEIF ISO-BMFF (e.g. MP4 video) declared as image/heic', () => {
      expect(verifyDeclaredContentType(isoBmff('isom'), 'image/heic')).toBeNull();
    });

    it('rejects an empty buffer whatever it claims to be', () => {
      expect(verifyDeclaredContentType(Buffer.alloc(0), 'image/jpeg')).toBeNull();
    });
  });
});

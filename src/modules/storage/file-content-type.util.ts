/**
 * MAGIC-BYTE CONTENT SNIFFING — what a file's BYTES actually are, as opposed
 * to what its uploader CLAIMED they are.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A multipart part's `Content-Type` is attacker-controlled: `@fastify/
 * multipart` reports whatever header the client wrote for that part
 * (`multipart-file.util.ts` surfaces it as `contentType`), and nothing about
 * it is verified. Before this util, both upload paths — a patient's medical
 * files (`patient-file.service.ts`) and a doctor's credential documents
 * (`doctor-document.service.ts`) — checked ONLY that declared string against
 * their allowlist. A client could therefore upload arbitrary bytes (an
 * executable, an HTML page, a zip) simply by declaring `image/jpeg`, and the
 * platform would store it, hand it to the object store with that MIME type,
 * and later serve it back to a DOCTOR through a signed URL under a
 * content type the object store now asserts. That is a malware-distribution
 * path through a healthcare product's own document viewer.
 *
 * ── Why hand-rolled rather than a library ──────────────────────────────────
 *
 * The obvious candidate (`file-type`) is ESM-only in its current versions,
 * and this project compiles to CommonJS through the Nest/webpack pipeline —
 * a real integration risk for a marginal gain. The allowlists in this
 * codebase span exactly FIVE formats, every one of which has a short,
 * well-documented signature. A pure function over a `Buffer` is fully
 * unit-testable against byte fixtures, adds no dependency, and is far easier
 * to audit than a general-purpose format detector.
 *
 * ── The boundary this file sits on ─────────────────────────────────────────
 *
 * This is FACT EXTRACTION, not POLICY, which is exactly why it lives in
 * `modules/storage` rather than in either consuming domain module. "What are
 * these bytes?" is domain-agnostic infrastructure — the same question for a
 * patient's blood report and a doctor's degree certificate — and
 * `modules/storage` is already the domain-agnostic layer both consumers
 * depend on. The POLICY — which types are acceptable for a `medical_history`
 * versus a `profile_photo`, which error code to raise, what the caller is
 * told — stays in each domain module, where it already lives
 * (`DOCUMENT_MIME_ALLOWLIST`, `DOCTOR_DOCUMENT_MIME_ALLOWLIST`). Nothing
 * domain-shaped moves in here: this file names no patient, no doctor and no
 * category, and it never throws — a caller decides what a `null` means for
 * its own use case.
 */

/**
 * Canonical MIME strings this util can return. Deliberately exactly the set
 * the two allowlists actually permit — a sniffer that recognised more formats
 * than either path accepts would be dead code with a maintenance cost.
 */
const MIME_JPEG = 'image/jpeg';
const MIME_PNG = 'image/png';
const MIME_WEBP = 'image/webp';
const MIME_PDF = 'application/pdf';
const MIME_HEIC = 'image/heic';

/**
 * `image/heic` and `image/heif` are ONE equivalence class here, and this is
 * the single most important subtlety in this file.
 *
 * Both strings are on the existing allowlist, and both describe the SAME
 * on-disk container (ISO base media file format carrying HEVC-coded images).
 * The bytes genuinely cannot tell you which of the two spellings the client
 * "should" have written — iOS reports either depending on OS version and
 * upload path, which is exactly why `document.constants.ts` lists both in the
 * first place. Comparing a sniffed canonical `image/heic` for exact string
 * equality against a declared `image/heif` would therefore reject a
 * perfectly legitimate iPhone photo. Treating the pair as interchangeable is
 * not a loosening of the check: the container is verified either way, and
 * only the label differs.
 */
const HEIF_FAMILY_MIME_TYPES: readonly string[] = [MIME_HEIC, 'image/heif'];

/**
 * ISO-BMFF brands that mean "this is a HEIF-family still image". `heic`/
 * `heix` are the common Apple stills, `hevc`/`hevx` the image-sequence
 * variants, `heim`/`heis`/`hevm`/`hevs` their scalable counterparts, and
 * `mif1`/`msf1` the generic HEIF brands some encoders emit. Kept generous on
 * purpose: an unrecognised brand means a FALSE REJECTION of a real photo,
 * which is a worse failure here than the marginal strictness gained.
 */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/** Byte-for-byte comparison at a fixed offset, bounds-checked — a buffer shorter than the signature simply does not match, and never reads past the end. */
function matchesAt(buffer: Buffer, offset: number, signature: readonly number[]): boolean {
  if (buffer.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[offset + index] !== signature[index]) return false;
  }
  return true;
}

/**
 * The canonical MIME type these bytes actually are, or `null` when they match
 * none of the five formats this platform accepts.
 *
 * Never throws — a truncated, empty or garbage buffer is simply `null`.
 */
export function sniffMimeType(buffer: Buffer): string | null {
  // JPEG: SOI marker (FF D8) followed by the start of the next marker (FF).
  if (matchesAt(buffer, 0, [0xff, 0xd8, 0xff])) return MIME_JPEG;

  // PNG: the 8-byte signature, including the CRLF/EOF bytes that exist
  // specifically to detect corruption by naive text-mode transfers.
  if (matchesAt(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return MIME_PNG;

  // PDF: "%PDF".
  if (matchesAt(buffer, 0, [0x25, 0x50, 0x44, 0x46])) return MIME_PDF;

  // WEBP: a RIFF container whose form-type is WEBP. BOTH halves are required
  // — "RIFF" alone at offset 0 is shared with AVI and WAV, so checking only
  // the container prefix would happily accept a video or a sound file as an
  // image.
  if (matchesAt(buffer, 0, [0x52, 0x49, 0x46, 0x46]) && matchesAt(buffer, 8, [0x57, 0x45, 0x42, 0x50])) {
    return MIME_WEBP;
  }

  // HEIC/HEIF: THE ONE THAT IS NOT A BYTE-0 SIGNATURE. An ISO base media
  // file starts with a box, whose first four bytes are that box's SIZE (a
  // big-endian length that varies per file) and whose next four are its TYPE.
  // So the recognisable marker "ftyp" sits at offset 4, never at 0, and the
  // brand that says WHICH ISO-BMFF dialect this is sits at offset 8. Reading
  // this format like the others — expecting a fixed prefix at byte 0 — is the
  // classic way to get HEIC detection wrong.
  if (matchesAt(buffer, 4, [0x66, 0x74, 0x79, 0x70]) && buffer.length >= 12) {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (HEIF_BRANDS.has(brand)) return MIME_HEIC;
  }

  return null;
}

function isHeifFamily(mimeType: string): boolean {
  return HEIF_FAMILY_MIME_TYPES.includes(mimeType);
}

/**
 * The VERIFIED content type a caller should store, or `null` when the bytes
 * are unrecognised OR contradict what the caller declared.
 *
 * Deliberately STRICTER than "is the real type allowed": the declared type
 * must be TRUTHFUL, not merely allowlisted. PNG bytes declared as
 * `image/jpeg` return `null` even though both types are individually
 * acceptable everywhere in this codebase — a client with no reason to
 * mislabel a file is not inconvenienced, and one that does mislabel is
 * exactly the case this check exists for.
 *
 * Returns the type to actually persist and hand to `StorageContract.store`,
 * so the object store ends up serving back a content type this server
 * CONFIRMED rather than one a client asserted. For the HEIF family (see
 * `HEIF_FAMILY_MIME_TYPES`) the caller's own spelling is returned, since
 * neither `image/heic` nor `image/heif` is more correct than the other and
 * echoing the client's choice keeps the stored value stable.
 *
 * NEVER THROWS, and deliberately returns no reason for the failure: callers
 * must answer a mismatch with the SAME error they already use for a
 * disallowed declared type. Reporting "you said JPEG but these bytes are a
 * PDF" would turn the upload endpoint into an oracle an attacker can probe
 * to learn exactly what the server thinks arbitrary bytes are.
 */
export function verifyDeclaredContentType(buffer: Buffer, declaredMimeType: string): string | null {
  const declared = declaredMimeType.trim().toLowerCase();
  const sniffed = sniffMimeType(buffer);

  if (sniffed === null) return null;
  if (sniffed === declared) return sniffed;
  if (isHeifFamily(sniffed) && isHeifFamily(declared)) return declared;

  return null;
}

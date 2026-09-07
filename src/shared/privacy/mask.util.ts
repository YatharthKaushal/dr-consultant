/**
 * Masking for a soft-deleted account's identity, read by someone who isn't
 * that account or an admin — a doctor's case history, a booking display, a
 * governance queue row. "Show masked details only" (initials for a name,
 * first-two/last-two for a number) rather than the real value, and never
 * the raw `null` a naive read of a nulled-out column would otherwise show
 * (this codebase's soft delete deliberately keeps the real values in
 * storage — see `patients.schema.ts#deletedAt`'s header — masking is a READ-TIME
 * transform, not a second destructive write).
 */

/**
 * `'Yatharth Sharma'` -> `'Y…h S…a'`. First and last character of each
 * word, joined by an ellipsis; a 1-2 character word becomes `'X…'` (nothing
 * left to show a "last" character of without re-identifying a short name).
 * `null`/empty stays `null`/empty — there is nothing to mask.
 */
export function maskFullName(fullName: string | null): string | null {
  if (!fullName) return fullName;
  return fullName
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 2) return `${word[0]}…`;
      return `${word[0]}…${word[word.length - 1]}`;
    })
    .join(' ');
}

/**
 * `'+919876543210'` -> `'+91••••••••10'`. Keeps the first two and last two
 * digits (after an optional leading `+`), masks everything between with
 * `•`. A number too short to have a meaningful middle (≤4 digits) masks
 * entirely. `null`/empty stays `null`/empty.
 */
export function maskMobileNumber(mobileNumber: string | null): string | null {
  if (!mobileNumber) return mobileNumber;
  const plus = mobileNumber.startsWith('+') ? '+' : '';
  const digits = plus ? mobileNumber.slice(1) : mobileNumber;

  if (digits.length <= 4) return `${plus}${'•'.repeat(digits.length)}`;

  const head = digits.slice(0, 2);
  const tail = digits.slice(-2);
  const middle = '•'.repeat(digits.length - 4);
  return `${plus}${head}${middle}${tail}`;
}

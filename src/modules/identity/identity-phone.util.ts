import { parsePhoneNumberWithError } from 'libphonenumber-js';

/**
 * Normalizes user-entered input to E.164 (e.g. "9876543210" ->
 * "+919876543210") — the format every `mobile_number` column and Slide's
 * `identifier` field expect. `@IsPhoneNumber('IN')` on the DTOs already
 * validates the input is a plausible number before this ever runs; this is
 * the step that actually canonicalizes it, since two different valid
 * spellings of the same number must resolve to the same DB row.
 *
 * Defaults to India ('IN') when the input carries no explicit country code —
 * the only market this release serves (SRS 1.1: "for the Indian market").
 */
export function normalizeMobileNumber(raw: string): string {
  return parsePhoneNumberWithError(raw, 'IN').number;
}

import { parsePhoneNumberWithError } from 'libphonenumber-js';

/**
 * Deliberately duplicated from `identity/identity-phone.util.ts` rather than
 * deep-imported (`backend/README.md`: "no deep imports" across module
 * folders). It must normalize identically to identity's copy: this module
 * creates `doctors` rows (admin `POST /admin/doctors`), and identity's OTP
 * sign-in flow later looks that row up by the exact same normalized
 * `mobile_number` string — a divergent normalization here would silently
 * break sign-in for every doctor this module creates. If a third module ever
 * needs this, it should move to `shared/` instead of being copied a third
 * time.
 */
export function normalizeMobileNumber(raw: string): string {
  return parsePhoneNumberWithError(raw, 'IN').number;
}

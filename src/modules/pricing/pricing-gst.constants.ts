/**
 * *** GST STATE CODES, AND A NON-AUTHORITATIVE PINCODE HINT. ***
 *
 * ── WHY THIS IS COMPILED IN AND NOT ADMIN-EDITABLE ─────────────────────────
 *
 * Every other number in this module lives in `app_config` so the client can
 * change it without a release. This one deliberately does not.
 *
 * A GST state code is not a preference, it is an identifier defined by the GST
 * portal and printed on a statutory invoice. An admin who invents code `99`,
 * or who "corrects" Telangana from 36 to 28, produces an invoice that is
 * INVALID — and it would be invalid silently, on every bill, until a return was
 * rejected months later. There is no version of that failure that is better
 * than a release.
 *
 * The same argument does not apply to the RATE (18%) or the component catalogue,
 * which are commercial and tax-treatment decisions the client's CA genuinely
 * owns. Those are configurable. This is not.
 *
 * ── *** REQUIRES THE CLIENT'S CA TO CONFIRM. *** ───────────────────────────
 *
 * PUBLIC SOURCES DISAGREE ON SOME OF THESE CODES, and the disagreements are not
 * typos — they are real historical changes that different sources have caught up
 * with to different degrees:
 *
 *   25  Daman and Diu — the standalone UT was MERGED into Dadra and Nagar Haveli
 *       and Daman and Diu with effect from 26 January 2020. Many published lists
 *       still show 25 as live. It is retained below as `merged` so an old
 *       invoice remains explicable, and is NOT selectable.
 *   26  Dadra and Nagar Haveli and Daman and Diu — the post-merger UT. Some
 *       lists still label 26 as "Dadra and Nagar Haveli" alone.
 *   28  Andhra Pradesh (before bifurcation). Telangana took 36 and the new
 *       Andhra Pradesh took 37. 28 is dead but appears in older lists.
 *   38  Ladakh — created in 2019 and missing from any list older than that.
 *   97  Other Territory, and 99 Centre Jurisdiction. Both are real GSTIN
 *       prefixes and NEITHER is a valid place of supply for a B2C online
 *       service, so both are non-selectable here.
 *
 * The list below is taken from the GST portal's own state-code table. It is
 * still a developer's reading of it, and SRS §8 is explicit that "GST wording,
 * tax treatment and invoice structure must be confirmed with the client's CA or
 * legal advisor before launch". THIS TABLE IS PART OF THAT REVIEW. It is not tax
 * advice.
 */

/**
 * Whether a code may be chosen as a place of supply today.
 *
 *   `active`          a live state or UT; selectable.
 *   `merged`          absorbed into another UT; kept so historical invoices
 *                     remain explicable, never selectable.
 *   `obsolete`        superseded by a bifurcation; same treatment.
 *   `not_a_place`     a real GSTIN prefix that is not a recipient state.
 */
export type GstStateCodeStatus = 'active' | 'merged' | 'obsolete' | 'not_a_place';

export interface GstStateCode {
  /** Two digits, zero-padded — `char(2)` in `price_quotes.place_of_supply_state_code`. */
  code: string;
  name: string;
  status: GstStateCodeStatus;
  /** Present only where a code is contested or historical; surfaced to whoever reviews this with the CA. */
  note?: string;
}

/** The GST portal's state-code table. Ordered by code, which is also how a picker should show it. */
export const GST_STATE_CODES: readonly GstStateCode[] = [
  { code: '01', name: 'Jammu and Kashmir', status: 'active' },
  { code: '02', name: 'Himachal Pradesh', status: 'active' },
  { code: '03', name: 'Punjab', status: 'active' },
  { code: '04', name: 'Chandigarh', status: 'active' },
  { code: '05', name: 'Uttarakhand', status: 'active' },
  { code: '06', name: 'Haryana', status: 'active' },
  { code: '07', name: 'Delhi', status: 'active' },
  { code: '08', name: 'Rajasthan', status: 'active' },
  { code: '09', name: 'Uttar Pradesh', status: 'active' },
  { code: '10', name: 'Bihar', status: 'active' },
  { code: '11', name: 'Sikkim', status: 'active' },
  { code: '12', name: 'Arunachal Pradesh', status: 'active' },
  { code: '13', name: 'Nagaland', status: 'active' },
  { code: '14', name: 'Manipur', status: 'active' },
  { code: '15', name: 'Mizoram', status: 'active' },
  { code: '16', name: 'Tripura', status: 'active' },
  { code: '17', name: 'Meghalaya', status: 'active' },
  { code: '18', name: 'Assam', status: 'active' },
  { code: '19', name: 'West Bengal', status: 'active' },
  { code: '20', name: 'Jharkhand', status: 'active' },
  { code: '21', name: 'Odisha', status: 'active' },
  { code: '22', name: 'Chhattisgarh', status: 'active' },
  { code: '23', name: 'Madhya Pradesh', status: 'active' },
  { code: '24', name: 'Gujarat', status: 'active' },
  {
    code: '25',
    name: 'Daman and Diu',
    status: 'merged',
    note: 'Merged into 26 (Dadra and Nagar Haveli and Daman and Diu) on 26 Jan 2020. Kept for historical invoices only.',
  },
  {
    code: '26',
    name: 'Dadra and Nagar Haveli and Daman and Diu',
    status: 'active',
    note: 'Post-merger UT. Older published lists still label 26 as "Dadra and Nagar Haveli" alone.',
  },
  { code: '27', name: 'Maharashtra', status: 'active' },
  {
    code: '28',
    name: 'Andhra Pradesh (before bifurcation)',
    status: 'obsolete',
    note: 'Superseded by 37 (Andhra Pradesh) and 36 (Telangana). Still present in older published lists.',
  },
  { code: '29', name: 'Karnataka', status: 'active' },
  { code: '30', name: 'Goa', status: 'active' },
  { code: '31', name: 'Lakshadweep', status: 'active' },
  { code: '32', name: 'Kerala', status: 'active' },
  { code: '33', name: 'Tamil Nadu', status: 'active' },
  { code: '34', name: 'Puducherry', status: 'active' },
  { code: '35', name: 'Andaman and Nicobar Islands', status: 'active' },
  { code: '36', name: 'Telangana', status: 'active' },
  { code: '37', name: 'Andhra Pradesh', status: 'active' },
  { code: '38', name: 'Ladakh', status: 'active', note: 'Created 2019; absent from any list older than that.' },
  {
    code: '97',
    name: 'Other Territory',
    status: 'not_a_place',
    note: 'A real GSTIN prefix, not a recipient state. Never a place of supply for a B2C online service.',
  },
  {
    code: '99',
    name: 'Centre Jurisdiction',
    status: 'not_a_place',
    note: 'A real GSTIN prefix, not a recipient state. This is the code an admin would most plausibly invent.',
  },
];

const BY_CODE: ReadonlyMap<string, GstStateCode> = new Map(GST_STATE_CODES.map((entry) => [entry.code, entry]));

/** The codes a patient or an admin may actually choose. Excludes merged, obsolete and non-place codes. */
export const SELECTABLE_GST_STATE_CODES: readonly GstStateCode[] = GST_STATE_CODES.filter(
  (entry) => entry.status === 'active',
);

/** Looks a code up, including the historical ones — an old invoice must still render its state name. */
export function findGstStateCode(code: string): GstStateCode | null {
  return BY_CODE.get(code) ?? null;
}

/** True only for a code that may be written as a place of supply today. */
export function isSelectableGstStateCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.get(code)?.status === 'active';
}

/**
 * True for any code the GST portal has ever issued, live or historical. Used
 * when READING a snapshotted quote, which may legitimately carry a code that
 * has since been merged away.
 */
export function isKnownGstStateCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}

/* -------------------------------------------------------------------------- */
/* Pincode -> state. A SUGGESTION, NEVER AN AUTHORITY.                         */
/* -------------------------------------------------------------------------- */

/**
 * *** THIS IS A UI CONVENIENCE AND MUST NEVER DECIDE A TAX. ***
 *
 * `price_quotes.place_of_supply_pincode`'s own schema comment says it: "Optional,
 * and only ever a convenience for pre-selecting the state. The state code is
 * authoritative." The DTO therefore REQUIRES `stateCode` and merely RECORDS
 * `pincode`; nothing in the engine reads a pincode.
 *
 * The mapping below is by the first two digits of the PIN, which is the postal
 * circle. That is close to a state boundary but not identical to one: several
 * circles straddle a border, a few states share a leading pair, and India Post
 * reorganises ranges without reference to the GST portal. Using it to CHOOSE a
 * tax would produce a wrong CGST/SGST-versus-IGST call on a real bill, which is
 * both a refund and a return to amend.
 *
 * So: use it to pre-select a dropdown the patient can override. Nothing more.
 * `suggestStateCodeForPincode` returning `null` is a normal outcome, not a bug.
 */
const PINCODE_PREFIX_TO_STATE: Readonly<Record<string, string>> = {
  11: '07', // Delhi
  12: '06', // Haryana
  13: '06', // Haryana
  14: '03', // Punjab
  15: '03', // Punjab
  16: '03', // Punjab — 160xxx is Chandigarh (04); see the override below.
  17: '02', // Himachal Pradesh
  18: '01', // Jammu and Kashmir
  19: '01', // Jammu and Kashmir
  20: '09', // Uttar Pradesh
  21: '09',
  22: '09',
  23: '09',
  24: '09',
  25: '09',
  26: '09',
  27: '09',
  28: '09',
  30: '08', // Rajasthan
  31: '08',
  32: '08',
  33: '08',
  34: '08',
  36: '24', // Gujarat
  37: '24',
  38: '24',
  39: '24',
  40: '27', // Maharashtra
  41: '27',
  42: '27',
  43: '27',
  44: '27',
  45: '23', // Madhya Pradesh
  46: '23',
  47: '23',
  48: '23',
  49: '22', // Chhattisgarh
  50: '36', // Telangana
  51: '37', // Andhra Pradesh
  52: '37',
  53: '37',
  56: '29', // Karnataka
  57: '29',
  58: '29',
  59: '29',
  60: '33', // Tamil Nadu
  61: '33',
  62: '33',
  63: '33',
  64: '33',
  67: '32', // Kerala
  68: '32',
  69: '32',
  70: '19', // West Bengal
  71: '19',
  72: '19',
  73: '19',
  74: '19',
  75: '21', // Odisha
  76: '21',
  77: '21',
  78: '18', // Assam
  79: '12', // Arunachal Pradesh — 79 also covers parts of the north-east; low confidence.
  80: '10', // Bihar
  81: '10',
  82: '20', // Jharkhand
  83: '20',
  84: '10', // Bihar
  85: '10',
};

/** PINs that are not the state their prefix implies. Chandigarh is the common one. */
const PINCODE_EXACT_OVERRIDES: Readonly<Record<string, string>> = {
  160: '04', // Chandigarh, inside Punjab's 16 prefix.
  140: '03',
  744: '35', // Andaman and Nicobar Islands.
  737: '11', // Sikkim.
  795: '14', // Manipur.
  796: '15', // Mizoram.
  797: '13', // Nagaland.
  798: '13',
  799: '16', // Tripura.
  793: '17', // Meghalaya.
  794: '17',
  682: '32', // Kerala (Lakshadweep is administered from 682555 but is state 31).
};

/**
 * A BEST-EFFORT state code for a 6-digit PIN, or `null`.
 *
 * Non-authoritative by construction — see the block comment above. The caller
 * offers this as a pre-selection and the patient confirms or overrides it; the
 * confirmed `stateCode` is what is stored and what decides the tax.
 */
export function suggestStateCodeForPincode(pincode: string): string | null {
  if (!/^\d{6}$/.test(pincode)) return null;

  const exact = PINCODE_EXACT_OVERRIDES[pincode.slice(0, 3)];
  if (exact !== undefined) return exact;

  const prefixed = PINCODE_PREFIX_TO_STATE[pincode.slice(0, 2)];
  return prefixed ?? null;
}

/**
 * The GST state-code table and the pincode hint.
 *
 * *** THESE TESTS PIN INTENT, NOT TAX ADVICE. *** They assert that the table
 * behaves the way `pricing-gst.constants.ts` says it does — historical codes
 * resolvable but not selectable, non-place codes never selectable, the pincode
 * mapping explicitly non-authoritative. Whether the codes themselves are right
 * is a question for the client's CA, which that file flags at length.
 */

import {
  findGstStateCode,
  GST_STATE_CODES,
  isKnownGstStateCode,
  isSelectableGstStateCode,
  SELECTABLE_GST_STATE_CODES,
  suggestStateCodeForPincode,
} from './pricing-gst.constants';

describe('GST state codes', () => {
  it('has a unique, two-digit code for every entry', () => {
    const codes = GST_STATE_CODES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^\d{2}$/);
    }
  });

  /**
   * *** THE CODE AN ADMIN WOULD MOST PLAUSIBLY INVENT. *** 99 (Centre
   * Jurisdiction) and 97 (Other Territory) are real GSTIN prefixes and neither
   * is a recipient state for a B2C online service.
   */
  it('never lets 97 or 99 be chosen as a place of supply', () => {
    expect(isSelectableGstStateCode('97')).toBe(false);
    expect(isSelectableGstStateCode('99')).toBe(false);
    // ...but both are still resolvable, so an existing GSTIN prefix has a name.
    expect(isKnownGstStateCode('99')).toBe(true);
    expect(findGstStateCode('99')?.name).toBe('Centre Jurisdiction');
  });

  /**
   * Merged and obsolete codes must still RENDER — an invoice issued before the
   * 2020 merger has to keep showing its state name — while never being
   * selectable again.
   */
  it('resolves a merged or obsolete code without offering it', () => {
    expect(isKnownGstStateCode('25')).toBe(true); // Daman and Diu, merged 2020
    expect(isSelectableGstStateCode('25')).toBe(false);
    expect(findGstStateCode('25')?.status).toBe('merged');

    expect(isKnownGstStateCode('28')).toBe(true); // Andhra Pradesh, pre-bifurcation
    expect(isSelectableGstStateCode('28')).toBe(false);
    expect(findGstStateCode('28')?.status).toBe('obsolete');
  });

  /** Every contested or historical code carries a note for whoever reviews this with the CA. */
  it('annotates every non-active code with the reason', () => {
    for (const entry of GST_STATE_CODES) {
      if (entry.status !== 'active') {
        expect(entry.note).toBeDefined();
      }
    }
  });

  it('offers only active codes for selection', () => {
    expect(SELECTABLE_GST_STATE_CODES.every((entry) => entry.status === 'active')).toBe(true);
    expect(SELECTABLE_GST_STATE_CODES.some((entry) => entry.code === '27')).toBe(true); // Maharashtra
    expect(SELECTABLE_GST_STATE_CODES.some((entry) => entry.code === '36')).toBe(true); // Telangana
    expect(SELECTABLE_GST_STATE_CODES.some((entry) => entry.code === '38')).toBe(true); // Ladakh, created 2019
  });

  it('rejects a code that was never issued', () => {
    expect(isKnownGstStateCode('75')).toBe(false);
    expect(isSelectableGstStateCode('00')).toBe(false);
    expect(findGstStateCode('75')).toBeNull();
  });
});

describe('pincode -> state, as a SUGGESTION only', () => {
  it('suggests a plausible state for a well-known PIN', () => {
    expect(suggestStateCodeForPincode('110001')).toBe('07'); // New Delhi
    expect(suggestStateCodeForPincode('400001')).toBe('27'); // Mumbai
    expect(suggestStateCodeForPincode('560001')).toBe('29'); // Bengaluru
    expect(suggestStateCodeForPincode('700001')).toBe('19'); // Kolkata
  });

  /** Chandigarh sits inside Punjab's 16 prefix — the kind of exception that makes the table non-authoritative. */
  it('applies the exact-prefix overrides', () => {
    expect(suggestStateCodeForPincode('160017')).toBe('04'); // Chandigarh, not Punjab
    expect(suggestStateCodeForPincode('744101')).toBe('35'); // Andaman and Nicobar
  });

  /** `null` is a normal answer, not a bug — the caller falls back to asking. */
  it('returns null rather than guessing for an unmapped or malformed PIN', () => {
    expect(suggestStateCodeForPincode('999999')).toBeNull();
    expect(suggestStateCodeForPincode('12345')).toBeNull();
    expect(suggestStateCodeForPincode('abcdef')).toBeNull();
    expect(suggestStateCodeForPincode('')).toBeNull();
  });

  /** Every suggestion it does make must at least be a code that can be selected. */
  it('only ever suggests a currently-selectable code', () => {
    for (let prefix = 100000; prefix < 900000; prefix += 1000) {
      const suggestion = suggestStateCodeForPincode(String(prefix));
      if (suggestion !== null) {
        expect(isSelectableGstStateCode(suggestion)).toBe(true);
      }
    }
  });
});

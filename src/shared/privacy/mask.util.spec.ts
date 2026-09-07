import { maskFullName, maskMobileNumber } from './mask.util';

describe('maskFullName', () => {
  it('masks each word to its first and last character', () => {
    expect(maskFullName('Yatharth Sharma')).toBe('Y…h S…a');
  });

  it('masks a single-word name', () => {
    expect(maskFullName('Priya')).toBe('P…a');
  });

  it('a 1-2 character word becomes "X…" — nothing left to show a distinct last character', () => {
    expect(maskFullName('Jo')).toBe('J…');
    expect(maskFullName('A')).toBe('A…');
  });

  it('passes through null/empty unchanged', () => {
    expect(maskFullName(null)).toBeNull();
    expect(maskFullName('')).toBe('');
  });

  it('collapses extra whitespace between words', () => {
    expect(maskFullName('  Yatharth   Sharma  ')).toBe('Y…h S…a');
  });
});

describe('maskMobileNumber', () => {
  it('keeps the first two and last two digits, masks the middle', () => {
    expect(maskMobileNumber('+919876543210')).toBe('+91••••••••10');
  });

  it('works without a leading +', () => {
    expect(maskMobileNumber('919876543210')).toBe('91••••••••10');
  });

  it('masks entirely when too short to have a meaningful middle', () => {
    expect(maskMobileNumber('+1234')).toBe('+••••');
  });

  it('passes through null/empty unchanged', () => {
    expect(maskMobileNumber(null)).toBeNull();
    expect(maskMobileNumber('')).toBe('');
  });

  it('never leaks more than 4 real digits total for a real-length number', () => {
    const masked = maskMobileNumber('+919876543210');
    const realDigits = (masked?.match(/\d/g) ?? []).length;
    expect(realDigits).toBe(4);
  });
});

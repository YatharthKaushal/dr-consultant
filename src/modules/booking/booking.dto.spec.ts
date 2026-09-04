import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BookingQuoteQueryDto, CreateBookingDto } from './booking.dto';

/**
 * *** THE BUG THIS SUITE CLOSES. ***
 *
 * `CreateBookingDto` had no `discountCode` field. `main.ts`'s global
 * `ValidationPipe({ whitelist: true })` therefore stripped a `discountCode` a
 * client sent — SILENTLY, with no validation error — and the patient was
 * charged the undiscounted amount and told nothing (`app.e2e.integration.spec.ts`'s
 * former "FINDING" test pinned exactly this).
 *
 * `whitelist: true` only strips a property that is NOT decorated on the DTO
 * class at all; it does not itself validate. So the fix has two parts, both
 * covered here: the field must EXIST on the class (so it survives whitelist
 * stripping), and it must be VALIDATED against something narrower than "any
 * string" (so garbage does not reach the pricing/discount port).
 */

const VALID_DOCTOR_ID = '11111111-1111-4111-8111-111111111111';
const VALID_SPECIALTY_ID = '22222222-2222-4222-8222-222222222222';

function baseBookingPayload(overrides: Record<string, unknown> = {}) {
  return {
    doctorId: VALID_DOCTOR_ID,
    specialtyId: VALID_SPECIALTY_ID,
    scheduledStartAt: '2026-03-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('CreateBookingDto.discountCode', () => {
  it('accepts a well-formed code and does not strip it', async () => {
    const dto = plainToInstance(CreateBookingDto, baseBookingPayload({ discountCode: 'SAVE20' }));
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    // The field must actually SURVIVE onto the instance — this is what
    // `whitelist: true` would otherwise strip if the class had no such
    // property at all.
    expect(dto.discountCode).toBe('SAVE20');
  });

  it('is optional — a booking with no code validates clean', async () => {
    const dto = plainToInstance(CreateBookingDto, baseBookingPayload());
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.discountCode).toBeUndefined();
  });

  it('accepts the punctuation a patient might actually type: spaces, dashes, lower case', async () => {
    for (const code of ['save-me', 'SAVE ME', 'save_me', 'Ref7k2m9qx']) {
      const dto = plainToInstance(CreateBookingDto, baseBookingPayload({ discountCode: code }));
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects garbage that could not possibly be a code', async () => {
    for (const code of ['<script>alert(1)</script>', 'a'.repeat(200), '!!!', '']) {
      const dto = plainToInstance(CreateBookingDto, baseBookingPayload({ discountCode: code }));
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'discountCode')).toBe(true);
    }
  });

  it('rejects a non-string value rather than coercing it', async () => {
    const dto = plainToInstance(CreateBookingDto, baseBookingPayload({ discountCode: 12345 }));
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'discountCode')).toBe(true);
  });
});

describe('BookingQuoteQueryDto.code', () => {
  it('accepts a well-formed code', async () => {
    const dto = plainToInstance(BookingQuoteQueryDto, { code: 'SAVE20' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('is optional', async () => {
    const dto = plainToInstance(BookingQuoteQueryDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.code).toBeUndefined();
  });

  it('rejects garbage', async () => {
    const dto = plainToInstance(BookingQuoteQueryDto, { code: '<script>' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'code')).toBe(true);
  });
});

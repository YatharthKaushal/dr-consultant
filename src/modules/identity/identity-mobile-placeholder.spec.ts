import { anonymizedMobilePlaceholder } from './identity.repository';

describe('anonymizedMobilePlaceholder', () => {
  it('is exactly 16 characters — the varchar(16) width of mobile_number on every account table', () => {
    expect(anonymizedMobilePlaceholder('11111111-2222-3333-4444-555555555555')).toHaveLength(16);
  });

  it('never starts with "+", so it can never collide with a real E.164 number', () => {
    expect(anonymizedMobilePlaceholder('11111111-2222-3333-4444-555555555555').startsWith('+')).toBe(false);
  });

  it('is deterministic — the same id always produces the same placeholder, so a retried anonymization is a no-op', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(anonymizedMobilePlaceholder(id)).toBe(anonymizedMobilePlaceholder(id));
  });

  it('differs for different ids', () => {
    expect(anonymizedMobilePlaceholder('11111111-2222-3333-4444-555555555555')).not.toBe(
      anonymizedMobilePlaceholder('99999999-8888-7777-6666-555555555555'),
    );
  });
});

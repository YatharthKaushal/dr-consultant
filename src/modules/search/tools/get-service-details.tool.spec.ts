import { NotFoundException } from '@nestjs/common';
import type { DoctorToolAdapter } from './doctor-tool.adapter';
import { GetServiceDetailsTool, collectLanguages, computeFeeRange } from './get-service-details.tool';
import { doctor, mockCataloguePort, specialty } from './search-tool.test-fixtures';

const SPECIALTY_ID = '11111111-1111-4111-8111-111111111111';

/** `DoctorToolAdapter` is injected as a class (it carries `isAvailable`), so the mock mirrors just those two methods. */
function mockDoctorAdapter(available = true) {
  return {
    isAvailable: jest.fn().mockReturnValue(available),
    listListedDoctors: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DoctorToolAdapter>;
}

describe('computeFeeRange', () => {
  it('is null for zero doctors — no range exists, which is not the same as a range of zero', () => {
    expect(computeFeeRange([])).toBeNull();
  });

  it('reports the same value as min and max for exactly one doctor', () => {
    expect(computeFeeRange([{ consultationFeeInr: '1500.00' }])).toEqual({ min: '1500.00', max: '1500.00' });
  });

  it('spans the lowest and highest fee across many doctors', () => {
    const range = computeFeeRange([{ consultationFeeInr: '1500.00' }, { consultationFeeInr: '800.00' }, { consultationFeeInr: '2400.50' }]);
    expect(range).toEqual({ min: '800.00', max: '2400.50' });
  });

  it('compares numerically, not lexicographically', () => {
    // '900' > '1500' as strings; the range must still be 900..1500.
    expect(computeFeeRange([{ consultationFeeInr: '900' }, { consultationFeeInr: '1500' }])).toEqual({ min: '900', max: '1500' });
  });

  it('returns the fee strings exactly as stored, without reformatting', () => {
    expect(computeFeeRange([{ consultationFeeInr: '1500.00' }])).toEqual({ min: '1500.00', max: '1500.00' });
  });

  it('skips a malformed fee rather than letting NaN erase the range', () => {
    expect(computeFeeRange([{ consultationFeeInr: 'not-a-number' }, { consultationFeeInr: '1200' }])).toEqual({ min: '1200', max: '1200' });
  });

  it('is null when every fee is malformed', () => {
    expect(computeFeeRange([{ consultationFeeInr: 'oops' }])).toBeNull();
  });
});

describe('collectLanguages', () => {
  it('is empty for no doctors', () => {
    expect(collectLanguages([])).toEqual([]);
  });

  it('deduplicates and sorts across doctors', () => {
    expect(collectLanguages([{ languages: ['Hindi', 'English'] }, { languages: ['English', 'Tamil'] }])).toEqual(['English', 'Hindi', 'Tamil']);
  });
});

describe('GetServiceDetailsTool', () => {
  it('resolves a specialty by id and reports its directory aggregates', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);
    const doctors = mockDoctorAdapter();
    doctors.listListedDoctors.mockResolvedValue([
      doctor({ id: 'd-1', consultationFeeInr: '1500.00', languages: ['English', 'Hindi'] }),
      doctor({ id: 'd-2', consultationFeeInr: '900.00', languages: ['Hindi'] }),
    ]);

    const result = await new GetServiceDetailsTool(catalogue, doctors).execute({ specialtyId: SPECIALTY_ID });

    expect(result.specialty).toEqual({ id: SPECIALTY_ID, code: 'psychiatry', name: 'Psychiatry', description: 'Medical treatment of mental health conditions.', canPrescribe: true });
    expect(result.directory).toEqual({
      doctorCount: 2,
      feeRangeInr: { min: '900.00', max: '1500.00' },
      languages: ['English', 'Hindi'],
    });
    expect(doctors.listListedDoctors).toHaveBeenCalledWith({ specialtyId: SPECIALTY_ID });
  });

  it('resolves a specialty by code', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID, code: 'psychiatry' })]);

    const result = await new GetServiceDetailsTool(catalogue, mockDoctorAdapter()).execute({ specialtyCode: 'psychiatry' });

    expect(result.specialty.id).toBe(SPECIALTY_ID);
  });

  it('reports doctorCount 0 and a null fee range when the specialty has no listed doctors', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);
    const doctors = mockDoctorAdapter();
    doctors.listListedDoctors.mockResolvedValue([]);

    const result = await new GetServiceDetailsTool(catalogue, doctors).execute({ specialtyId: SPECIALTY_ID });

    expect(result.directory).toEqual({ doctorCount: 0, feeRangeInr: null, languages: [] });
  });

  it('reports a single-value range for exactly one doctor', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);
    const doctors = mockDoctorAdapter();
    doctors.listListedDoctors.mockResolvedValue([doctor({ consultationFeeInr: '1200.00', languages: ['Tamil'] })]);

    const result = await new GetServiceDetailsTool(catalogue, doctors).execute({ specialtyId: SPECIALTY_ID });

    expect(result.directory).toEqual({ doctorCount: 1, feeRangeInr: { min: '1200.00', max: '1200.00' }, languages: ['Tamil'] });
  });

  it('throws SPECIALTY_NOT_FOUND for an id that matches no active specialty', async () => {
    const catalogue = mockCataloguePort();
    catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);

    await expect(new GetServiceDetailsTool(catalogue, mockDoctorAdapter()).execute({ specialtyId: '99999999-9999-4999-8999-999999999999' })).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('when the doctor directory cannot be read', () => {
    it('still returns the real specialty facts, with a null directory', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);
      const doctors = mockDoctorAdapter(false);

      const result = await new GetServiceDetailsTool(catalogue, doctors).execute({ specialtyId: SPECIALTY_ID });

      expect(result.specialty.name).toBe('Psychiatry');
      expect(result.directory).toBeNull();
    });

    it('never fabricates a zero count — null means "cannot look up", 0 means "nobody offers this"', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);

      const result = await new GetServiceDetailsTool(catalogue, mockDoctorAdapter(false)).execute({ specialtyId: SPECIALTY_ID });

      expect(result.directory).not.toEqual({ doctorCount: 0, feeRangeInr: null, languages: [] });
    });

    it('does not query the directory at all', async () => {
      const catalogue = mockCataloguePort();
      catalogue.listActiveSpecialties.mockResolvedValue([specialty({ id: SPECIALTY_ID })]);
      const doctors = mockDoctorAdapter(false);

      await new GetServiceDetailsTool(catalogue, doctors).execute({ specialtyId: SPECIALTY_ID });

      expect(doctors.listListedDoctors).not.toHaveBeenCalled();
    });
  });
});

import { ListDoctorsTool } from './list-doctors.tool';
import { DEFAULT_TOOL_RESULT_LIMIT, MAX_TOOL_RESULT_LIMIT } from './search-tool.constants';
import { doctor, mockDoctorPort } from './search-tool.test-fixtures';

const SPECIALTY_ID = '11111111-1111-4111-8111-111111111111';

describe('ListDoctorsTool', () => {
  it('returns the doctor listing projection', async () => {
    const doctors = mockDoctorPort();
    doctors.listListedDoctors.mockResolvedValue([doctor({ id: 'd-1', fullName: 'Dr Asha Rao' })]);

    const result = await new ListDoctorsTool(doctors).execute({});

    expect(result.doctors).toHaveLength(1);
    expect(result.doctors[0]).toMatchObject({
      id: 'd-1',
      fullName: 'Dr Asha Rao',
      languages: ['English', 'Hindi'],
      consultationFeeInr: '1500.00',
      consultationDurationMinutes: 30,
    });
  });

  it('returns an empty list when nothing matches the filters', async () => {
    const doctors = mockDoctorPort();
    doctors.listListedDoctors.mockResolvedValue([]);

    await expect(new ListDoctorsTool(doctors).execute({ language: 'Tamil' })).resolves.toEqual({ doctors: [] });
  });

  it('passes every filter straight through to the directory — no interpretation, no ranking', async () => {
    const doctors = mockDoctorPort();
    doctors.listListedDoctors.mockResolvedValue([]);

    await new ListDoctorsTool(doctors).execute({ specialtyId: SPECIALTY_ID, language: 'Hindi', maxFeeInr: 1000, limit: 5 });

    expect(doctors.listListedDoctors).toHaveBeenCalledWith({ specialtyId: SPECIALTY_ID, language: 'Hindi', maxFeeInr: 1000, limit: 5 });
  });

  it('applies the default limit when none is given', async () => {
    const doctors = mockDoctorPort();
    doctors.listListedDoctors.mockResolvedValue([]);

    await new ListDoctorsTool(doctors).execute({});

    expect(doctors.listListedDoctors).toHaveBeenCalledWith(expect.objectContaining({ limit: DEFAULT_TOOL_RESULT_LIMIT }));
  });

  it('preserves the directory order it was given — the listing is never re-sorted here', async () => {
    const doctors = mockDoctorPort();
    doctors.listListedDoctors.mockResolvedValue([doctor({ id: 'd-3' }), doctor({ id: 'd-1' }), doctor({ id: 'd-2' })]);

    const result = await new ListDoctorsTool(doctors).execute({});

    expect(result.doctors.map((entry) => entry.id)).toEqual(['d-3', 'd-1', 'd-2']);
  });

  it('drops registrationNumber from the agent-facing projection', async () => {
    const doctors = mockDoctorPort();
    doctors.listListedDoctors.mockResolvedValue([doctor({ registrationNumber: 'REG-SECRET' })]);

    const result = await new ListDoctorsTool(doctors).execute({});

    expect(result.doctors[0]).not.toHaveProperty('registrationNumber');
    expect(JSON.stringify(result)).not.toContain('REG-SECRET');
  });

  describe('input schema', () => {
    const tool = new ListDoctorsTool(mockDoctorPort());

    it(`rejects a limit above ${MAX_TOOL_RESULT_LIMIT}`, () => {
      expect(tool.inputSchema.safeParse({ limit: MAX_TOOL_RESULT_LIMIT + 1 }).success).toBe(false);
    });

    it('rejects a zero or negative limit', () => {
      expect(tool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    });

    it('rejects a negative maxFeeInr', () => {
      expect(tool.inputSchema.safeParse({ maxFeeInr: -100 }).success).toBe(false);
    });

    it('rejects a non-UUID specialtyId', () => {
      expect(tool.inputSchema.safeParse({ specialtyId: 'psychiatry' }).success).toBe(false);
    });

    it('accepts an empty object — every filter is optional', () => {
      expect(tool.inputSchema.safeParse({}).success).toBe(true);
    });
  });
});

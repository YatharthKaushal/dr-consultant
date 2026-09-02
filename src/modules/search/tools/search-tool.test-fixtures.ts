import type { PublicConcern, PublicSpecialty } from '../../catalogue/catalogue.contract';
import type { PublicDoctorProfile } from '../../doctor/doctor.contract';
import type { CatalogueToolPort, DoctorToolPort } from './search-tool.contract';

/**
 * Shared fixtures and hand-rolled mocks for the tool specs. Not a `.spec.ts`
 * file, so Jest's `testRegex` does not pick it up as a suite of its own.
 */

export function specialty(overrides: Partial<PublicSpecialty> = {}): PublicSpecialty {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'psychiatry',
    name: 'Psychiatry',
    description: 'Medical treatment of mental health conditions.',
    canPrescribe: true,
    intakeForm: [],
    firstConsultForm: [],
    requiredDocuments: [],
    isActive: true,
    ...overrides,
  };
}

export function concern(overrides: Partial<PublicConcern> = {}): PublicConcern {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    specialtyId: '11111111-1111-4111-8111-111111111111',
    code: 'sleep',
    name: 'Sleep',
    // Present on every fixture ON PURPOSE: the taxonomy tool's spec proves it
    // never reaches the output, which is only meaningful if the input has it.
    matchPhrases: ['cannot sleep', 'neend nahi aati', 'insomnia'],
    matchWeight: 3,
    isActive: true,
    ...overrides,
  };
}

export function doctor(overrides: Partial<PublicDoctorProfile> = {}): PublicDoctorProfile {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    fullName: 'Dr Asha Rao',
    bio: 'Fifteen years in adult psychiatry.',
    languages: ['English', 'Hindi'],
    qualification: 'MD Psychiatry',
    registrationNumber: 'REG-0001',
    yearsOfExperience: 15,
    consultationFeeInr: '1500.00',
    consultationDurationMinutes: 30,
    specialties: [{ id: '11111111-1111-4111-8111-111111111111', code: 'psychiatry', name: 'Psychiatry', isPrimary: true }],
    ...overrides,
  };
}

export function mockCataloguePort(): jest.Mocked<CatalogueToolPort> {
  return {
    listActiveSpecialties: jest.fn(),
    listActiveConcerns: jest.fn(),
    getConcernsByIds: jest.fn(),
  };
}

export function mockDoctorPort(): jest.Mocked<DoctorToolPort> {
  return { listListedDoctors: jest.fn() };
}

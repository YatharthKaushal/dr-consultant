/**
 * `GovernanceEnrichmentService` — the WHO/WHERE composition every queue in
 * this module reuses. `new GovernanceEnrichmentService(mockedDeps)`,
 * hand-rolled `jest.fn()`s.
 */
import type { BookingView } from '../booking/booking.contract';
import type { BookingFacade } from '../booking/booking.facade';
import type { PublicDoctorProfile } from '../doctor/doctor.contract';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { PatientFacade } from '../patient/patient.facade';
import type { PatientProfileSummary } from '../patient/patient.contract';
import { GovernanceEnrichmentService } from './governance-enrichment.service';

const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';
const DOCTOR_ID = 'd0000000-0000-4000-8000-000000000001';
const PATIENT_ID = 'p0000000-0000-4000-8000-000000000001';

function bookingView(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-000001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: 's0000000-0000-4000-8000-000000000001',
    concernId: null,
    mode: 'scheduled',
    status: 'awaiting_documentation',
    scheduledStartAt: new Date('2026-01-01T10:00:00.000Z'),
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-01-01T09:00:00.000Z'),
    ...overrides,
  };
}

describe('GovernanceEnrichmentService', () => {
  let booking: jest.Mocked<BookingFacade>;
  let doctor: jest.Mocked<DoctorFacade>;
  let patient: jest.Mocked<PatientFacade>;
  let service: GovernanceEnrichmentService;

  beforeEach(() => {
    booking = { getBooking: jest.fn() } as unknown as jest.Mocked<BookingFacade>;
    doctor = { getPublicProfile: jest.fn() } as unknown as jest.Mocked<DoctorFacade>;
    patient = { getProfileSummary: jest.fn() } as unknown as jest.Mocked<PatientFacade>;
    service = new GovernanceEnrichmentService(booking, doctor, patient);
  });

  it('composes the doctor name, patient name and live status for a real booking', async () => {
    booking.getBooking.mockResolvedValue(bookingView());
    doctor.getPublicProfile.mockResolvedValue({ fullName: 'Dr. Meera Iyer' } as PublicDoctorProfile);
    patient.getProfileSummary.mockResolvedValue({ fullName: 'Arjun Rao' } as PatientProfileSummary);

    const result = await service.resolve(CONSULTATION_ID);

    expect(result).toEqual({
      doctorId: DOCTOR_ID,
      doctorName: 'Dr. Meera Iyer',
      patientId: PATIENT_ID,
      patientName: 'Arjun Rao',
      consultationStatus: 'awaiting_documentation',
    });
    expect(doctor.getPublicProfile).toHaveBeenCalledWith(DOCTOR_ID);
    expect(patient.getProfileSummary).toHaveBeenCalledWith(PATIENT_ID);
  });

  it('never asks for a doctor profile when the instant consult has no doctor assigned yet', async () => {
    booking.getBooking.mockResolvedValue(bookingView({ doctorId: null }));
    patient.getProfileSummary.mockResolvedValue({ fullName: 'Arjun Rao' } as PatientProfileSummary);

    const result = await service.resolve(CONSULTATION_ID);

    expect(result.doctorId).toBeNull();
    expect(result.doctorName).toBeNull();
    expect(doctor.getPublicProfile).not.toHaveBeenCalled();
  });

  it('returns every field null, and asks neither downstream facade anything, when the booking itself cannot be found', async () => {
    booking.getBooking.mockResolvedValue(null);

    const result = await service.resolve(CONSULTATION_ID);

    expect(result).toEqual({
      doctorId: null,
      doctorName: null,
      patientId: null,
      patientName: null,
      consultationStatus: null,
    });
    expect(doctor.getPublicProfile).not.toHaveBeenCalled();
    expect(patient.getProfileSummary).not.toHaveBeenCalled();
  });

  it('resolveMany keys the result by consultation id, one entry per input', async () => {
    booking.getBooking.mockImplementation(async (id) => bookingView({ id, patientId: `patient-${id}` }));
    doctor.getPublicProfile.mockResolvedValue(null);
    patient.getProfileSummary.mockResolvedValue(null);

    const result = await service.resolveMany(['c1', 'c2']);

    expect([...result.keys()].sort()).toEqual(['c1', 'c2']);
    expect(result.get('c1')?.patientId).toBe('patient-c1');
    expect(result.get('c2')?.patientId).toBe('patient-c2');
  });
});

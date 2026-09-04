import { Injectable } from '@nestjs/common';
import { BookingFacade } from '../booking/booking.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { PatientFacade } from '../patient/patient.facade';
import type { GovernanceCaseParties } from './governance.types';

/**
 * THE composition point every queue in this module reuses: given a
 * consultation id, who does it belong to and where does it currently stand.
 * Split out of `GovernanceQueueService` because both working queues
 * (`listPendingCaseSummaries`, `listSafetyAlerts`) need the identical
 * three-facade composition, and a single tested implementation is safer than
 * two copies drifting.
 *
 * Never throws: a booking, doctor or patient lookup that comes back empty
 * (or a booking that is simply gone) resolves to `null` fields rather than
 * failing the whole queue page — an operational queue with one row a little
 * light on detail is far better than a queue that will not load.
 */
@Injectable()
export class GovernanceEnrichmentService {
  constructor(
    private readonly booking: BookingFacade,
    private readonly doctor: DoctorFacade,
    private readonly patient: PatientFacade,
  ) {}

  async resolve(consultationId: string): Promise<GovernanceCaseParties> {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking) {
      return { doctorId: null, doctorName: null, patientId: null, patientName: null, consultationStatus: null };
    }

    const [doctorProfile, patientProfile] = await Promise.all([
      booking.doctorId ? this.doctor.getPublicProfile(booking.doctorId) : Promise.resolve(null),
      this.patient.getProfileSummary(booking.patientId),
    ]);

    return {
      doctorId: booking.doctorId,
      doctorName: doctorProfile?.fullName ?? null,
      patientId: booking.patientId,
      patientName: patientProfile?.fullName ?? null,
      consultationStatus: booking.status,
    };
  }

  /** The batch form — one `resolve` per id, run concurrently. Used by both queue listings and both CSV exports so a page of N rows costs one round of parallel facade calls, not N sequential ones. */
  async resolveMany(consultationIds: readonly string[]): Promise<Map<string, GovernanceCaseParties>> {
    const entries = await Promise.all(
      consultationIds.map(async (id) => [id, await this.resolve(id)] as const),
    );
    return new Map(entries);
  }
}

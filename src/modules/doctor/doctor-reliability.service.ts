import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { instantConsultancyTable } from '../../schema/instant-consultancy.schema';
import { doctorNotFound } from './doctor.service';
import { DoctorRepository } from './doctor.repository';

export interface DoctorReliabilityMetrics {
  /**
   * `instant_consultancy`: accepted / offers this doctor could actually have
   * ANSWERED. `null` when there have been none (0/0), never `NaN`. See
   * `getAcceptanceRate` for what the denominator deliberately leaves out.
   */
  acceptanceRate: number | null;
  /** `consultations`: count(status='no_show') / count(status in ('completed','no_show')). `null` when the denominator is 0. */
  noShowRate: number | null;
  /** `clinical_records` joined through `consultations` for this doctor: count(finalisedAt not null) / count(*). `null` when the doctor has no consultations with a clinical record yet. */
  caseSummaryCompletionRate: number | null;
}

/**
 * Computed, not stored — read-only queries against `instant_consultancy`,
 * `consultations` and `clinical_records`, none of which this module owns
 * (M-11/M-13/M-15 aren't built yet, so no facade exists to ask instead).
 * This is a deliberate, narrow exception to "a module only reads its own
 * tables" (`backend/README.md` §2), explicitly called for by the M-05 task
 * brief for exactly this one read; these tables have no real data yet, so
 * every rate below returns `null` (zero-denominator) against a clean
 * database until M-11/M-13/M-15 exist.
 *
 * Zero-denominator choice: `null`, not `0` and not `NaN` — "no data yet" is
 * a different fact from "0% reliable," and `null` is what a client can
 * render as "not enough data" instead of a misleading zero.
 */
@Injectable()
export class DoctorReliabilityService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly doctorRepo: DoctorRepository,
  ) {}

  async getMetrics(doctorId: string): Promise<DoctorReliabilityMetrics> {
    const doctor = await this.doctorRepo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const [acceptance, noShow, caseSummary] = await Promise.all([
      this.getAcceptanceRate(doctorId),
      this.getNoShowRate(doctorId),
      this.getCaseSummaryCompletionRate(doctorId),
    ]);

    return { acceptanceRate: acceptance, noShowRate: noShow, caseSummaryCompletionRate: caseSummary };
  }

  /**
   * FR-18.6's acceptance rate.
   *
   * *** THE DENOMINATOR IS THE OFFERS THIS DOCTOR COULD HAVE ANSWERED, NOT
   * `count(*)`. *** It used to be `count(*)`, which quietly counted two
   * outcomes against the doctor that say nothing about them:
   *
   *   `superseded`  the request stopped being routable for a reason that has
   *                 nothing to do with the doctor — the patient cancelled it,
   *                 or it was released. `instant.repository.ts
   *                 #supersedePendingAttempts` exists precisely so that case
   *                 is not written down as `declined` ("which the doctor did
   *                 not do") or `timed_out` ("which is not what happened") —
   *                 and then the metric put it in the denominator anyway, so
   *                 the distinction bought the doctor nothing.
   *   `pending`     an offer that is on their screen RIGHT NOW. Counting an
   *                 unanswered question as a failure to answer means a
   *                 doctor's rate visibly dips for the sixty seconds they are
   *                 deciding, and dips further the more work they are sent.
   *
   * What is left — `accepted`, `declined`, `timed_out` — is exactly the set of
   * offers that reached the doctor and got an answer or ran out of time, which
   * is the question "how often does this doctor take an instant request"
   * actually asks.
   */
  private async getAcceptanceRate(doctorId: string): Promise<number | null> {
    const [row] = await this.db
      .select({
        answerable: sql<string>`count(*) filter (where ${instantConsultancyTable.outcome} in ('accepted', 'declined', 'timed_out'))`,
        accepted: sql<string>`count(*) filter (where ${instantConsultancyTable.outcome} = 'accepted')`,
      })
      .from(instantConsultancyTable)
      .where(eq(instantConsultancyTable.doctorId, doctorId));

    const answerable = Number(row?.answerable ?? 0);
    if (answerable === 0) return null;
    return Number(row?.accepted ?? 0) / answerable;
  }

  private async getNoShowRate(doctorId: string): Promise<number | null> {
    const [row] = await this.db
      .select({
        denominator: sql<string>`count(*) filter (where ${consultationsTable.status} in ('completed', 'no_show'))`,
        noShow: sql<string>`count(*) filter (where ${consultationsTable.status} = 'no_show')`,
      })
      .from(consultationsTable)
      .where(eq(consultationsTable.doctorId, doctorId));

    const denominator = Number(row?.denominator ?? 0);
    if (denominator === 0) return null;
    return Number(row?.noShow ?? 0) / denominator;
  }

  private async getCaseSummaryCompletionRate(doctorId: string): Promise<number | null> {
    const [row] = await this.db
      .select({
        total: sql<string>`count(*)`,
        finalised: sql<string>`count(*) filter (where ${clinicalRecordsTable.finalisedAt} is not null)`,
      })
      .from(consultationsTable)
      .innerJoin(clinicalRecordsTable, eq(clinicalRecordsTable.consultationId, consultationsTable.id))
      .where(eq(consultationsTable.doctorId, doctorId));

    const total = Number(row?.total ?? 0);
    if (total === 0) return null;
    return Number(row?.finalised ?? 0) / total;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { consultationsTable } from '../../schema/consultations.schema';
import type { ConsultationStatus } from '../../schema/enums.schema';

/** The subset of a `consultations` row this module ever needs to read. */
export interface ConsultationSummary {
  id: string;
  patientId: string;
  /** Null only while an instant request is still searching for a doctor (`consultations.schema.ts`). */
  doctorId: string | null;
  status: ConsultationStatus;
}

/**
 * This module's only outward-facing dependency on "does this consultation
 * exist, who is it between, and has this doctor ever had a consultation with
 * this patient" — bound to the `CONSULTATION_LOOKUP_PROVIDER` DI token
 * (`document.constants.ts`). M-11 (Booking) doesn't exist yet, so this is
 * currently implemented by `ConsultationLookupProvider` below (reads
 * `consultations` directly, a table that already exists in the schema).
 * Once M-11 exists, a `BookingFacade`-backed implementation replaces it at
 * the DI binding in `document.module.ts` — nothing that depends on this
 * interface (`patient-file.service.ts`, `report-request.service.ts`, or
 * their tests) needs to change.
 *
 * Named `...Port`, not `...Provider`, for the interface specifically (the
 * concrete placeholder below is the `...Provider`) — `availability.
 * contract.ts`'s `BusyIntervalProvider` uses "Provider" for the interface
 * itself, but this module already uses "Port" for its other DI seam
 * (`document-storage.contract.ts`'s `DocumentStoragePort`), so "Port" is
 * used consistently for both of this module's internal seams rather than
 * mixing the two conventions.
 */
export interface ConsultationLookupPort {
  /** One consultation by id, or `null` if it does not exist. Never throws. */
  findById(consultationId: string): Promise<ConsultationSummary | null>;

  /**
   * Every consultation id where `doctorId`/`patientId` match, ANY status —
   * the relationship test `docs/MODULES.md`'s M-10 section calls for
   * ("Treating doctor reads the patient's document history from their own
   * consultations with that patient"). Backs both the cross-consultation
   * history read and the doctor branch of the download ownership check.
   * Empty array (never throws) when there is no shared consultation, or
   * either id doesn't exist.
   */
  listConsultationIdsBetween(doctorId: string, patientId: string): Promise<string[]>;

  /** Every consultation id for one patient, any status/doctor — backs the patient's own report-request listing ("derived via their own consultations"). Empty array (never throws) for a patient with none. */
  listConsultationIdsForPatient(patientId: string): Promise<string[]>;
}

/**
 * PLACEHOLDER implementation of `ConsultationLookupPort`. Reads the EXISTING
 * `consultations` table directly — mirrors `modules/availability`'s
 * `consultation-busy-interval.provider.ts` precisely, including why this is
 * fine: `consultations` already exists in `src/schema/consultations.schema.ts`
 * (owned by the not-yet-built M-11/Booking module), so this is a read of a
 * pre-existing table, not this module creating or owning a cross-module
 * dependency on M-11's internals.
 */
@Injectable()
export class ConsultationLookupProvider implements ConsultationLookupPort {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(consultationId: string): Promise<ConsultationSummary | null> {
    const [row] = await this.db
      .select({
        id: consultationsTable.id,
        patientId: consultationsTable.patientId,
        doctorId: consultationsTable.doctorId,
        status: consultationsTable.status,
      })
      .from(consultationsTable)
      .where(eq(consultationsTable.id, consultationId))
      .limit(1);
    return row ?? null;
  }

  async listConsultationIdsBetween(doctorId: string, patientId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(and(eq(consultationsTable.doctorId, doctorId), eq(consultationsTable.patientId, patientId)));
    return rows.map((row) => row.id);
  }

  async listConsultationIdsForPatient(patientId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(eq(consultationsTable.patientId, patientId));
    return rows.map((row) => row.id);
  }
}

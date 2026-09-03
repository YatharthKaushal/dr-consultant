import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { DoctorPresence } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { DOCTOR_AUDIT_ENTITY_TYPES } from './doctor.constants';
import type {
  CompletionGateResult,
  DoctorPresenceState,
  InstantRoutingCandidate,
  ListInstantRoutingCandidatesFilter,
  PresenceActor,
  PresenceTransitionInput,
  PresenceTransitionResult,
  ResetPresenceInput,
} from './doctor.contract';
import { DoctorRepository } from './doctor.repository';

/**
 * *** THE M-05 SIDE OF THE M-13 BOUNDARY. READ THIS BEFORE ADDING A PRESENCE
 * WRITE ANYWHERE ELSE. ***
 *
 * `doctors.presence`, `doctors.allow_instant_consult` and
 * `doctors.blocked_by_consultation_id` are columns on `doctors`, so this
 * module owns writing them (`backend/README.md` §2: "A module owns its
 * folder, its Postgres schema and its tables. No other module reads or writes
 * them"). M-13 owns the RULES that decide when they move — FR-10.4's seven
 * states, FR-10.6's acceptance window, FR-10.5's completion gate.
 *
 * Splitting it any other way was the alternative, and it is the one this
 * codebase already regrets: `booking.repository.ts` documents two deliberate
 * cross-module reads of `payments` and explains at length why each was
 * unavoidable. A cross-module WRITE of the completion gate would be strictly
 * worse — it is a cached fact whose whole purpose is to be the single place
 * routing checks, and two owners is how it ends up disagreeing with itself.
 *
 * ── HOW THE RULE/WRITE SPLIT ACTUALLY WORKS ────────────────────────────────
 *
 * `transitionPresence` takes the legal FROM-states as an argument. M-13 holds
 * the transition table (`instant.constants.ts#LEGAL_PRESENCE_TRANSITIONS`)
 * and computes which states may legally reach the one it wants; this service
 * takes the row lock and enforces that set inside the same transaction.
 *
 * So: M-13 cannot write the column, and M-05 cannot invent a transition. The
 * lock and the legality check are in ONE transaction, which is the only way
 * the guard is worth anything under concurrency — a doctor tapping "go
 * offline" at the same instant as the router offering them a request is the
 * ordinary case, not the exotic one.
 */
@Injectable()
export class DoctorPresenceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: DoctorRepository,
    private readonly audit: AuditService,
  ) {}

  /* ── Reads ─────────────────────────────────────────────────────────────── */

  /** The doctor's live routing-relevant state, or `null` if the doctor id does not exist. */
  async getPresenceState(doctorId: string): Promise<DoctorPresenceState | null> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) return null;
    return {
      doctorId: doctor.id,
      presence: doctor.presence,
      allowInstantConsult: doctor.allowInstantConsult,
      blockedByConsultationId: doctor.blockedByConsultationId,
      isVerifiedAndListed: doctor.verificationStatus === 'verified' && doctor.isListed,
    };
  }

  /** See `DoctorRepository#listInstantRoutingCandidates` for every predicate and the ordering rationale. */
  async listInstantRoutingCandidates(filter: ListInstantRoutingCandidatesFilter): Promise<InstantRoutingCandidate[]> {
    if (filter.limit <= 0) return [];
    const rows = await this.repo.listInstantRoutingCandidates({
      specialtyId: filter.specialtyId,
      excludeDoctorIds: filter.excludeDoctorIds,
      limit: filter.limit,
    });
    return rows.map((row) => ({
      doctorId: row.id,
      fullName: row.fullName,
      consultationFeeInr: row.consultationFeeInr,
      consultationDurationMinutes: row.consultationDurationMinutes,
    }));
  }

  /* ── The state machine's write half ────────────────────────────────────── */

  /**
   * One presence transition, under `SELECT ... FOR UPDATE` on the doctor row.
   *
   * NEVER THROWS FOR A REFUSED TRANSITION. It returns a `refusal` instead,
   * because every caller is one of two things that must not have an exception
   * thrown at them: a sweep processing a batch (where one refusal must not
   * abandon the other 99 candidates), or a controller that wants to turn the
   * refusal into its OWN module's error code rather than leak M-05's. A
   * missing doctor is a refusal too, for the same reason.
   *
   * Three outcomes:
   *   already in `to`      -> `{ changed: false }`, no write, NO audit row. An
   *                           idempotent no-op is not a state change and must
   *                           not look like one in the log.
   *   guard did not match  -> `{ changed: false, refusal }`.
   *   moved                -> `{ changed: true }` plus a transactional audit row.
   */
  async transitionPresence(input: PresenceTransitionInput): Promise<PresenceTransitionResult> {
    return this.db.transaction(async (tx) => {
      const doctor = await this.repo.findByIdForUpdate(input.doctorId, tx);
      if (!doctor) {
        return { changed: false, before: null, after: null, refusal: 'doctor_not_found' as const };
      }

      const before = doctor.presence;

      // Idempotent no-op. Checked BEFORE the legality guard on purpose: a
      // caller retrying "go offline" on a doctor who is already offline has
      // not asked for an illegal transition, it has asked for nothing.
      if (before === input.to) {
        return {
          changed: false,
          before,
          after: before,
          blockedByConsultationId: doctor.blockedByConsultationId,
        };
      }

      // *** THE COMPLETION GATE, CHECKED UNDER THE LOCK. *** Reported
      // separately from `illegal_transition` because the two mean completely
      // different things to a doctor: "you cannot go available yet, finish
      // your notes" versus "you cannot get there from here".
      if (input.requireNotGated && doctor.blockedByConsultationId !== null) {
        return {
          changed: false,
          before,
          after: before,
          refusal: 'completion_gated' as const,
          blockedByConsultationId: doctor.blockedByConsultationId,
        };
      }

      const updated = await this.repo.updatePresenceIfIn(
        input.doctorId,
        input.from,
        input.to,
        { requireNotGated: input.requireNotGated },
        tx,
      );
      if (!updated) {
        return {
          changed: false,
          before,
          after: before,
          refusal: 'illegal_transition' as const,
          blockedByConsultationId: doctor.blockedByConsultationId,
        };
      }

      await this.writePresenceAudit(input.actor, input.doctorId, before, input.to, input.reason, tx);

      return {
        changed: true,
        before,
        after: updated.presence,
        blockedByConsultationId: updated.blockedByConsultationId,
      };
    });
  }

  /**
   * *** SETS THE COMPLETION GATE (FR-10.5). *** Called when an instant
   * consultation ends: no new instant request routes to this doctor until the
   * prescription-or-advice and the case summary are finished.
   *
   * Refuses when the doctor is already gated by a DIFFERENT consultation.
   * Overwriting would drop the older outstanding documentation on the floor,
   * which is precisely the outcome this gate exists to prevent — and it would
   * do it silently, because nothing else records which consultation the gate
   * was holding.
   */
  async setCompletionGate(input: {
    doctorId: string;
    consultationId: string;
    actor: PresenceActor;
  }): Promise<CompletionGateResult> {
    return this.db.transaction(async (tx) => {
      const doctor = await this.repo.findByIdForUpdate(input.doctorId, tx);
      if (!doctor) {
        return { changed: false, doctorId: null, blockedByConsultationId: null, refusal: 'doctor_not_found' as const };
      }

      if (doctor.blockedByConsultationId === input.consultationId) {
        // Already gated by this very consultation — idempotent, no audit row.
        return { changed: false, doctorId: doctor.id, blockedByConsultationId: doctor.blockedByConsultationId };
      }

      const updated = await this.repo.setCompletionGate(input.doctorId, input.consultationId, tx);
      if (!updated) {
        return {
          changed: false,
          doctorId: doctor.id,
          blockedByConsultationId: doctor.blockedByConsultationId,
          refusal: 'already_gated' as const,
        };
      }

      await this.audit.write(
        {
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          action: 'update',
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_COMPLETION_GATE,
          entityId: input.doctorId,
          consultationId: input.consultationId,
          metadata: { change: 'completion_gate_set', before: null, after: input.consultationId },
        },
        tx,
      );

      return { changed: true, doctorId: updated.id, blockedByConsultationId: updated.blockedByConsultationId };
    });
  }

  /**
   * *** CLEARS THE COMPLETION GATE (FR-10.5). *** Addressed by CONSULTATION,
   * not by doctor — see `DoctorRepository#clearCompletionGateByConsultation`
   * for why, and for why that makes this idempotent.
   *
   * M-15 will call this in the same transaction that sets
   * `clinical_records.finalised_at` (`docs/erd.sql`: "The same transaction
   * clears `doctors.blocked_by_consultation_id`"). It reaches here through
   * `InstantFacade.clearCompletionGate`, so M-15 never touches this table
   * either.
   */
  async clearCompletionGate(input: { consultationId: string; actor: PresenceActor }): Promise<CompletionGateResult> {
    return this.db.transaction(async (tx) => {
      const cleared = await this.repo.clearCompletionGateByConsultation(input.consultationId, tx);
      if (!cleared) {
        // Nobody was gated by this consultation: already cleared, or never
        // gated. Both are successful no-ops — M-15 must be able to retry.
        return { changed: false, doctorId: null, blockedByConsultationId: null };
      }

      await this.audit.write(
        {
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          action: 'update',
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_COMPLETION_GATE,
          entityId: cleared.id,
          consultationId: input.consultationId,
          metadata: { change: 'completion_gate_cleared', before: input.consultationId, after: null },
        },
        tx,
      );

      return { changed: true, doctorId: cleared.id, blockedByConsultationId: null };
    });
  }

  /**
   * THE BOOT SWEEP. One statement plus one audit row per doctor actually
   * moved — see `DoctorRepository#bulkResetPresence` for the `docs/erd.sql`
   * paragraph that calls for it.
   *
   * Audited individually rather than as a single summary row because an
   * auditor reading one doctor's presence history must see the restart that
   * moved them, not have to correlate a timestamp against a separate
   * process-level event.
   */
  async resetPresence(input: ResetPresenceInput): Promise<{ doctorIds: string[] }> {
    return this.db.transaction(async (tx) => {
      const doctorIds = await this.repo.bulkResetPresence(input.from, input.to, tx);
      for (const doctorId of doctorIds) {
        await this.writePresenceAudit(input.actor, doctorId, null, input.to, input.reason, tx);
      }
      return { doctorIds };
    });
  }

  private async writePresenceAudit(
    actor: PresenceActor,
    doctorId: string,
    before: DoctorPresence | null,
    after: DoctorPresence,
    reason: string | undefined,
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  ): Promise<void> {
    await this.audit.write(
      {
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: 'update',
        entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_PRESENCE,
        entityId: doctorId,
        metadata: { change: 'presence', before, after, ...(reason ? { reason } : {}) },
      },
      tx,
    );
  }
}

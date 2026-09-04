import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { ClarificationCaseRow, NewClarificationCaseRow } from '../../schema/clarification-cases.schema';
import type { ClarificationStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { ClinicalFacade } from '../clinical/clinical.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { appendClarificationMessage, parseClarificationMessages } from './clarification-message.util';
import {
  CLARIFICATION_AUDIT_ENTITY_TYPES,
  CLARIFICATION_ERROR_CODES,
  CLARIFICATION_STATUS_TRANSITIONS,
} from './clarification.constants';
import type { ClarificationCaseSummaryView, ClarificationMessage } from './clarification.contract';
import type {
  AddClarificationMessageDto,
  CreateClarificationCaseDto,
  ListClarificationCasesQueryDto,
  UpdateClarificationCaseDto,
} from './clarification.dto';
import {
  toClarificationCaseExpertView,
  toClarificationCaseSummaryView,
  toClarificationCaseView,
  type ClarificationCaseExpertView,
  type ClarificationCaseView,
} from './clarification.mapper';
import { ClarificationRepository } from './clarification.repository';

/**
 * M-17's rules (`backend/README.md` §2: "services hold the rules").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** THE TWO INDEPENDENT CHECKS `clarification-cases.schema.ts` NAMES. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   CHECK #1, "WHO MAY BE ASKED": `assignExpert` below is the only place
 *   `expert_doctor_id` is ever written, and it is the only place that calls
 *   `DoctorFacade.isExpertDoctor` — no other method in this file may set that
 *   column.
 *
 *   CHECK #2, "WHAT THEY MAY SEE": `listAssignedCases`/`getAssignedCase`
 *   below are the ONLY read paths an expert-scoped controller route may call,
 *   and both require an `expertDoctorId` argument that lands directly in
 *   `ClarificationRepository`'s `WHERE` clause
 *   (`clarification.repository.ts#listByExpertDoctor`). There is no method
 *   on this service an expert-facing controller could call to reach a case
 *   not assigned to them, other than by guessing an id — and guessing one
 *   gets the identical 404 a genuine stranger gets, never a leak of
 *   "this exists but isn't yours".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** EVERY STATUS MOVE TAKES THE ROW LOCK. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Copies `booking.service.ts#transitionConsultationStatus`'s shape exactly:
 * open a transaction, `findByIdForUpdate` (the row lock), check ownership
 * and the precondition against the LOCKED row, write the guarded
 * `UPDATE ... WHERE status IN (from)`, audit inside the same transaction.
 * `clarification.constants.ts#CLARIFICATION_STATUS_TRANSITIONS` is this
 * module's `LEGAL_VIDEO_STATUS_TRANSITIONS`.
 *
 * Unlike M-14's webhook-driven moves, every write here is a doctor or admin
 * clicking a button once — there is no redelivery to be idempotent about, so
 * an illegal transition (including "you already did that") is a thrown
 * `ConflictException`, not a silent no-op.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** DE-IDENTIFICATION IS HONEST, NOT ABSOLUTE. SEE `postCase`. ***
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class ClarificationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: ClarificationRepository,
    private readonly doctors: DoctorFacade,
    private readonly clinical: ClinicalFacade,
    private readonly audit: AuditService,
  ) {}

  /* ══════════════════════════════════════════════════════════════════════ */
  /* The treating doctor's draft                                            */
  /* ══════════════════════════════════════════════════════════════════════ */

  /**
   * FR-12.1/FR-12.3: creates a `draft`. `treatingDoctorId` is a method
   * parameter, never read off `dto` — `clarification.controller.ts` always
   * supplies `@CurrentUser().accountId`, the same rule
   * `booking.controller.ts#create` follows for `patientId`.
   */
  async createDraft(treatingDoctorId: string, dto: CreateClarificationCaseDto): Promise<ClarificationCaseView> {
    if (dto.sourceConsultationId) {
      await this.assertSourceConsultationExists(dto.sourceConsultationId);
    }

    const insert: NewClarificationCaseRow = {
      treatingDoctorId,
      sourceConsultationId: dto.sourceConsultationId ?? null,
      title: dto.title,
      patientAge: dto.patientAge ?? null,
      patientGender: dto.patientGender ?? null,
      briefHistory: dto.briefHistory,
      diagnosis: dto.diagnosis ?? null,
      currentPlan: dto.currentPlan ?? null,
      specificDoubt: dto.specificDoubt,
      ...(dto.urgency ? { urgency: dto.urgency } : {}),
    };

    const row = await this.repo.create(insert);

    await this.audit.write({
      actorType: 'doctor',
      actorId: treatingDoctorId,
      action: 'create',
      entityType: CLARIFICATION_AUDIT_ENTITY_TYPES.CLARIFICATION_CASE,
      entityId: row.id,
      metadata: { change: 'clarification_case_created' },
    });

    return toClarificationCaseView(row);
  }

  /** The treating doctor's own view of a case they posted — draft or otherwise. 404 (not 403) when it is not theirs. */
  async getOwnCase(caseId: string, treatingDoctorId: string): Promise<ClarificationCaseView> {
    const row = await this.requireOwnCase(caseId, treatingDoctorId);
    return toClarificationCaseView(row);
  }

  /** Every case this doctor has POSTED (or is drafting) — `ClarificationRepository#listByTreatingDoctor`, always scoped by id. */
  async listOwnCases(treatingDoctorId: string, query: ListClarificationCasesQueryDto): Promise<ClarificationCaseView[]> {
    const rows = await this.repo.listByTreatingDoctor(treatingDoctorId, {
      status: query.status,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
    return rows.map(toClarificationCaseView);
  }

  /**
   * Patches a `draft` in place. Refuses once the case has left `draft` — see
   * `CLARIFICATION_ERROR_CODES.NOT_A_DRAFT`. There is no such thing as
   * editing a posted case's content; a treating doctor who needs to correct
   * one closes it and posts a new one.
   *
   * Not row-locked like the status moves below — `updateDraftFields`'s
   * `WHERE status = 'draft'` guard is itself the concurrency control
   * (`clinical.repository.ts#updateDraft`'s reasoning), and there is no
   * ownership write race to close: only the treating doctor who owns this
   * case can ever reach this method for it.
   */
  async updateDraft(
    caseId: string,
    treatingDoctorId: string,
    dto: UpdateClarificationCaseDto,
  ): Promise<ClarificationCaseView> {
    const existing = await this.requireOwnCase(caseId, treatingDoctorId);
    if (existing.status !== 'draft') {
      throw notADraft();
    }
    if (dto.sourceConsultationId) {
      await this.assertSourceConsultationExists(dto.sourceConsultationId);
    }

    const patch: Partial<NewClarificationCaseRow> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.patientAge !== undefined) patch.patientAge = dto.patientAge;
    if (dto.patientGender !== undefined) patch.patientGender = dto.patientGender;
    if (dto.briefHistory !== undefined) patch.briefHistory = dto.briefHistory;
    if (dto.diagnosis !== undefined) patch.diagnosis = dto.diagnosis;
    if (dto.currentPlan !== undefined) patch.currentPlan = dto.currentPlan;
    if (dto.specificDoubt !== undefined) patch.specificDoubt = dto.specificDoubt;
    if (dto.urgency !== undefined) patch.urgency = dto.urgency;
    if (dto.sourceConsultationId !== undefined) patch.sourceConsultationId = dto.sourceConsultationId;

    const updated = await this.repo.updateDraftFields(caseId, patch);
    if (!updated) {
      // Lost a race with a concurrent post — the case is no longer a draft.
      throw notADraft();
    }

    await this.audit.write({
      actorType: 'doctor',
      actorId: treatingDoctorId,
      action: 'update',
      entityType: CLARIFICATION_AUDIT_ENTITY_TYPES.CLARIFICATION_CASE,
      entityId: caseId,
      metadata: { change: 'clarification_case_draft_edited' },
    });

    return toClarificationCaseView(updated);
  }

  /**
   * *** POSTS THE CASE. `draft` -> `posted`. FR-12.1. ***
   *
   * *** READ THIS BEFORE TOUCHING DE-IDENTIFICATION. ***
   *
   * This is the moment the case leaves the treating doctor's hands, and it is
   * where `docs/MODULES.md`'s "name, phone, address, email and other direct
   * identifiers stripped before sharing" (M-17 features) has to be made
   * honest rather than merely claimed.
   *
   * What this method — and this whole module — actually guarantees: the case
   * is built from `CreateClarificationCaseDto`/`clarification_cases`'
   * STRUCTURED fields only (`title`, `patientAge`, `patientGender`,
   * `briefHistory`, `diagnosis`, `currentPlan`, `specificDoubt`, `urgency`).
   * There is no `patientName`/`patientPhone`/`patientAddress`/`patientEmail`
   * column and no such DTO field, so none of those four can reach a posted
   * case — not because something strips them, but because there is nowhere
   * for them to be written in the first place. That part is structural, and
   * `clarification.mapper.spec.ts`/`clarification.dto.spec.ts` test it
   * directly.
   *
   * What this method does NOT and CANNOT guarantee: that `briefHistory`,
   * `diagnosis`, `currentPlan` or `specificDoubt` — all free text, typed by
   * the treating doctor — contain no identifier. Nothing parses them, and
   * nothing in this codebase ever will without becoming a new, separate,
   * much harder clinical-NLP problem this module does not attempt and must
   * not claim to solve. `DEIDENTIFICATION_NOTICE` is surfaced on every draft
   * response specifically because THIS is the gap it exists to cover — the
   * responsibility for what a treating doctor types into free text is
   * theirs, every time, and no code path downstream of this one will catch
   * what they miss.
   */
  async postCase(caseId: string, treatingDoctorId: string): Promise<ClarificationCaseView> {
    return this.transitionOwnCase(caseId, treatingDoctorId, {
      from: CLARIFICATION_STATUS_TRANSITIONS.posted,
      patch: { status: 'posted', postedAt: new Date() },
      changeLabel: 'posted',
    });
  }

  /**
   * The treating doctor answers a `clarification_asked` case —
   * `clarification_asked` -> `awaiting_response`, adding their reply. Only
   * legal `from: ['clarification_asked']`, narrower than what
   * `CLARIFICATION_STATUS_TRANSITIONS.awaiting_response` lists overall (that
   * table also lists `posted`, which is `assignExpert`'s move, not this
   * one) — see `clarification.constants.ts`'s header for why each method
   * narrows its own `from`.
   */
  async replyToClarification(
    caseId: string,
    treatingDoctorId: string,
    dto: AddClarificationMessageDto,
  ): Promise<ClarificationCaseView> {
    return this.transitionOwnCase(caseId, treatingDoctorId, {
      from: ['clarification_asked'],
      buildPatch: (row) => ({
        status: 'awaiting_response',
        messages: appendClarificationMessage(parseClarificationMessages(row.messages), {
          authorId: treatingDoctorId,
          authorType: 'doctor',
          messageType: dto.messageType,
          body: dto.body,
          at: new Date().toISOString(),
        }),
      }),
      changeLabel: 'awaiting_response',
    });
  }

  /** `response_received` -> `reviewed`. The treating doctor marks the expert's input read and acted on. */
  async markReviewed(caseId: string, treatingDoctorId: string): Promise<ClarificationCaseView> {
    return this.transitionOwnCase(caseId, treatingDoctorId, {
      from: CLARIFICATION_STATUS_TRANSITIONS.reviewed,
      patch: { status: 'reviewed' },
      changeLabel: 'reviewed',
    });
  }

  /** Any active status -> `closed`. FR-12.7: the treating doctor owns the case end to end and may close it whenever they judge it settled. */
  async closeCase(caseId: string, treatingDoctorId: string): Promise<ClarificationCaseView> {
    return this.transitionOwnCase(caseId, treatingDoctorId, {
      from: CLARIFICATION_STATUS_TRANSITIONS.closed,
      patch: { status: 'closed', closedAt: new Date() },
      changeLabel: 'closed',
    });
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* The expert's assigned queue — CHECK #2                                 */
  /* ══════════════════════════════════════════════════════════════════════ */

  /**
   * *** THIS AND `listAssignedCases` ARE THE ENTIRE EXPERT READ SURFACE. ***
   * `expertDoctorId` is a required parameter that reaches
   * `ClarificationRepository#listByExpertDoctor`'s `WHERE` clause — there is
   * no overload and no other method that returns cases for "an expert" in
   * general. A stranger's id and a genuinely unassigned case produce the
   * identical `caseNotFound()` 404 as a case that does not exist at all.
   */
  async getAssignedCase(caseId: string, expertDoctorId: string): Promise<ClarificationCaseExpertView> {
    const row = await this.requireAssignedCase(caseId, expertDoctorId);
    return toClarificationCaseExpertView(row);
  }

  /** Every case assigned to this expert, and nothing else — an expert with zero assignments gets `[]`, never another expert's cases. */
  async listAssignedCases(
    expertDoctorId: string,
    query: ListClarificationCasesQueryDto,
  ): Promise<ClarificationCaseExpertView[]> {
    const rows = await this.repo.listByExpertDoctor(expertDoctorId, {
      status: query.status,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
    return rows.map(toClarificationCaseExpertView);
  }

  /**
   * The expert's turn: FR-12.5's "comment, suggest clinical considerations,
   * request clarification, or recommend early/in-person follow-up" — all
   * four are `messageType` values on the SAME method, because they are one
   * act (the expert replies) with four possible shades, not four different
   * write paths.
   *
   * Only legal from `awaiting_response` — see
   * `clarification.constants.ts`'s "turn-based, no self-loop" note: once the
   * expert has replied, it is the treating doctor's move (if the reply was a
   * `clarification_request`) or the case sits at `response_received` for the
   * treating doctor to mark reviewed or close. The expert cannot pile a
   * second message onto their own turn.
   */
  async respondAsExpert(
    caseId: string,
    expertDoctorId: string,
    dto: AddClarificationMessageDto,
  ): Promise<ClarificationCaseExpertView> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(caseId, tx);
      if (!row || row.expertDoctorId !== expertDoctorId) {
        throw caseNotFound();
      }
      if (row.status !== 'awaiting_response') {
        throw illegalTransition(row.status, 'response_received');
      }

      const targetStatus: ClarificationStatus =
        dto.messageType === 'clarification_request' ? 'clarification_asked' : 'response_received';
      const messages = appendClarificationMessage(parseClarificationMessages(row.messages), {
        authorId: expertDoctorId,
        authorType: 'doctor',
        messageType: dto.messageType,
        body: dto.body,
        at: new Date().toISOString(),
      });

      const updated = await this.repo.updateStatusIfIn(caseId, ['awaiting_response'], { status: targetStatus, messages }, tx);
      if (!updated) {
        throw illegalTransition(row.status, targetStatus);
      }

      await this.audit.write(
        {
          actorType: 'doctor',
          actorId: expertDoctorId,
          action: 'update',
          entityType: CLARIFICATION_AUDIT_ENTITY_TYPES.CLARIFICATION_CASE,
          entityId: caseId,
          metadata: { change: 'clarification_status_transition', before: 'awaiting_response', after: targetStatus },
        },
        tx,
      );

      return toClarificationCaseExpertView(updated);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Admin — CHECK #1, and the tracker                                      */
  /* ══════════════════════════════════════════════════════════════════════ */

  /**
   * *** CHECK #1, "WHO MAY BE ASKED", ENFORCED. *** `posted` ->
   * `awaiting_response`, and the only place `expertDoctorId` is ever
   * written. Refuses unless `DoctorFacade.isExpertDoctor` reports
   * `verificationStatus === 'verified' AND seniorityLevel === 'expert'` — see
   * that method's own doc comment in `doctor.contract.ts`.
   *
   * The facade call happens BEFORE the transaction opens, same discipline
   * `clinical.service.ts#finalise` follows for its own cross-module read
   * (`backend/README.md` §2 forbids cross-module transactions — holding a
   * pooled connection open across a call into `modules/doctor` is how that
   * gets broken by accident). *** THIS LEAVES A NARROW, ACKNOWLEDGED RACE: ***
   * an admin could revoke a doctor's expert role in the instant between this
   * check and the write below committing. Accepted rather than engineered
   * around: expert-role grants change rarely and only by a separate admin
   * action, and the alternative (a second facade call taken INSIDE the
   * transaction) would be the exact cross-module-transaction anti-pattern
   * `clinical.module.ts`'s header calls "a loaded gun, not a kill-switch".
   */
  async assignExpert(caseId: string, expertDoctorId: string, actingAdminId: string): Promise<ClarificationCaseView> {
    const isExpert = await this.doctors.isExpertDoctor(expertDoctorId);
    if (!isExpert) {
      throw notAnExpert();
    }

    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(caseId, tx);
      if (!row) throw caseNotFound();
      if (row.status !== 'posted') {
        throw illegalTransition(row.status, 'awaiting_response');
      }

      const updated = await this.repo.updateStatusIfIn(
        caseId,
        ['posted'],
        { status: 'awaiting_response', expertDoctorId, assignedAt: new Date() },
        tx,
      );
      if (!updated) {
        throw illegalTransition(row.status, 'awaiting_response');
      }

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: CLARIFICATION_AUDIT_ENTITY_TYPES.CLARIFICATION_CASE,
          entityId: caseId,
          metadata: { change: 'clarification_expert_assigned', expertDoctorId },
        },
        tx,
      );

      return toClarificationCaseView(updated);
    });
  }

  /** The admin tracker's detail read. Unconditional — an admin route, gated by `RequirePermission` at the controller, not by ownership. */
  async getForAdmin(caseId: string): Promise<ClarificationCaseView> {
    const row = await this.repo.findById(caseId);
    if (!row) throw caseNotFound();
    return toClarificationCaseView(row);
  }

  /** The admin tracker's list — `docs/MODULES.md` M-20's "case clarification tracker", served here directly until M-20 exists (`clinical-admin.controller.ts`'s own precedent). */
  async listForAdmin(query: ListClarificationCasesQueryDto): Promise<ClarificationCaseView[]> {
    const rows = await this.repo.listForAdmin({
      status: query.status,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
    return rows.map(toClarificationCaseView);
  }

  /** `ClarificationContract#getCaseSummary` — see that interface for why this is the narrowest possible cross-module read. */
  async getCaseSummary(caseId: string): Promise<ClarificationCaseSummaryView | null> {
    const row = await this.repo.findById(caseId);
    return row ? toClarificationCaseSummaryView(row) : null;
  }

  /**
   * ADDITIVE (M-21/data rights execution). See
   * `ClarificationContract#countCasesForConsultations` — a pure, read-only
   * count, nothing here is anonymized or deleted.
   */
  async countCasesForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.repo.countCasesForConsultations(consultationIds);
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Shared plumbing                                                        */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** Ownership. A case that does not exist and one belonging to another treating doctor produce the IDENTICAL 404. */
  private async requireOwnCase(caseId: string, treatingDoctorId: string): Promise<ClarificationCaseRow> {
    const row = await this.repo.findById(caseId);
    if (!row || row.treatingDoctorId !== treatingDoctorId) {
      throw caseNotFound();
    }
    return row;
  }

  /** Assignment. A case that does not exist and one not assigned to this expert produce the IDENTICAL 404 — CHECK #2. */
  private async requireAssignedCase(caseId: string, expertDoctorId: string): Promise<ClarificationCaseRow> {
    const row = await this.repo.findById(caseId);
    if (!row || row.expertDoctorId !== expertDoctorId) {
      throw caseNotFound();
    }
    return row;
  }

  /**
   * *** THE ROW LOCK, SHARED BY EVERY TREATING-DOCTOR STATUS MOVE. ***
   * `booking.service.ts#transitionConsultationStatus`'s shape: open a
   * transaction, `findByIdForUpdate`, check ownership against the locked
   * row, write the guarded `UPDATE ... WHERE status IN (from)`, audit inside
   * the same transaction.
   *
   * `patch` is a static object (the common case: `postCase`/`markReviewed`/
   * `closeCase`, none of which need to read the locked row to build their
   * write); `buildPatch` is a function of the locked row (`
   * replyToClarification`, which must read-modify-write `messages`). Exactly
   * one of the two is supplied.
   */
  private async transitionOwnCase(
    caseId: string,
    treatingDoctorId: string,
    options: {
      from: readonly ClarificationStatus[];
      patch?: Partial<NewClarificationCaseRow> & { status: ClarificationStatus };
      buildPatch?: (row: ClarificationCaseRow) => Partial<NewClarificationCaseRow> & { status: ClarificationStatus };
      changeLabel: ClarificationStatus;
    },
  ): Promise<ClarificationCaseView> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(caseId, tx);
      if (!row || row.treatingDoctorId !== treatingDoctorId) {
        throw caseNotFound();
      }
      if (!options.from.includes(row.status)) {
        throw illegalTransition(row.status, options.changeLabel);
      }

      const patch = options.buildPatch ? options.buildPatch(row) : options.patch;
      if (!patch) {
        throw new Error('transitionOwnCase called with neither patch nor buildPatch — should be unreachable.');
      }

      const updated = await this.repo.updateStatusIfIn(caseId, options.from, patch, tx);
      if (!updated) {
        throw illegalTransition(row.status, options.changeLabel);
      }

      await this.writeMessageAudit(caseId, 'doctor', treatingDoctorId, row.status, patch.status, tx);
      return toClarificationCaseView(updated);
    });
  }

  /**
   * `sourceConsultationId` is doctor-supplied and used only for audit — see
   * `clarification.dto.ts#CreateClarificationCaseDto.sourceConsultationId`'s
   * doc comment for why this module cannot verify the caller actually
   * treated that consultation (that would need `BookingFacade`, outside
   * M-17's stated M-02/M-05/M-15 dependencies). What IS checked: the id
   * resolves to a real clinical record at all, through the one read
   * `ClinicalContract` grants this module
   * (`clinical.contract.ts#ClinicalContract.getRecordByConsultationId`) —
   * catching a typo, not impersonation.
   */
  private async assertSourceConsultationExists(sourceConsultationId: string): Promise<void> {
    const record = await this.clinical.getRecordByConsultationId(sourceConsultationId);
    if (!record) {
      throw new NotFoundException({
        code: CLARIFICATION_ERROR_CODES.CASE_NOT_FOUND,
        message: 'sourceConsultationId does not match any clinical record.',
      });
    }
  }

  private async writeMessageAudit(
    caseId: string,
    actorType: 'doctor' | 'admin',
    actorId: string,
    before: ClarificationStatus,
    after: ClarificationStatus,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await this.audit.write(
      {
        actorType,
        actorId,
        action: 'update',
        entityType: CLARIFICATION_AUDIT_ENTITY_TYPES.CLARIFICATION_CASE,
        entityId: caseId,
        metadata: { change: 'clarification_status_transition', before, after },
      },
      tx,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** One code for "does not exist" and "is not yours"/"is not assigned to you" — see this file's header and `clarification.constants.ts`. */
export function caseNotFound(): NotFoundException {
  return new NotFoundException({
    code: CLARIFICATION_ERROR_CODES.CASE_NOT_FOUND,
    message: 'Clarification case not found.',
  });
}

export function illegalTransition(from: ClarificationStatus, to: ClarificationStatus): ConflictException {
  return new ConflictException({
    code: CLARIFICATION_ERROR_CODES.ILLEGAL_TRANSITION,
    message: `Cannot move a clarification case from '${from}' to '${to}'.`,
  });
}

export function notADraft(): ConflictException {
  return new ConflictException({
    code: CLARIFICATION_ERROR_CODES.NOT_A_DRAFT,
    message: 'This case has already been posted; only a draft may be edited.',
  });
}

export function notAnExpert(): ConflictException {
  return new ConflictException({
    code: CLARIFICATION_ERROR_CODES.NOT_AN_EXPERT,
    message: 'expertDoctorId must be a verified doctor with the expert seniority level.',
  });
}

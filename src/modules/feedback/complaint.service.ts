import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { ComplaintRow, NewComplaintRow } from '../../schema/complaints.schema';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { BookingFacade } from '../booking/booking.facade';
import { appendComplaintMessage, parseComplaintMessages } from './complaint-message.util';
import { ComplaintRepository, type ListComplaintsFilter } from './complaint.repository';
import {
  FEEDBACK_AUDIT_ENTITY_TYPES,
  COMPLAINT_ERROR_CODES,
  COMPLAINT_REFERENCE_ALLOCATION_ATTEMPTS,
  COMPLAINT_REFERENCE_PREFIX,
  COMPLAINT_STATUS_TRANSITIONS,
} from './feedback.constants';
import type {
  AddComplaintAdminMessageDto,
  AddComplaintMessageDto,
  ListComplaintsAdminQueryDto,
  ListOwnComplaintsQueryDto,
  RaiseComplaintDto,
  RejectComplaintDto,
  ResolveComplaintDto,
} from './feedback.dto';
import { toComplaintPatientView, toComplaintView, type ComplaintView } from './feedback.mapper';

/**
 * FR-17.2/FR-18.8's rules (`backend/README.md` §2: "services hold the rules").
 *
 * *** OWNERSHIP, COPIED FROM `followup.service.ts#assertPatientOwnsConsultation`.
 * *** `BookingFacade` is injected directly — M-11 is a real, merged module.
 * A complaint's `consultationId` is nullable (`complaints.schema.ts`: "Null
 * when not about one consultation" — a real, valid case per FR-17.2), so the
 * ownership check only runs when one is supplied.
 *
 * *** EVERY STATUS MOVE TAKES THE ROW LOCK. *** Copies
 * `clarification.service.ts`'s shape exactly: open a transaction,
 * `findByIdForUpdate` (the row lock), check the precondition against the
 * LOCKED row, write the guarded `UPDATE ... WHERE status = <from>`, audit
 * inside the same transaction.
 *
 * *** MESSAGES ARE NOT TRANSITIONS. *** Unlike M-17's turn-based cases, a
 * complaint has no "whose turn" concept — either side may add a message in
 * any status, and doing so never itself changes `status`. See
 * `feedback.constants.ts#COMPLAINT_STATUS_TRANSITIONS`'s header.
 */
@Injectable()
export class ComplaintService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: ComplaintRepository,
    private readonly booking: BookingFacade,
    private readonly audit: AuditService,
  ) {}

  /* ══════════════════════════════════════════════════════════════════════ */
  /* The patient's own complaints                                          */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** FR-17.2. `patientId` is a method parameter, never read off `dto` — the same rule `CreateBookingDto`'s own doc comment states for `patientId`. */
  async raiseComplaint(patientId: string, dto: RaiseComplaintDto): Promise<ComplaintView> {
    if (dto.consultationId) {
      await this.assertPatientOwnsConsultation(dto.consultationId, patientId);
    }

    const referenceCode = await this.generateReferenceCode();
    const insert: NewComplaintRow = {
      referenceCode,
      patientId,
      consultationId: dto.consultationId ?? null,
      category: dto.category,
      subject: dto.subject,
      description: dto.description,
    };

    const row = await this.repo.create(insert);

    await this.audit.write({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: FEEDBACK_AUDIT_ENTITY_TYPES.COMPLAINT,
      entityId: row.id,
      ...(row.consultationId ? { consultationId: row.consultationId } : {}),
      metadata: { change: 'complaint_raised', category: dto.category, referenceCode },
    });

    return toComplaintPatientView(row);
  }

  /** The patient's own view of a complaint they raised. 404 (not 403) when it is not theirs. */
  async getOwnComplaint(complaintId: string, patientId: string): Promise<ComplaintView> {
    const row = await this.requireOwnComplaint(complaintId, patientId);
    return toComplaintPatientView(row);
  }

  /** Every complaint this patient has raised — `patientId` in the `WHERE` clause, never applied after the fact. */
  async listOwnComplaints(patientId: string, query: ListOwnComplaintsQueryDto): Promise<ComplaintView[]> {
    const rows = await this.repo.listByPatientId(patientId, {
      status: query.status,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
    return rows.map(toComplaintPatientView);
  }

  /** The patient's own message on their own thread — legal in any status, see this file's header. */
  async addPatientMessage(complaintId: string, patientId: string, dto: AddComplaintMessageDto): Promise<ComplaintView> {
    const existing = await this.requireOwnComplaint(complaintId, patientId);
    const updated = await this.appendMessage(existing, {
      authorId: patientId,
      authorType: 'patient',
      body: dto.body,
      isInternal: false,
      at: new Date().toISOString(),
    });

    await this.audit.write({
      actorType: 'patient',
      actorId: patientId,
      action: 'update',
      entityType: FEEDBACK_AUDIT_ENTITY_TYPES.COMPLAINT,
      entityId: complaintId,
      metadata: { change: 'complaint_message_added' },
    });

    return toComplaintPatientView(updated);
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Admin — the tracker and the workflow                                  */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** The admin tracker's detail read. Unconditional — an admin route, gated by `RequirePermission` at the controller, not by ownership. */
  async getForAdmin(complaintId: string): Promise<ComplaintView> {
    const row = await this.repo.findById(complaintId);
    if (!row) throw this.complaintNotFound();
    return toComplaintView(row);
  }

  /** The admin tracker's list — FR-18.8: filterable by status, by category, by assignee. */
  async listForAdmin(query: ListComplaintsAdminQueryDto): Promise<ComplaintView[]> {
    const filter: ListComplaintsFilter = {
      status: query.status,
      category: query.category,
      assignedToAdminId: query.assignedToAdminId,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    };
    const rows = await this.repo.listForAdmin(filter);
    return rows.map(toComplaintView);
  }

  /** An admin's message on the thread — may be internal-only (see `AddComplaintAdminMessageDto`). Legal in any status. */
  async addAdminMessage(complaintId: string, adminId: string, dto: AddComplaintAdminMessageDto): Promise<ComplaintView> {
    const existing = await this.repo.findById(complaintId);
    if (!existing) throw this.complaintNotFound();

    const updated = await this.appendMessage(existing, {
      authorId: adminId,
      authorType: 'admin',
      body: dto.body,
      isInternal: dto.isInternal ?? false,
      at: new Date().toISOString(),
    });

    await this.audit.write({
      actorType: 'admin',
      actorId: adminId,
      action: 'update',
      entityType: FEEDBACK_AUDIT_ENTITY_TYPES.COMPLAINT,
      entityId: complaintId,
      metadata: { change: 'complaint_message_added', isInternal: dto.isInternal ?? false },
    });

    return toComplaintView(updated);
  }

  /**
   * *** `open` -> `in_progress`. *** The only place `assigned_to_admin_id`
   * is ever written — see `feedback.constants.ts#COMPLAINT_STATUS_TRANSITIONS`'s
   * header for why this is deliberately one-shot (`from: 'open'` only, no
   * reassignment path in this round).
   */
  async assignComplaint(complaintId: string, assignedToAdminId: string, actingAdminId: string): Promise<ComplaintView> {
    return this.transition(complaintId, {
      from: onlySource('in_progress'),
      patch: { status: 'in_progress', assignedToAdminId },
      actingAdminId,
      changeLabel: 'complaint_assigned',
      metadata: { assignedToAdminId },
    });
  }

  /** `in_progress` -> `resolved`. The one and only place `resolvedAt` is ever set — `complaints.schema.ts`'s own header. */
  async resolveComplaint(complaintId: string, actingAdminId: string, dto: ResolveComplaintDto): Promise<ComplaintView> {
    return this.transition(complaintId, {
      from: onlySource('resolved'),
      patch: { status: 'resolved', resolvedAt: new Date(), resolutionNote: dto.resolutionNote },
      actingAdminId,
      changeLabel: 'complaint_resolved',
      metadata: {},
    });
  }

  /** `in_progress` -> `rejected`. `resolvedAt` is NEVER set here — `rejected` is not resolved, `complaints.schema.ts`'s own header. */
  async rejectComplaint(complaintId: string, actingAdminId: string, dto: RejectComplaintDto): Promise<ComplaintView> {
    return this.transition(complaintId, {
      from: onlySource('rejected'),
      patch: { status: 'rejected', resolutionNote: dto.resolutionNote },
      actingAdminId,
      changeLabel: 'complaint_rejected',
      metadata: {},
    });
  }

  /**
   * *** THE M-20 SEAM. *** See `feedback.contract.ts#FeedbackContract
   * .countComplaintsByStatus` for the full argument. No auth/ownership
   * check — a trusted module-to-module read.
   */
  async countComplaintsByStatus(): Promise<Record<ComplaintStatus, number>> {
    const grouped = await this.repo.countByStatusGrouped();
    const result = {} as Record<ComplaintStatus, number>;
    for (const status of COMPLAINT_STATUSES) {
      result[status] = grouped.get(status) ?? 0;
    }
    return result;
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Shared plumbing                                                        */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** `followup.service.ts#assertPatientOwnsConsultation`'s exact shape. */
  private async assertPatientOwnsConsultation(consultationId: string, patientId: string) {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking || booking.patientId !== patientId) throw this.consultationNotFound();
    return booking;
  }

  /** Ownership. A complaint that does not exist and one belonging to another patient produce the IDENTICAL 404. */
  private async requireOwnComplaint(complaintId: string, patientId: string): Promise<ComplaintRow> {
    const row = await this.repo.findById(complaintId);
    if (!row || row.patientId !== patientId) {
      throw this.complaintNotFound();
    }
    return row;
  }

  /** Appends one message under no row lock — `clarification.service.ts#updateDraftFields`'s reasoning applies equally here: `appendMessages`' `WHERE id = ?` guard is not a status guard, so there is no concurrent-transition race a lock would close; two concurrent messages can only ever both succeed, never corrupt each other, because each read-modify-write is a single row UPDATE. */
  private async appendMessage(
    existing: ComplaintRow,
    message: { authorId: string; authorType: 'patient' | 'admin'; body: string; isInternal: boolean; at: string },
  ): Promise<ComplaintRow> {
    const messages = appendComplaintMessage(parseComplaintMessages(existing.messages), message);
    const updated = await this.repo.appendMessages(existing.id, messages);
    if (!updated) {
      throw this.complaintNotFound();
    }
    return updated;
  }

  /**
   * *** THE ROW LOCK, SHARED BY EVERY STATUS MOVE. *** `clarification.
   * service.ts#transitionOwnCase`'s shape: open a transaction,
   * `findByIdForUpdate`, check the precondition against the locked row,
   * write the guarded `UPDATE ... WHERE status = <from>`, audit inside the
   * same transaction.
   */
  private async transition(
    complaintId: string,
    options: {
      from: ComplaintStatus;
      patch: Partial<NewComplaintRow> & { status: ComplaintStatus };
      actingAdminId: string;
      changeLabel: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<ComplaintView> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(complaintId, tx);
      if (!row) throw this.complaintNotFound();
      if (row.status !== options.from) {
        throw this.illegalTransition(row.status, options.patch.status);
      }

      const updated = await this.repo.updateStatusIfFrom(complaintId, options.from, options.patch, tx);
      if (!updated) {
        throw this.illegalTransition(row.status, options.patch.status);
      }

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: options.actingAdminId,
          action: 'update',
          entityType: FEEDBACK_AUDIT_ENTITY_TYPES.COMPLAINT,
          entityId: complaintId,
          metadata: { change: options.changeLabel, before: row.status, after: options.patch.status, ...options.metadata },
        },
        tx,
      );

      return toComplaintView(updated);
    });
  }

  /**
   * A human-quotable code, inside `varchar(24)`: `CMP-<base36 ms>-<6
   * random>`. `booking.service.ts#generateReferenceCode`'s exact shape and
   * reasoning, with `COMPLAINT_REFERENCE_PREFIX` in place of `DRC` so a
   * complaint's ticket number is never mistaken for a booking's.
   * `reference_code` is UNIQUE, so a collision would surface as a `23505`
   * indistinguishable from any other — hence the pre-check and retry here
   * rather than relying on the catch.
   */
  private async generateReferenceCode(): Promise<string> {
    for (let attempt = 0; attempt < COMPLAINT_REFERENCE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const stamp = Date.now().toString(36).toUpperCase();
      const tail = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      const code = `${COMPLAINT_REFERENCE_PREFIX}-${stamp}-${tail}`;
      if (!(await this.repo.referenceCodeExists(code))) return code;
    }
    // 503, not 409: nothing about the request is wrong and there is nothing
    // for the caller to change — the server transiently could not allocate,
    // and retrying is exactly the right response.
    throw new ServiceUnavailableException({
      code: COMPLAINT_ERROR_CODES.REFERENCE_ALLOCATION_FAILED,
      message: 'Could not allocate a complaint reference. Please try again.',
    });
  }

  private consultationNotFound(): NotFoundException {
    return new NotFoundException({ code: COMPLAINT_ERROR_CODES.CONSULTATION_NOT_FOUND, message: 'Consultation not found.' });
  }

  private complaintNotFound(): NotFoundException {
    return new NotFoundException({ code: COMPLAINT_ERROR_CODES.COMPLAINT_NOT_FOUND, message: 'Complaint not found.' });
  }

  private illegalTransition(from: ComplaintStatus, to: ComplaintStatus): ConflictException {
    return new ConflictException({
      code: COMPLAINT_ERROR_CODES.ILLEGAL_TRANSITION,
      message: `Cannot move a complaint from '${from}' to '${to}'.`,
    });
  }
}

/**
 * `COMPLAINT_STATUS_TRANSITIONS[target]` read back down to the single
 * source every non-`open` entry names — the source of truth stays the
 * constant, not a literal re-typed at each call site (`assignComplaint`/
 * `resolveComplaint`/`rejectComplaint` above). Throws rather than returning
 * `undefined` for `open` (no source, by construction — see that constant's
 * header) or any future entry with more than one source, which would mean
 * this helper is no longer the right tool for that transition.
 */
function onlySource(target: ComplaintStatus): ComplaintStatus {
  const sources = COMPLAINT_STATUS_TRANSITIONS[target];
  if (sources.length !== 1) {
    throw new Error(`onlySource(${target}) expects exactly one legal source status, found ${sources.length}.`);
  }
  return sources[0];
}

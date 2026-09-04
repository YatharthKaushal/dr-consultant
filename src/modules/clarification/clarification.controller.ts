import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import {
  AddClarificationMessageDto,
  CreateClarificationCaseDto,
  ListClarificationCasesQueryDto,
  UpdateClarificationCaseDto,
} from './clarification.dto';
import { ClarificationService } from './clarification.service';

/**
 * The doctor-facing side of M-17 — both roles a `doctor` account can play:
 * the TREATING doctor posting and running their own cases (`/clarification-
 * cases`), and the EXPERT reading and responding to cases assigned to them
 * (`/clarification-cases/assigned`). There is no third, patient-facing
 * controller in this module, and that omission is deliberate — FR-12.7 and
 * `docs/MODULES.md`'s M-17 done-when both say "nothing reaches the patient
 * automatically", enforced here by simply never building a route a patient
 * account could call, not by adding a permission check to one that
 * shouldn't exist.
 *
 * Every route derives the doctor from `@CurrentUser()`, never a path or body
 * param — the same rule `booking.controller.ts` states for `patientId`. A
 * case that is not this doctor's (as treating doctor, or not assigned to
 * them as expert) returns the SAME 404 a stranger gets, so a doctor cannot
 * probe for another doctor's cases by id.
 */
@Controller('clarification-cases')
@AccountType('doctor')
export class ClarificationController {
  constructor(private readonly clarification: ClarificationService) {}

  /* ── The treating doctor's own cases ─────────────────────────────────── */

  /** FR-12.1/FR-12.3: creates a `draft`. See `CreateClarificationCaseDto`'s header for the de-identification guarantee this DTO's shape provides. */
  @Post()
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateClarificationCaseDto) {
    return this.clarification.createDraft(auth.accountId, dto);
  }

  /** Every case this doctor has posted or is drafting. */
  @Get()
  list(@CurrentUser() auth: AuthContext, @Query() query: ListClarificationCasesQueryDto) {
    return this.clarification.listOwnCases(auth.accountId, query);
  }

  /**
   * *** MUST STAY ABOVE `GET ':id'`. *** `assigned` would otherwise be parsed
   * as a `:id` path segment and reach `getOwnCase` instead — Nest/Express
   * route matching is registration-order-sensitive for a literal segment
   * colliding with a param segment on the same method.
   */
  @Get('assigned')
  listAssigned(@CurrentUser() auth: AuthContext, @Query() query: ListClarificationCasesQueryDto) {
    return this.clarification.listAssignedCases(auth.accountId, query);
  }

  /** One of this doctor's own cases, whatever `sourceConsultationId` is — this route IS the treating doctor's own audit view. */
  @Get(':id')
  getOne(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.clarification.getOwnCase(id, auth.accountId);
  }

  /** Edits a `draft` in place — refused once the case has been posted. */
  @Put(':id')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateClarificationCaseDto,
  ) {
    return this.clarification.updateDraft(id, auth.accountId, dto);
  }

  /** `draft` -> `posted`. `@HttpCode(OK)`: transitions a case that already exists rather than creating one. */
  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  post(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.clarification.postCase(id, auth.accountId);
  }

  /** `clarification_asked` -> `awaiting_response`: the treating doctor answers the expert's request for more information. */
  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  reply(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AddClarificationMessageDto,
  ) {
    return this.clarification.replyToClarification(id, auth.accountId, dto);
  }

  /** `response_received` -> `reviewed`. */
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  review(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.clarification.markReviewed(id, auth.accountId);
  }

  /** Any active status -> `closed`. FR-12.7: the treating doctor decides when a case is settled. */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.clarification.closeCase(id, auth.accountId);
  }

  /* ── The expert's assigned queue — CHECK #2 ──────────────────────────── */

  /**
   * *** THE DE-IDENTIFIED VIEW. *** One case assigned to this expert, or the
   * same 404 a stranger gets. Never `sourceConsultationId` — see
   * `clarification.mapper.ts#toClarificationCaseExpertView`.
   */
  @Get('assigned/:id')
  getAssigned(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.clarification.getAssignedCase(id, auth.accountId);
  }

  /** FR-12.5: the expert's reply — comment, clinical consideration, request for clarification, or follow-up advice, in one message. */
  @Post('assigned/:id/respond')
  @HttpCode(HttpStatus.OK)
  respond(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AddClarificationMessageDto,
  ) {
    return this.clarification.respondAsExpert(id, auth.accountId, dto);
  }
}

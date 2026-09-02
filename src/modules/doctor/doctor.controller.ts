import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { DoctorDocumentService } from './doctor-document.service';
import { CreateDoctorDocumentDto, UpdateOwnDoctorProfileDto } from './doctor.dto';
import { DoctorService } from './doctor.service';

/**
 * No logic here — parse, authorise via decorators, delegate. Route order
 * matters: the literal `me`/`me/documents` routes are declared before the
 * `:id` route so they aren't swallowed by it.
 *
 * Class-level `@AccountType('patient', 'doctor', 'admin')`: every route
 * below narrows it with its own method-level `@AccountType('doctor')` except
 * `GET :id`, which is intentionally left at the class-level "any
 * authenticated account type" default — method-level decorators override
 * class-level ones (`AccountTypeGuard` reads via `getAllAndOverride`, handler
 * first), so this is purely a clarity fix with no behavior change; mirrors
 * `specialty.controller.ts`, which expresses the identical policy the same
 * way.
 */
@Controller('doctors')
@AccountType('patient', 'doctor', 'admin')
export class DoctorController {
  constructor(
    private readonly doctorService: DoctorService,
    private readonly documentService: DoctorDocumentService,
  ) {}

  @Get('me')
  @AccountType('doctor')
  getOwnProfile(@CurrentUser() auth: AuthContext) {
    return this.doctorService.getOwnProfile(auth.accountId);
  }

  @Patch('me')
  @AccountType('doctor')
  updateOwnProfile(@CurrentUser() auth: AuthContext, @Body() dto: UpdateOwnDoctorProfileDto) {
    return this.doctorService.updateOwnProfile(auth.accountId, dto);
  }

  @Post('me/documents')
  @AccountType('doctor')
  createOwnDocument(@CurrentUser() auth: AuthContext, @Body() dto: CreateDoctorDocumentDto) {
    return this.documentService.createForDoctor(auth.accountId, dto);
  }

  @Get('me/documents')
  @AccountType('doctor')
  listOwnDocuments(@CurrentUser() auth: AuthContext) {
    return this.documentService.listForDoctor(auth.accountId);
  }

  /**
   * Any authenticated account type. Visible only when the doctor is
   * `verified` and `isListed` (or the caller is an admin) — 404, never 403,
   * for a doctor that exists but isn't visible to this caller.
   */
  @Get(':id')
  getListedProfile(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.doctorService.getListedProfileForCaller(id, auth);
  }
}

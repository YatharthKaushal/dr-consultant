import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { DoctorDocumentService } from './doctor-document.service';
import { CreateDoctorDocumentDto, UpdateOwnDoctorProfileDto } from './doctor.dto';
import { DoctorService } from './doctor.service';

/**
 * No logic here — parse, authorise via decorators, delegate. Route order
 * matters: the literal `me`/`me/documents` routes are declared before the
 * `:id` route so they aren't swallowed by it.
 */
@Controller('doctors')
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
  getListedProfile(@CurrentUser() auth: AuthContext, @Param('id') id: string) {
    return this.doctorService.getListedProfileForCaller(id, auth);
  }
}

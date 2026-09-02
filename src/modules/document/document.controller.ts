import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { ListOwnDocumentsQueryDto } from './document.dto';
import { parseSingleFileRequest } from './multipart-file.util';
import { PatientFileService } from './patient-file.service';
import { ReportRequestService } from './report-request.service';

/**
 * Patient self-service: upload, list own, download, delete, and see own
 * report requests. Every route is `@AccountType('patient')` and derives
 * identity from `@CurrentUser()` — NEVER a path/body param — except
 * `download`, which overrides the class-level restriction because a
 * treating doctor and an admin can also reach it (`AccountTypeGuard` uses
 * `getAllAndOverride`, so a method-level `@AccountType(...)` replaces, not
 * adds to, the class-level one). No logic here — parse, delegate; every rule
 * lives in `patient-file.service.ts`/`report-request.service.ts`.
 */
@Controller('documents')
@AccountType('patient')
export class DocumentController {
  constructor(
    private readonly files: PatientFileService,
    private readonly reportRequests: ReportRequestService,
  ) {}

  @Post()
  async upload(@CurrentUser() auth: AuthContext, @Req() request: FastifyRequest) {
    const parsed = await parseSingleFileRequest(request);
    return this.files.upload(auth.accountId, {
      category: parsed.fields.category ?? '',
      consultationId: parsed.fields.consultationId || undefined,
      reportRequestId: parsed.fields.reportRequestId || undefined,
      buffer: parsed.buffer,
      fileName: parsed.fileName,
      contentType: parsed.contentType,
      sizeBytes: parsed.sizeBytes,
    });
  }

  @Get('me')
  listOwn(@CurrentUser() auth: AuthContext, @Query() query: ListOwnDocumentsQueryDto) {
    return this.files.listOwn(auth.accountId, query.category);
  }

  /** Patient owner, treating doctor (any consultation with this patient), or admin — see `patient-file.service.ts#getDownloadUrl`. */
  @Get(':id/download')
  @AccountType('patient', 'doctor', 'admin')
  getDownloadUrl(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.files.getDownloadUrl(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOwn(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string): Promise<void> {
    await this.files.deleteOwn(auth.accountId, id);
  }

  /** The patient's own report requests (open and otherwise), derived via their own consultations — there is no `report_requests.patient_id` column. */
  @Get('report-requests/me')
  listOwnReportRequests(@CurrentUser() auth: AuthContext) {
    return this.reportRequests.listOwnAcrossConsultations(auth.accountId);
  }
}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CreateLegalDocumentDto, ListLegalDocumentsQueryDto } from './legal-document-admin.dto';
import { LegalDocumentService } from './legal-document.service';

/**
 * Admin management of legal documents, gated by the EXISTING
 * `compliance.manage_legal_documents` permission — the catalogue already names
 * it "Publish a new version of a legal document", and M-03 adds no permission
 * of its own. The history reads sit behind the same key because the catalogue
 * has no separate compliance-read permission, and inventing one would be adding
 * a permission by another name.
 *
 * There is no PATCH and no DELETE: a version is written once and only its
 * `is_current` flag ever changes (`legal-document.service.ts`).
 */
@Controller('admin/legal-documents')
@AccountType('admin')
export class LegalDocumentAdminController {
  constructor(private readonly service: LegalDocumentService) {}

  /** The version history, newest first, optionally narrowed to one type. */
  @Get()
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_LEGAL_DOCUMENTS)
  list(@Query() query: ListLegalDocumentsQueryDto) {
    return this.service.adminList(query.documentType);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_LEGAL_DOCUMENTS)
  getDetail(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.adminGetById(id);
  }

  /** Writes a new version. `publish: true` makes it current in the same transaction. */
  @Post()
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_LEGAL_DOCUMENTS)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateLegalDocumentDto) {
    return this.service.adminCreate(auth.accountId, dto);
  }

  /** Makes an existing version the current one for its type, demoting the previous. */
  @Post(':id/publish')
  @RequirePermission(PERMISSIONS.COMPLIANCE_MANAGE_LEGAL_DOCUMENTS)
  publish(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.adminPublish(auth.accountId, id);
  }
}

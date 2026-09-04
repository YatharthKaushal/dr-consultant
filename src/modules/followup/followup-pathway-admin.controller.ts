import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CreatePathwayVersionDto } from './followup.dto';
import { FollowupPathwayService } from './followup-pathway.service';

/**
 * FR-13.7's admin editor — question sets and red-flag rules, configurable
 * with no app release. Gated on `content.manage_followup_questions`, held
 * only by `clinical_governance` (`permission.catalog.ts`).
 */
@Controller('admin/followup-pathways')
@AccountType('admin')
export class FollowupPathwayAdminController {
  constructor(private readonly pathways: FollowupPathwayService) {}

  /** One row per pathway code — its current version, or (if never published) its highest. */
  @Get()
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS)
  listLatest() {
    return this.pathways.adminListLatest();
  }

  /** Declared before `:id` — a literal segment first, matching `booking-admin.controller.ts#listResolutionQueue`'s convention, so this never gets swallowed by the `:id` route below. */
  @Get('by-code/:code/versions')
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS)
  listVersions(@Param('code') code: string) {
    return this.pathways.adminListVersions(code);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS)
  getById(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.pathways.adminGetById(id);
  }

  /** Writes a new version; `publish: true` makes it current in the same request — see `followup-pathway.service.ts#adminCreateVersion`. */
  @Post()
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreatePathwayVersionDto) {
    return this.pathways.adminCreateVersion(auth.accountId, {
      code: dto.code,
      name: dto.name,
      version: dto.version,
      durationDays: dto.durationDays,
      questions: dto.questions,
      redFlagRules: dto.redFlagRules,
      publish: dto.publish ?? false,
    });
  }

  /** Makes one existing version current for its code. `@HttpCode(OK)`: this transitions a version that already exists rather than creating one. */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_FOLLOWUP_QUESTIONS)
  publish(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.pathways.adminPublish(auth.accountId, id);
  }
}

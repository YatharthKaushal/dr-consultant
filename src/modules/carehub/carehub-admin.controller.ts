import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { CreateContentItemDto, ListAdminContentQueryDto, UpdateContentItemDto } from './carehub.dto';
import { CarehubService } from './carehub.service';

/**
 * FR-18.7's "content management... self-help resources, education library,
 * blogs, NGO directory" — admin authoring and the clinical review workflow.
 * FR-18.7 is satisfied structurally, not by a special mechanism: this is
 * rows in a table an admin edits through this API, so "reaches the app with
 * no release" is just what a normal read already does.
 *
 * `content.read`/`content.author`/`content.publish` have existed in
 * `permission.catalog.ts` since M-01, bundled to `content`/
 * `clinical_governance`/`super_admin`, and were unused until this controller.
 *
 * *** WHY SIX TRANSITION ROUTES, NOT ONE GENERIC ONE. *** A single
 * `POST /:id/transition { to }` route would need a DIFFERENT permission
 * depending on which move was requested — `content.publish` only for moving
 * INTO or OUT OF `published` (the two moves that change what a patient can
 * see), `content.author` for everything else — and this codebase's
 * `@RequirePermission` is a static, per-route decorator with no precedent
 * anywhere of branching permission by request body (see every other
 * `*-admin.controller.ts`). Six named actions, one decorator each, keeps
 * that convention and keeps the risk boundary exactly where
 * `carehub.constants.ts`'s `CONTENT_REVIEW_STATUS_TRANSITIONS` documents it.
 */
@Controller('admin/care-hub/content')
@AccountType('admin')
export class CarehubAdminController {
  constructor(private readonly carehub: CarehubService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CONTENT_READ)
  list(@Query() query: ListAdminContentQueryDto) {
    return this.carehub.listForAdmin(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CONTENT_READ)
  get(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.getForAdmin(id);
  }

  /** Always lands as `draft` — see `CreateContentItemDto`'s own doc comment. */
  @Post()
  @RequirePermission(PERMISSIONS.CONTENT_AUTHOR)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateContentItemDto) {
    return this.carehub.create(dto, auth.accountId);
  }

  /** A patch — editable at any review status, including `published`; see `carehub.service.ts`'s class doc comment on why an edit does not re-trigger review. */
  @Put(':id')
  @RequirePermission(PERMISSIONS.CONTENT_AUTHOR)
  update(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: UpdateContentItemDto) {
    return this.carehub.update(id, dto, auth.accountId);
  }

  /** `draft -> in_clinical_review`. */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_AUTHOR)
  submit(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.submitForReview(id, auth.accountId);
  }

  /** *** THE CLINICAL REVIEWER'S SIGN-OFF (`reviewedByAdminId`/`reviewedAt`). *** `in_clinical_review -> published`. */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_PUBLISH)
  publish(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.publish(id, auth.accountId);
  }

  /** The reviewer sends it back for changes. `in_clinical_review -> draft`. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_PUBLISH)
  reject(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.reject(id, auth.accountId);
  }

  /** The author discards a draft or an in-review submission that never went live. `{draft, in_clinical_review} -> archived`. */
  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_AUTHOR)
  withdraw(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.withdraw(id, auth.accountId);
  }

  /** Takes live content down. `published -> archived`. */
  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_PUBLISH)
  retire(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.retire(id, auth.accountId);
  }

  /** Revives a retired item for editing. `archived -> draft`. */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CONTENT_AUTHOR)
  restore(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.carehub.restore(id, auth.accountId);
  }
}

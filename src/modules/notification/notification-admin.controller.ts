import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { NotificationTemplateCodeParamDto, UpsertNotificationTemplateDto } from './notification-admin.dto';
import { NotificationTemplateService } from './notification-template.service';

/**
 * FR-16.3 — "notification copy is editable from the admin panel" — and
 * FR-18.7's content management, which lists "notification copy" among what
 * the content role owns. M-08's done-when: "copy changes need no app
 * release."
 *
 * *** THE PERMISSION ALREADY EXISTS. *** `content.manage_notification_
 * templates` is in `permission.catalog.ts`, described there as "Edit
 * notification copy", and already bundled to the `content` role ("Authors
 * Care Hub content and notification copy"). M-08 adds no permission — it uses
 * the one the catalogue was written for.
 *
 * Deliberately NOT `content.author`/`content.publish`: those mirror
 * `content_review_status`'s draft -> review -> published machine for Care Hub
 * articles. Notification copy has no review workflow and no publish step; it
 * takes effect on the next send, which is why it has its own permission in
 * the catalogue in the first place.
 *
 * No logic here — parse, authorise, delegate. Every rule, including FR-16.2,
 * lives in `notification-template.service.ts`.
 */
@Controller('admin/notifications')
@AccountType('admin')
export class NotificationAdminController {
  constructor(private readonly templates: NotificationTemplateService) {}

  /**
   * Every template in force, with its provenance (`default` vs `custom`) and
   * the placeholders its copy declares.
   *
   * Resolved, not raw: the panel shows what notifications ACTUALLY say,
   * including the seven compiled-in defaults nobody has edited, rather than
   * only the rows that happen to exist. Same choice `GET /admin/search/config`
   * makes.
   */
  @Get('templates')
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_NOTIFICATION_TEMPLATES)
  listTemplates() {
    return this.templates.listForAdmin();
  }

  /**
   * Saves the copy for one template code, writing an audited before/after and
   * invalidating the 30-second config memo.
   *
   * Refused with 409 `NOTIFICATION_TEMPLATE_NAMES_DIAGNOSIS` if the copy
   * names a diagnosis (FR-16.2). The message names the offending
   * construction, so the admin can re-word rather than guess.
   */
  @Put('templates/:code')
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_NOTIFICATION_TEMPLATES)
  upsertTemplate(
    @CurrentUser() auth: AuthContext,
    @Param() params: NotificationTemplateCodeParamDto,
    @Body() dto: UpsertNotificationTemplateDto,
  ) {
    return this.templates.upsertTemplate(auth.accountId, params.code, { title: dto.title, body: dto.body });
  }

  /**
   * Drops the admin-edited copy for one code. For one of the nine codes the
   * schema names this is a REVERT to the compiled-in default (which comes
   * back in the response); for a code an admin added it is a delete.
   */
  @Delete('templates/:code')
  @RequirePermission(PERMISSIONS.CONTENT_MANAGE_NOTIFICATION_TEMPLATES)
  deleteTemplate(@CurrentUser() auth: AuthContext, @Param() params: NotificationTemplateCodeParamDto) {
    return this.templates.deleteTemplate(auth.accountId, params.code);
  }
}

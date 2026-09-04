import { Controller, Get, Query } from '@nestjs/common';
import { AccountType, RequirePermission } from '../../shared/auth/auth.decorator';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { ListFeedbackQueryDto } from './feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * FR-18.8's feedback half: "patient feedback review". Gated on
 * `feedback.read` — a permission `permission.catalog.ts` already seeded
 * (bundled to `super_admin`, `operations`, `clinical_governance`,
 * `care_coordinator` and `content`) with no controller using it until now,
 * the same "a permission nothing checks is a promise nobody keeps" finding
 * `clinical-admin.controller.ts` and `clarification-admin.controller.ts`
 * both state for their own permissions.
 */
@Controller('admin/feedback')
@AccountType('admin')
export class FeedbackAdminController {
  constructor(private readonly feedback: FeedbackService) {}

  /** FR-18.8: filterable by rating and by date. */
  @Get()
  @RequirePermission(PERMISSIONS.FEEDBACK_READ)
  list(@Query() query: ListFeedbackQueryDto) {
    return this.feedback.listForAdmin(query);
  }
}

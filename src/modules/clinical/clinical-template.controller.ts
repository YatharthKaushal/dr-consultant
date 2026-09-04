import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { ListClinicalTemplatesQueryDto, SaveClinicalTemplateDto } from './clinical.dto';
import { ClinicalTemplateService } from './clinical-template.service';

/**
 * FR-9.6's reusable prescription/advice templates, doctor self-service.
 *
 * Prefix is `doctors/me/clinical-templates`, following
 * `booking-doctor.controller.ts`'s `doctors/me/bookings` — the doctor id is
 * never a path param, always `@CurrentUser()`. The `clinical-templates` segment
 * is shared with nothing: `availability.controller.ts` owns `availability/...`
 * and `slots` under `doctors/me`, `instant-doctor.controller.ts` owns
 * `presence`, `stream`, `instant-requests/...` and `instant-consults/...`, and
 * `booking-doctor.controller.ts` owns `bookings`.
 *
 * Ownership is enforced in SQL, not by a check above it: every repository
 * method carries `doctor_id = $currentUser` in its WHERE clause, so there is no
 * "find by id" that could return another doctor's template for a check to then
 * reject. Unknown and not-yours produce the identical 404.
 */
@Controller('doctors/me/clinical-templates')
@AccountType('doctor')
export class ClinicalTemplateController {
  constructor(private readonly templates: ClinicalTemplateService) {}

  /** The picker. `updated_at desc` — most recently touched first; see the repository for why there is no usage counter. */
  @Get()
  list(@CurrentUser() auth: AuthContext, @Query() query: ListClinicalTemplatesQueryDto) {
    return this.templates.listOwn(auth.accountId, query.specialtyId);
  }

  @Get(':id')
  get(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.templates.getOwn(id, auth.accountId);
  }

  /** 201, the Nest default, and correctly so: this creates a row. */
  @Post()
  create(@CurrentUser() auth: AuthContext, @Body() dto: SaveClinicalTemplateDto) {
    return this.templates.create(auth.accountId, dto);
  }

  /** `PUT`: the body is the complete template, so an omitted field is cleared. Same convention as the clinical record itself. */
  @Put(':id')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: SaveClinicalTemplateDto,
  ) {
    return this.templates.update(id, auth.accountId, dto);
  }

  /** Hard delete — applying a template is a copy, so nothing references the row (`doctor-clinical-templates.schema.ts`). */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string): Promise<void> {
    await this.templates.remove(id, auth.accountId);
  }
}

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { RaiseDataDeletionRequestDto } from './data-deletion.dto';
import { DataDeletionService } from './data-deletion.service';

/**
 * FR-2.5, the patient side: raise a request, and see its status. No logic
 * here — parse, authorise via decorators, delegate — same discipline
 * `ConsentController` states for itself.
 *
 * Every route derives the patient from `@CurrentUser()`, never a path or body
 * param, so a patient cannot raise or read a request in somebody else's name.
 */
@Controller('data-deletion-requests')
@AccountType('patient')
export class DataDeletionController {
  constructor(private readonly service: DataDeletionService) {}

  /** Raises a request, or returns the caller's already-open one — see `DataDeletionService#raiseRequest`. */
  @Post()
  raise(@CurrentUser() auth: AuthContext, @Body() dto: RaiseDataDeletionRequestDto) {
    return this.service.raiseRequest(auth.accountId, dto.reason ?? null);
  }

  /** The caller's own request history. */
  @Get()
  listOwn(@CurrentUser() auth: AuthContext) {
    return this.service.listOwnRequests(auth.accountId);
  }

  /** One of the caller's own requests. 404, not 403, on a mismatch — nothing here reveals another patient's request exists. */
  @Get(':id')
  getOwn(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.getOwnRequest(auth.accountId, id);
  }
}

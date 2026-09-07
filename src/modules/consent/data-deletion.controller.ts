import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { RaiseDataDeletionRequestDto } from './data-deletion.dto';
import { DataDeletionService } from './data-deletion.service';
import type { DeletionAccountRef } from './data-deletion.types';

/**
 * FR-2.5, the patient/doctor side: raise a request, see its status, cancel
 * it. No logic here — parse, authorise via decorators, delegate — same
 * discipline `ConsentController` states for itself.
 *
 * *** WIDENED FROM PATIENT-ONLY (account-deletion lifecycle round). ***
 * `@AccountType('patient','doctor')` — a doctor's own account-deletion page
 * needs the identical request/status/cancel surface, and `auth.accountType`
 * is what turns `@CurrentUser()` into the right `DeletionAccountRef` below,
 * never a body or path param — a caller cannot raise, read or cancel a
 * request in somebody else's name.
 */
@Controller('data-deletion-requests')
@AccountType('patient', 'doctor')
export class DataDeletionController {
  constructor(private readonly service: DataDeletionService) {}

  /** Raises a request, or returns the caller's already-open one — see `DataDeletionService#raiseRequest`. */
  @Post()
  raise(@CurrentUser() auth: AuthContext, @Body() dto: RaiseDataDeletionRequestDto) {
    return this.service.raiseRequest(this.toAccountRef(auth), dto.reason ?? null);
  }

  /** The caller's own request history. */
  @Get()
  listOwn(@CurrentUser() auth: AuthContext) {
    return this.service.listOwnRequests(this.toAccountRef(auth));
  }

  /** One of the caller's own requests. 404, not 403, on a mismatch — nothing here reveals another account's request exists. */
  @Get(':id')
  getOwn(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.getOwnRequest(this.toAccountRef(auth), id);
  }

  /**
   * *** THE "CANCEL DELETION" OPTION. *** State-changing on an existing
   * resource, not a creation — `@HttpCode(200)`, matching
   * `video.controller.ts#issueToken`'s own reasoning for the same choice.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.service.cancelRequest(this.toAccountRef(auth), id);
  }

  private toAccountRef(auth: AuthContext): DeletionAccountRef {
    // `@AccountType('patient','doctor')` on this whole controller is what
    // guarantees `auth.accountType` is never `'admin'` here — the cast is
    // narrowing a value the guard has already restricted, not asserting
    // past it.
    return { accountType: auth.accountType as 'patient' | 'doctor', accountId: auth.accountId };
  }
}

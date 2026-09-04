import { Controller, Get, Param } from '@nestjs/common';
import { Public } from '../../shared/auth/auth.decorator';
import { CarehubService } from './carehub.service';

/**
 * *** THE ONLY UNAUTHENTICATED ROUTE THIS MODULE HAS. ***
 *
 * A separate controller, with NO class-level `@AccountType`, for exactly the
 * reason `promotion-link.controller.ts` gives for its own: `AccountTypeGuard`
 * reads `@AccountType` off the handler OR THE CLASS, so a `@Public()` handler
 * inside a class that carries a class-level `@AccountType('patient')` would
 * still be rejected — it has no `request.auth`, and the class-level
 * requirement still applies. A controller with no class-level account type
 * is the local, zero-risk expression of "this route needs no token."
 *
 * The caregiver who receives a shared link (FR-15.5) has no account in this
 * backend at all, so this is the one place the module's whole public surface
 * has to be reachable with nothing but the token itself.
 */
@Controller('care-hub/shared')
export class CarehubShareController {
  constructor(private readonly carehub: CarehubService) {}

  @Public()
  @Get(':token')
  resolve(@Param('token') token: string) {
    return this.carehub.resolveSharedContent(token);
  }
}

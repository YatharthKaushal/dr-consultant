import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../../shared/auth/auth.decorator';
import { ReleaseStatusQueryDto } from './release.dto';
import { ReleaseService } from './release.service';

/**
 * A separate controller, with NO class-level `@AccountType` — same reasoning
 * `carehub-share.controller.ts`'s header states for its own public route:
 * `AccountTypeGuard` reads `@AccountType` off the handler OR THE CLASS, so a
 * `@Public()` handler inside a class that also carried a class-level
 * `@AccountType` would still be rejected.
 *
 * This route must be reachable by an app build old enough to predate
 * sign-in working at all, and by a user who is not signed in yet — so it
 * carries no token requirement whatsoever.
 */
@Controller('app')
export class ReleaseController {
  constructor(private readonly release: ReleaseService) {}

  @Public()
  @Get('release-status')
  getReleaseStatus(@Query() query: ReleaseStatusQueryDto) {
    return this.release.getReleaseStatus(query);
  }
}

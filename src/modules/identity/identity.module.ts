import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AUTH_CONTEXT_RESOLVER } from '../../shared/auth/auth.constants';
import { IdentityAccessRepository } from './identity-access.repository';
import { IdentityAccessService } from './identity-access.service';
import { IdentityAdminController } from './identity-admin.controller';
import { IdentityAuthContextService } from './identity-auth-context.service';
import { IdentityController } from './identity.controller';
import { IdentityFacade } from './identity.facade';
import { IdentityOtpService } from './identity-otp.service';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';
import { IdentityTokenService } from './identity-token.service';

/**
 * `@Global()` because the `APP_GUARD`s in `shared/auth/auth.module.ts`
 * resolve `AUTH_CONTEXT_RESOLVER` from this module.
 *
 * `JwtModule.register({})` with no global secret: access and refresh tokens
 * use two different secrets (see `env.validation.ts`), and every sign/verify
 * call in `identity-token.service.ts` passes its own `secret`/`expiresIn` —
 * a module-wide default would never be used and would invite someone to
 * "simplify" it into the wrong single-secret scheme later.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [IdentityController, IdentityAdminController],
  providers: [
    IdentityRepository,
    IdentityAccessRepository,
    IdentityOtpService,
    IdentityTokenService,
    IdentityAccessService,
    IdentityAuthContextService,
    IdentityService,
    IdentityFacade,
    { provide: AUTH_CONTEXT_RESOLVER, useExisting: IdentityAuthContextService },
  ],
  exports: [AUTH_CONTEXT_RESOLVER, IdentityFacade],
})
export class IdentityModule {}

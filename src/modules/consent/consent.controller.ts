import { Body, Controller, ForbiddenException, Get, Ip, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { CONSENT_ERROR_CODES } from './consent.constants';
import { ConsentStatusQueryDto, RecordConsentDto } from './consent.dto';
import { ConsentService, type ConsentActorType } from './consent.service';

/**
 * Narrows `AuthContext.accountType` to the two types that can accept a
 * document. `@AccountType('patient', 'doctor')` already rejects everything
 * else at the guard, so the throw is unreachable — it exists because the guard
 * is metadata TypeScript cannot see, and silently defaulting an admin to
 * "patient" would write a consent row attributing a patient's acceptance to an
 * admin's account id.
 */
function actorTypeOf(auth: AuthContext): ConsentActorType {
  if (auth.accountType === 'patient' || auth.accountType === 'doctor') return auth.accountType;
  throw new ForbiddenException({
    code: CONSENT_ERROR_CODES.DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR,
    message: 'Only a patient or a doctor can accept a legal document.',
  });
}

/**
 * FR-2.3. No logic here — parse, authorise via decorators, delegate.
 *
 * `@Ip()` is the same source `identity.controller.ts` uses; the value lands in
 * `consents.ip_address`, which the schema calls "the legal evidence of
 * acceptance" and which is kept nowhere else on an account.
 */
@Controller('consents')
@AccountType('patient', 'doctor')
export class ConsentController {
  constructor(private readonly service: ConsentService) {}

  /** Accept one exact version. Idempotent per (account, version). */
  @Post()
  record(@CurrentUser() auth: AuthContext, @Body() dto: RecordConsentDto, @Ip() ip: string) {
    return this.service.recordConsent(actorTypeOf(auth), auth.accountId, dto.legalDocumentId, ip || null);
  }

  /** The caller's own consent history — every version they accepted, and when. */
  @Get('me')
  listOwn(@CurrentUser() auth: AuthContext) {
    return this.service.listOwnConsents(actorTypeOf(auth), auth.accountId);
  }

  /**
   * What the pre-consult screen asks: have I accepted the CURRENT version, and
   * if not, which one did I accept? Patient-only — it is the patient-side
   * question, and `ConsentCheck` is defined for a patient.
   *
   * Unlike the facade, this read propagates a failure: an operator debugging a
   * blocked patient needs the real error, and this path gates nothing.
   */
  @Get('status')
  @AccountType('patient')
  status(@CurrentUser() auth: AuthContext, @Query() query: ConsentStatusQueryDto) {
    return this.service.checkPatientConsent(auth.accountId, query.documentType);
  }
}

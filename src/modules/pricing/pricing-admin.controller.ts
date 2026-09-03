import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { PricingConfigService } from './pricing-config.service';
import { PricingFacade } from './pricing.facade';
import { PreviewQuoteDto, UpdatePricingConfigDto } from './pricing-admin.dto';
import {
  SELECTABLE_GST_STATE_CODES,
  suggestStateCodeForPincode,
} from './pricing-gst.constants';

/**
 * The admin panel's pricing surface.
 *
 * *** ONE PERMISSION, AND NO NEW ONE. ***
 *
 * Every route here is gated on `payments.manage_config`, which already exists
 * and is already bundled into the `finance` role. No permission is added.
 *
 * `payment-admin.controller.ts` records why that constraint is real: "the brief
 * fixes the permission set at the existing 52", and it declined to add a
 * `payments.payout` key for the same reason. THIS SCREEN REPLACES THE
 * CONVENIENCE-FEE/GST SCREEN — it is the same job (deciding what a patient is
 * charged) done through a model that can express per-component tax treatment —
 * so it is the same permission. Only that permission's DESCRIPTION changes, to
 * name what it now actually governs.
 *
 * The old `PUT /admin/payments/config` still exists and now THROWS
 * `PAYMENT_CONFIG_SUPERSEDED` once a pricing catalogue is configured, naming
 * this screen. An admin editing a GST rate and watching nothing change is a
 * guaranteed support incident; its READ path is kept for legacy re-derivation.
 */
@Controller('admin/pricing')
@AccountType('admin')
export class PricingAdminController {
  constructor(
    private readonly config: PricingConfigService,
    private readonly pricing: PricingFacade,
  ) {}

  /**
   * The catalogue, tax profile and TTL actually in force — each resolved against
   * its compiled-in fallback, so the panel shows what is BILLED rather than just
   * what has a row.
   *
   * `componentsFellBack` / `taxProfileFellBack` are surfaced deliberately:
   * billing at the documented default is defensible, billing at it SILENTLY is
   * not, and an admin needs to see that their catalogue was rejected.
   */
  @Get('config')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  getConfig() {
    return this.config.getResolved();
  }

  /**
   * Edits the component catalogue, the tax profile or the quote TTL.
   *
   * Each changed key writes its own audited before/after, transactionally, and
   * invalidates the config memo. The catalogue is validated by the ENGINE'S OWN
   * validator, so this screen can never accept a catalogue the pricing path then
   * refuses at checkout.
   */
  @Put('config')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  updateConfig(@CurrentUser() auth: AuthContext, @Body() dto: UpdatePricingConfigDto) {
    return this.config.update(auth.accountId, {
      components: dto.components,
      taxProfile: dto.taxProfile,
      quoteTtlMinutes: dto.quoteTtlMinutes,
    });
  }

  /**
   * Prices a bill without persisting anything, so an admin can see what a
   * catalogue change actually does to a patient's total before trusting it.
   *
   * This is the same engine and the same code path checkout uses — not a
   * re-implementation for the panel, which is how a preview screen comes to
   * disagree with the bill it is previewing.
   */
  @Post('preview')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  preview(@Body() dto: PreviewQuoteDto) {
    return this.pricing.preview({
      consultationFeeInr: dto.consultationFeeInr,
      placeOfSupplyStateCode: dto.placeOfSupplyStateCode,
      placeOfSupplyPincode: dto.placeOfSupplyPincode ?? null,
      discountCode: dto.discountCode ?? null,
    });
  }

  /**
   * The GST state codes a place of supply may be set to.
   *
   * *** READ-ONLY, AND COMPILED IN. *** There is deliberately no write route.
   * A state code is an identifier defined by the GST portal and printed on a
   * statutory invoice, not a preference — an admin who invents code 99 produces
   * an invoice that is invalid, silently, on every bill. Merged and obsolete
   * codes are excluded here and still resolvable when RENDERING an old quote.
   * See `pricing-gst.constants.ts`, which also flags the codes public sources
   * disagree on and which the client's CA must confirm.
   */
  @Get('state-codes')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  listStateCodes() {
    return { states: SELECTABLE_GST_STATE_CODES };
  }

  /**
   * A SUGGESTED state for a PIN code.
   *
   * *** NON-AUTHORITATIVE, AND THE RESPONSE SAYS SO. *** The mapping is by
   * postal circle, which is close to a state boundary but not identical to one.
   * It exists to pre-select a dropdown the user can override; the confirmed
   * `stateCode` is what is stored and what decides the tax. `null` is a normal
   * answer, not an error.
   */
  @Get('state-for-pincode')
  @RequirePermission(PERMISSIONS.PAYMENTS_MANAGE_CONFIG)
  suggestState(@Query('pincode') pincode?: string) {
    const suggestion = typeof pincode === 'string' ? suggestStateCodeForPincode(pincode) : null;
    return {
      pincode: pincode ?? null,
      suggestedStateCode: suggestion,
      authoritative: false,
      note: 'A suggestion only. The state code the user confirms is what decides the tax.',
    };
  }
}

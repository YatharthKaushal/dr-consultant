import { Injectable } from '@nestjs/common';
import type { CreatedOrder, PaymentBreakdown, PaymentContract } from './payment.contract';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';

/**
 * M-12's only public surface (`backend/README.md` §2). Thin by design — every
 * rule lives in `PaymentService` and `RefundService`, and this class exists to
 * be the one type another module imports, so swapping the local implementation
 * for a TCP client later changes nothing at any call site. Mirrors
 * `StorageFacade` and `AiFacade`.
 *
 * *** M-11 (booking) IS BEING BUILT AGAINST `PaymentContract` IN A PARALLEL
 * WORKTREE. *** `implements PaymentContract` is what makes that safe: a
 * signature drift on either side surfaces here as a `tsc` error rather than as
 * a runtime surprise after both are merged.
 *
 * `createRefund` is exposed here specifically so M-11 can raise the automatic
 * in-policy refund on a cancellation. M-12 does NOT implement cancellation and
 * does not decide policy — see `refund.service.ts` for the agreed split and
 * for why it deviates from FR-7.7 read literally.
 */
@Injectable()
export class PaymentFacade implements PaymentContract {
  constructor(
    private readonly payments: PaymentService,
    private readonly refunds: RefundService,
  ) {}

  async quote(consultationFeeInr: string): Promise<PaymentBreakdown> {
    return this.payments.quote(consultationFeeInr);
  }

  async createOrderForConsultation(input: {
    consultationId: string;
    consultationFeeInr: string;
  }): Promise<CreatedOrder> {
    return this.payments.createOrderForConsultation(input);
  }

  async getByConsultationId(
    consultationId: string,
  ): Promise<{ paymentId: string; status: string; paidAt: Date | null } | null> {
    return this.payments.getByConsultationId(consultationId);
  }

  /** The handles a patient needs to OPEN checkout on an existing unpaid payment — `null` when there is nothing to pay. See `PaymentContract`. */
  async getCheckoutHandles(consultationId: string): Promise<CreatedOrder | null> {
    return this.payments.getCheckoutHandles(consultationId);
  }

  async reconcileWithGateway(paymentId: string): Promise<{ status: string; changed: boolean }> {
    return this.payments.reconcileWithGateway(paymentId);
  }

  /**
   * *** `refundPct` IS DECLARED HERE ON PURPOSE. ***
   *
   * It was absent, and booking's calls carrying it worked only because this
   * method forwards its argument OBJECT BY REFERENCE — a property the parameter
   * type did not mention reached `RefundService` regardless. Rewriting this body
   * as an explicit destructure, which reads like a tidy-up, would have dropped
   * the field that redefines the refund base and silently reverted live
   * cancellations to a percentage of the consultation fee. See
   * `PaymentContract.createRefund`.
   */
  async createRefund(input: {
    paymentId: string;
    amount: string;
    reason: string;
    initiatedByAdminId: string | null;
    isAutomatic: boolean;
    /** Percent of the CAPTURED TOTAL. Commercial change — see `PaymentContract.createRefund`. */
    refundPct?: number;
  }): Promise<{ refundId: string; status: string }> {
    return this.refunds.createRefund(input);
  }
}

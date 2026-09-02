import { Module } from '@nestjs/common';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentAdminService } from './payment-admin.service';
import { PaymentConfigRepository } from './payment-config.repository';
import { PaymentConfigService } from './payment-config.service';
import { PaymentEventRepository } from './payment-event.repository';
import { PaymentFacade } from './payment.facade';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { RazorpayClient } from './razorpay.client';
import { RefundRepository } from './refund.repository';
import { RefundService } from './refund.service';

/**
 * M-12, Payments and Billing.
 *
 * NOT `@Global()` — like `SearchModule`/`DoctorModule`/`StorageModule`,
 * nothing outside this module resolves a DI token from here; M-11 consumes
 * `PaymentFacade` by importing `PaymentModule` and injecting it normally.
 *
 * NO `imports`. `DATABASE`, `AuditService` and `AppConfigService` are all
 * `@Global()`, and this module depends on no other feature module —
 * `docs/MODULES.md` lists M-12 as depending on M-05 and M-11, but the
 * dependency runs the OTHER way at the code level: booking calls payments, not
 * the reverse. `createOrderForConsultation` takes the consultation id and the
 * fee as ARGUMENTS rather than looking either up, which is what keeps this
 * module free of a `DoctorModule`/`BookingModule` import and free of a
 * circular dependency with M-11.
 *
 * `exports: [PaymentFacade]` and nothing else. No repository, no service, no
 * `RazorpayClient` — a caller reaching past the facade would be the "deep
 * import" `backend/README.md` §2 forbids.
 */
@Module({
  controllers: [PaymentWebhookController, PaymentAdminController],
  providers: [
    // Gateway boundary — the only thing that talks to Razorpay.
    RazorpayClient,
    // Data access.
    PaymentRepository,
    RefundRepository,
    PaymentEventRepository,
    PaymentConfigRepository,
    // Rules.
    PaymentConfigService,
    PaymentService,
    RefundService,
    PaymentWebhookService,
    PaymentAdminService,
    // Public surface.
    PaymentFacade,
  ],
  exports: [PaymentFacade],
})
export class PaymentModule {}

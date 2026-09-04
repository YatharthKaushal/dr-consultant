import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './config/db/database.module';
import { EventsModule } from './config/events/events.module';
import { getEnv } from './config/env/env.validation';
import { HealthModule } from './health/health.module';
import { AiModule } from './modules/ai/ai.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { BookingModule } from './modules/booking/booking.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { ConsentModule } from './modules/consent/consent.module';
import { DoctorModule } from './modules/doctor/doctor.module';
import { DocumentModule } from './modules/document/document.module';
import { IdentityModule } from './modules/identity/identity.module';
import { InstantModule } from './modules/instant/instant.module';
import { McpModule } from './modules/mcp/mcp.module';
import { NotificationModule } from './modules/notification/notification.module';
import { PatientModule } from './modules/patient/patient.module';
import { PaymentModule } from './modules/payment/payment.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { PromotionModule } from './modules/promotion/promotion.module';
import { SearchModule } from './modules/search/search.module';
import { SearchToolModule } from './modules/search/tools/search-tool.module';
import { StorageModule } from './modules/storage/storage.module';
import { VideoModule } from './modules/video/video.module';
import { AppConfigModule } from './shared/app-config/app-config.module';
import { AuditModule } from './shared/audit/audit.module';
import { AuthModule } from './shared/auth/auth.module';
import { ErrorsModule } from './shared/errors/errors.module';

@Module({
  imports: [
    // .env files are read and validated by `getEnv()`, so ConfigModule is told
    // to skip its own dotenv pass and just serve the already-validated object.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: true,
      load: [() => getEnv()],
    }),
    DatabaseModule,
    EventsModule,
    // Global response envelope (success wrap + error shape) — registered
    // early, ahead of every feature module, so it governs their responses too.
    ErrorsModule,
    AuditModule,
    AppConfigModule,
    // IdentityModule before AuthModule: AuthModule's APP_GUARDs resolve
    // AUTH_CONTEXT_RESOLVER from IdentityModule (both are @Global(), so this
    // ordering is for readability, not correctness — Nest resolves global
    // providers regardless of import order).
    IdentityModule,
    AuthModule,
    // M-03: consent and legal documents. Depends on M-01/M-02 only
    // (`docs/MODULES.md`), so it imports no feature module — M-14 (video)
    // consumes `ConsentFacade` to gate joining a consultation, never the other
    // way round.
    ConsentModule,
    PatientModule,
    DoctorModule,
    CatalogueModule,
    AvailabilityModule,
    AiModule,
    SearchModule,
    // The provider-agnostic tool layer, and the MCP transport that exposes
    // it. `McpModule` imports `SearchToolModule` itself; listing it here too
    // keeps the tool registry available to future in-process consumers (our
    // own LangChain agent) without them having to reach through MCP.
    SearchToolModule,
    McpModule,
    StorageModule,
    // M-08: notifications. Depends on M-01/M-02 only (`docs/MODULES.md`), so
    // it imports no feature module — and every later module that raises a
    // notification (M-11, M-12, M-13, M-16) imports NotificationModule and
    // injects `NotificationFacade`, never the other way round.
    NotificationModule,
    // M-10: documents and file storage. Depends only on M-01/M-02
    // (`docs/MODULES.md`), so it needs no other feature module imported here.
    DocumentModule,
    // M-12.5: pricing. The backend's single source of truth for every price —
    // the bill becomes a priced list of components, each with its own tax
    // treatment, frozen onto an immutable quote before the gateway order exists.
    // Listed BEFORE PaymentModule because payment consumes `PricingFacade`; the
    // dependency runs payment -> pricing and never back, so there is no cycle.
    // (Ordering is for readability, not correctness — Nest resolves the provider
    // graph regardless.)
    PricingModule,
    // M-12: payments and billing (Razorpay). Imports no feature module of its
    // own — `docs/MODULES.md` lists M-12 as depending on M-05/M-11, but at the
    // code level the dependency runs the other way: booking calls payments
    // through `PaymentFacade`, and `createOrderForConsultation` takes the
    // consultation id and fee as arguments rather than looking either up.
    PaymentModule,
    // M-11: booking. Listed after PaymentModule because it consumes
    // `PaymentFacade` (bound at `BOOKING_PAYMENT_PORT`) as well as the
    // Document/Patient/Doctor/Catalogue/Availability facades — ordering is for
    // readability, not correctness, since Nest resolves the provider graph
    // regardless.
    BookingModule,
    // M-13: presence and instant consult. After BookingModule and DoctorModule
    // because it consumes both facades (and PaymentFacade) — ordering is for
    // readability, not correctness, since Nest resolves the provider graph
    // regardless.
    InstantModule,
    // M-14: video consultation, on self-hosted LiveKit. After BookingModule,
    // PaymentModule, PatientModule and InstantModule because it consumes all
    // four facades — ordering is for readability, not correctness, since Nest
    // resolves the provider graph regardless.
    //
    // *** SHIPS REFUSING EVERY JOIN UNTIL M-03 (CONSENT) IS WIRED UP. ***
    // `CONSENT_PORT` is bound to a null object that answers
    // `hasCurrentConsent: false`, and FR-8.5 issues a join token only "after
    // payment and consent checks pass". That is a deliberate fail-closed
    // default, not an unfinished edge: see `unavailable-consent.provider.ts`.
    // The coordinator rebinds the token in `video.module.ts` post-merge.
    VideoModule,
    // Promotions — coupons, vouchers, refer-and-earn and doctor affiliate
    // commission. Imports NO feature module: it reads booking's consultation
    // statuses through `PROMOTION_BOOKING_LOOKUP_PORT`, because BOOKING ->
    // PRICING -> PROMOTION means a direct import back into booking would close
    // a cycle. `PromotionFacade` is what `modules/pricing` binds at its
    // `DISCOUNT_PORT`.
    //
    // *** AFFILIATES SHIP SWITCHED OFF *** (`promotion.affiliate_enabled`
    // defaults to `false`, every partner defaults to `paused`). See
    // `affiliate-partners.schema.ts` for the NMC 2023 reasoning — enabling it is
    // the client's legal advisor's call, not a developer's.
    PromotionModule,
    HealthModule,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './config/db/database.module';
import { EventsModule } from './config/events/events.module';
import { getEnv } from './config/env/env.validation';
import { HealthModule } from './health/health.module';
import { AiModule } from './modules/ai/ai.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { DoctorModule } from './modules/doctor/doctor.module';
import { DocumentModule } from './modules/document/document.module';
import { IdentityModule } from './modules/identity/identity.module';
import { McpModule } from './modules/mcp/mcp.module';
import { PatientModule } from './modules/patient/patient.module';
import { PaymentModule } from './modules/payment/payment.module';
import { SearchModule } from './modules/search/search.module';
import { SearchToolModule } from './modules/search/tools/search-tool.module';
import { StorageModule } from './modules/storage/storage.module';
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
    // M-10: documents and file storage. Depends only on M-01/M-02
    // (`docs/MODULES.md`), so it needs no other feature module imported here.
    DocumentModule,
    // M-12: payments and billing (Razorpay). Imports no feature module of its
    // own — `docs/MODULES.md` lists M-12 as depending on M-05/M-11, but at the
    // code level the dependency runs the other way: booking calls payments
    // through `PaymentFacade`, and `createOrderForConsultation` takes the
    // consultation id and fee as arguments rather than looking either up.
    PaymentModule,
    HealthModule,
  ],
})
export class AppModule {}

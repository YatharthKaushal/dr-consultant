import { Module } from '@nestjs/common';
import { AgentCredentialRepository } from './agent-credential.repository';
import { AgentCredentialService } from './agent-credential.service';
import { AgentProfileRepository } from './agent-profile.repository';
import { AgentProfileService } from './agent-profile.service';
import { AiAdminController } from './ai-admin.controller';
import { AiCryptoService } from './ai-crypto.service';
import { AiRotationService } from './ai-rotation.service';
import { AiFacade } from './ai.facade';
import { AnthropicAdapter } from './anthropic.adapter';
import { BedrockAdapter } from './bedrock.adapter';
import { GoogleGenAiAdapter } from './google-genai.adapter';
import { LlmProviderRegistry } from './llm-provider.registry';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';

/**
 * Not `@Global()` — like `DoctorModule`/`CatalogueModule`/`AvailabilityModule`,
 * nothing outside this module resolves a DI token from here; a consuming
 * module (M-09/search first) imports `AiModule` and injects `AiFacade`
 * through a normal constructor.
 *
 * `AiFacade` is the ONLY export. `AiRotationService`, the adapters, the
 * registry, the repositories and `AiCryptoService` are all deliberately
 * internal: a module that could inject `AiCryptoService` could decrypt a
 * credential, and a module that could inject `AiRotationService` could route
 * around the facade. Keeping the export list to one name is what makes
 * "nothing outside this module ever sees a plaintext key" a structural
 * property rather than a convention.
 *
 * No `imports`: `DATABASE`, `AuditService` and `AppConfigService` come from
 * `DatabaseModule`, `AuditModule` and `AppConfigModule`, all of which are
 * `@Global()` — same as `DoctorModule`/`CatalogueModule` need none for
 * `DATABASE`/`AuditService`.
 *
 * The four adapters are registered as providers so Nest can inject them into
 * `LlmProviderRegistry`. Adding a fifth provider is one line here and one in
 * the registry — and the registry's `Record<ProviderCode, ...>` typing makes
 * forgetting the second a compile error rather than a runtime surprise.
 */
@Module({
  controllers: [AiAdminController],
  providers: [
    AgentProfileRepository,
    AgentCredentialRepository,
    AiCryptoService,
    OpenAiCompatibleAdapter,
    AnthropicAdapter,
    GoogleGenAiAdapter,
    BedrockAdapter,
    LlmProviderRegistry,
    AiRotationService,
    AgentProfileService,
    AgentCredentialService,
    AiFacade,
  ],
  exports: [AiFacade],
})
export class AiModule {}

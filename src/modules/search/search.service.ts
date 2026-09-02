import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { SearchSource } from '../../schema/enums.schema';
import type { SearchQueryRow } from '../../schema/search-queries.schema';
import { AvailabilityFacade } from '../availability/availability.facade';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicConcern } from '../catalogue/catalogue.contract';
import { DoctorFacade } from '../doctor/doctor.facade';
import { ConcernMatcherService } from './concern-matcher.service';
import { CrisisDetectorService } from './crisis-detector.service';
import { DoctorRankerService } from './doctor-ranker.service';
import { QueryInterpreterService } from './query-interpreter.service';
import { ResponseValidatorService } from './response-validator.service';
import { SearchConfigService } from './search-config.service';
import { runDiscoveryPipeline, type DiscoveryPorts, type DiscoveryRuntimeConfig, type DiscoveryTaxonomy } from './search-discovery.engine';
import { SearchRepository } from './search.repository';
import type { DiscoveryRequest, DiscoveryResponse, MatchedConcernView } from './search.contract';
import {
  SEARCH_AVAILABILITY_LOOKAHEAD_DAYS,
  SEARCH_CANDIDATE_POOL_LIMIT,
  SEARCH_ERROR_CODES,
  SEARCH_RECENT_LIMIT,
} from './search.constants';

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface RecentSearchView {
  queryText: string;
  isVoiceInput: boolean;
  resultCount: number;
  createdAt: string;
}

/**
 * Composition for M-09: resolve config and taxonomy, run the six-stage
 * pipeline (`search-discovery.engine.ts`), log the query, enforce the AI
 * rate limit. Everything decision-shaped lives in the engine and the four
 * pure services; everything I/O-shaped lives here — the same split
 * `availability-slot.service.ts` has against `availability-slot.engine.ts`.
 *
 * ORDER OF OPERATIONS, and why it is not negotiable:
 *   1. crisis gate (inside the pipeline, first node);
 *   2. rate limit, only on the AI path and only after the gate;
 *   3. everything else.
 * A throttled patient still gets the guardrail. So does a patient searching
 * while the AI is switched off, or down.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly repo: SearchRepository,
    private readonly config: SearchConfigService,
    private readonly crisisDetector: CrisisDetectorService,
    private readonly interpreter: QueryInterpreterService,
    private readonly matcher: ConcernMatcherService,
    private readonly ranker: DoctorRankerService,
    private readonly validator: ResponseValidatorService,
    private readonly catalogue: CatalogueFacade,
    private readonly doctors: DoctorFacade,
    private readonly availability: AvailabilityFacade,
  ) {}

  /** FR-5.1. The whole pipeline, plus the `search_queries` log line. */
  async discover(request: DiscoveryRequest): Promise<DiscoveryResponse> {
    const [config, specialties, concerns] = await Promise.all([
      this.config.getResolved(),
      this.catalogue.listActiveSpecialties(),
      this.catalogue.listActiveConcerns(),
    ]);

    const runtimeConfig: DiscoveryRuntimeConfig = {
      maxResults: config.maxResults,
      availabilityLookaheadDays: SEARCH_AVAILABILITY_LOOKAHEAD_DAYS,
      candidatePoolLimit: SEARCH_CANDIDATE_POOL_LIMIT,
      crisisGuidance: config.crisisGuidance,
      popularSearches: config.popularSearches,
    };
    const taxonomy: DiscoveryTaxonomy = { specialties, concerns };

    const { state, response } = await runDiscoveryPipeline(request, this.buildPorts(config.rateLimitPerHour), runtimeConfig, taxonomy);

    await this.logQuery(request, {
      matchedConcernIds: state.concernMatches.map((match) => match.concern.id),
      resultCount: response.results.length,
      crisisGuardrailFired: state.crisis.fired,
    });

    return response;
  }

  /** `SearchContract.screenForCrisis` — the guardrail alone, for M-16/M-17/M-18 to reuse the same admin-edited list. */
  async screenForCrisis(text: string): Promise<{ fired: boolean }> {
    const { fired } = await this.crisisDetector.screen(text);
    return { fired };
  }

  /**
   * FR-5.11, THIS PATIENT'S OWN ONLY. `patientId` comes from
   * `@CurrentUser()` at the controller and is never a request parameter, so
   * there is no shape of request that can ask for someone else's history.
   * De-duplicated by normalised text, newest kept.
   */
  async listRecent(patientId: string, limit: number = SEARCH_RECENT_LIMIT): Promise<RecentSearchView[]> {
    const capped = Math.min(Math.max(1, limit), SEARCH_RECENT_LIMIT);
    // Over-fetch so de-duplication still fills the row.
    const rows = await this.repo.listRecentByPatient(patientId, capped * 4);

    const seen = new Set<string>();
    const recent: RecentSearchView[] = [];
    for (const row of rows) {
      const key = row.queryText.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      recent.push(toRecentSearchView(row));
      if (recent.length >= capped) break;
    }
    return recent;
  }

  /** FR-5.11's admin-edited popular list. Read straight from `app_config` — never computed from the query log, per `search-queries.schema.ts`. */
  async listPopular(): Promise<Array<{ label: string; query: string }>> {
    const config = await this.config.getResolved();
    return config.popularSearches;
  }

  /** FR-5.3 browse. Active concerns, optionally under one specialty. */
  async listConcerns(specialtyId?: string): Promise<MatchedConcernView[]> {
    const concerns = await this.catalogue.listActiveConcerns(specialtyId);
    return concerns.map(toMatchedConcernView);
  }

  /** FR-5.3 browse by professional type. */
  async listProfessionalTypes(): Promise<Array<{ id: string; code: string; name: string; description: string | null }>> {
    const specialties = await this.catalogue.listActiveSpecialties();
    return specialties.map((specialty) => ({
      id: specialty.id,
      code: specialty.code,
      name: specialty.name,
      description: specialty.description,
    }));
  }

  /**
   * FR-4.4. A plain filtered/sorted listing with NO query and NO concern
   * mapping — deliberately the same ranker, with an empty specialty-match
   * set, so browse and discovery order results by the same rules rather
   * than by two implementations that drift.
   */
  async listDoctors(filter: {
    specialtyId?: string;
    languages?: string[];
    maxFeeInr?: string;
    availableWithinDays?: number;
    sort?: 'relevance' | 'fee_asc' | 'availability';
    limit?: number;
    offset?: number;
  }) {
    const config = await this.config.getResolved();
    const limit = Math.min(filter.limit ?? config.maxResults, config.maxResults);
    const offset = filter.offset ?? 0;

    const candidates = await this.doctors.listListedDoctors({
      specialtyIds: filter.specialtyId ? [filter.specialtyId] : undefined,
      languages: filter.languages,
      maxFeeInr: filter.maxFeeInr,
      limit: SEARCH_CANDIDATE_POOL_LIMIT,
      offset,
    });
    if (candidates.length === 0) return [];

    const now = new Date();
    const toUtc = new Date(now.getTime() + SEARCH_AVAILABILITY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const earliest = await this.availability.getEarliestBookableSlots(
      candidates.map((doctor) => doctor.id),
      now,
      toUtc,
    );
    const earliestByDoctorId = new Map(earliest.map((entry) => [entry.doctorId, entry.earliestStartsAt]));

    const ranked = this.ranker.rank({
      candidates,
      specialtyMatches: [],
      earliestSlotByDoctorId: earliestByDoctorId,
      filters: { languages: filter.languages, maxFeeInr: filter.maxFeeInr, availableWithinDays: filter.availableWithinDays },
      now,
      lookaheadDays: SEARCH_AVAILABILITY_LOOKAHEAD_DAYS,
    });

    const sorted = this.applySort(ranked, filter.sort ?? 'relevance');
    return sorted.slice(0, limit).map((entry) => ({
      doctorId: entry.doctor.id,
      fullName: entry.doctor.fullName,
      qualification: entry.doctor.qualification,
      registrationNumber: entry.doctor.registrationNumber,
      yearsOfExperience: entry.doctor.yearsOfExperience,
      languages: entry.doctor.languages,
      consultationFeeInr: entry.doctor.consultationFeeInr,
      consultationDurationMinutes: entry.doctor.consultationDurationMinutes,
      specialties: entry.doctor.specialties,
      earliestSlotAt: entry.earliestSlotAt ? entry.earliestSlotAt.toISOString() : null,
      score: Number(entry.score.toFixed(4)),
    }));
  }

  /** FR-5.7's admin feedback loop. Returns raw log rows — the controller maps them. */
  async listQueryLogs(filter: Parameters<SearchRepository['listForAdmin']>[0]): Promise<SearchQueryRow[]> {
    return this.repo.listForAdmin(filter);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /** Binds the pipeline's narrow ports to this module's real services. The only place the two are joined, which is what keeps the engine testable against plain fakes. */
  private buildPorts(rateLimitPerHour: number): DiscoveryPorts {
    return {
      crisis: this.crisisDetector,
      interpreter: this.interpreter,
      matcher: this.matcher,
      doctors: this.doctors,
      availability: this.availability,
      ranker: this.ranker,
      validator: this.validator,
      rateLimiter: { consumeAiBudget: async (patientId, source) => this.consumeAiBudget(patientId, source, rateLimitPerHour) },
    };
  }

  /**
   * Records the attempt FIRST, then counts — the same ordering
   * `identity.service.ts` uses for OTP requests, so an attempt that fails
   * downstream still counts against the budget it was about to spend.
   *
   * Throttling returns 429 rather than silently degrading to the
   * deterministic matcher. That is the honest answer: the patient should
   * know a limit exists rather than quietly receiving a different quality of
   * result. `retryAfterSeconds` is carried in the error body, which
   * `HttpExceptionFilter` passes through as an extra field.
   */
  private async consumeAiBudget(patientId: string | null, source: SearchSource, limitPerHour: number): Promise<void> {
    const since = new Date(Date.now() - ONE_HOUR_MS);
    const used = await this.repo.countAiAttempts(patientId, source, since);
    if (used >= limitPerHour) {
      throw new HttpException(
        {
          code: SEARCH_ERROR_CODES.RATE_LIMITED,
          message: 'Too many assisted searches in the last hour. Please try again shortly, or browse by concern.',
          retryAfterSeconds: 3600,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.repo.recordAiAttempt(patientId, source);
  }

  /**
   * Best-effort, like `AuditService`'s non-transactional mode: a patient's
   * search succeeding matters more than its log line. A failure here is
   * logged server-side and swallowed rather than turning a working search
   * into a 500.
   */
  private async logQuery(
    request: DiscoveryRequest,
    outcome: { matchedConcernIds: string[]; resultCount: number; crisisGuardrailFired: boolean },
  ): Promise<void> {
    try {
      await this.repo.logQuery({
        patientId: request.patientId,
        source: request.source,
        queryText: request.queryText,
        isVoiceInput: request.isVoiceInput ?? false,
        matchedConcernIds: outcome.matchedConcernIds,
        resultCount: outcome.resultCount,
        crisisGuardrailFired: outcome.crisisGuardrailFired,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to write search_queries row (best-effort, swallowed): ${message}`);
    }
  }

  /**
   * FR-4.4's sort. `relevance` is the ranker's own order (already applied);
   * the other two re-sort but keep the same `doctor.id` tie-break, so every
   * sort is total and stable.
   */
  private applySort<T extends { doctor: { id: string; consultationFeeInr: string }; earliestSlotAt: Date | null }>(
    ranked: T[],
    sort: 'relevance' | 'fee_asc' | 'availability',
  ): T[] {
    if (sort === 'relevance') return ranked;

    const sorted = [...ranked];
    if (sort === 'fee_asc') {
      sorted.sort((a, b) => {
        const difference = Number.parseFloat(a.doctor.consultationFeeInr) - Number.parseFloat(b.doctor.consultationFeeInr);
        return difference !== 0 ? difference : a.doctor.id.localeCompare(b.doctor.id);
      });
      return sorted;
    }

    // `availability`: soonest first, doctors with nothing bookable last.
    sorted.sort((a, b) => {
      const aTime = a.earliestSlotAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bTime = b.earliestSlotAt?.getTime() ?? Number.POSITIVE_INFINITY;
      return aTime !== bTime ? aTime - bTime : a.doctor.id.localeCompare(b.doctor.id);
    });
    return sorted;
  }
}

function toRecentSearchView(row: SearchQueryRow): RecentSearchView {
  return {
    queryText: row.queryText,
    isVoiceInput: row.isVoiceInput,
    resultCount: row.resultCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMatchedConcernView(concern: PublicConcern): MatchedConcernView {
  return { id: concern.id, code: concern.code, name: concern.name, specialtyId: concern.specialtyId };
}

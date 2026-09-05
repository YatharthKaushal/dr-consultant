import { NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getEnv, resetEnvCache } from '../../config/env/env.validation';
import { SearchTestKitController } from './search-test-kit.controller';
import type { SearchService } from './search.service';

/** Same reply double `video-test-kit.controller.spec.ts` uses — `getPage` sends via `@Res()` directly. */
function mockReply(): FastifyReply & { body: unknown; contentType: unknown } {
  const reply = {
    body: undefined as unknown,
    contentType: undefined as unknown,
    header(name: string, value: unknown) {
      if (name.toLowerCase() === 'content-type') reply.contentType = value;
      return reply;
    },
    send(payload: unknown) {
      reply.body = payload;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { body: unknown; contentType: unknown };
}

describe('SearchTestKitController', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    resetEnvCache();
  });

  function build(discoverImpl?: jest.Mock) {
    const search = { discover: discoverImpl ?? jest.fn() } as unknown as SearchService;
    return { controller: new SearchTestKitController(search), search };
  }

  describe('flag off (the default)', () => {
    beforeEach(() => {
      delete process.env.SEARCH_TEST_KIT_ENABLED;
      resetEnvCache();
      expect(getEnv().SEARCH_TEST_KIT_ENABLED).toBe(false);
    });

    it('404s the page', () => {
      const { controller } = build();
      expect(() => controller.getPage(mockReply())).toThrow(NotFoundException);
    });

    it('404s the discover route, without ever calling SearchService', async () => {
      const { controller, search } = build();
      await expect(controller.discover({ queryText: 'anxious' })).rejects.toThrow(NotFoundException);
      expect(search.discover).not.toHaveBeenCalled();
    });
  });

  describe('flag on', () => {
    beforeEach(() => {
      process.env.SEARCH_TEST_KIT_ENABLED = 'true';
      resetEnvCache();
      expect(getEnv().SEARCH_TEST_KIT_ENABLED).toBe(true);
    });

    it('serves the html page', () => {
      const { controller } = build();
      const reply = mockReply();
      controller.getPage(reply);
      expect(reply.contentType).toBe('text/html; charset=utf-8');
      expect(reply.body).toContain('<title>AI Search Test Kit</title>');
      expect(reply.body).toContain('/api/search/test-kit/discover');
    });

    it('calls SearchService.discover with patientId null and source mcp — never a fabricated patient', async () => {
      const discoverMock = jest.fn().mockResolvedValue({ results: [], meta: { interpretation: 'ai' } });
      const { controller, search } = build(discoverMock);

      await controller.discover({ queryText: 'anxious and not sleeping', limit: 5 });

      expect(search.discover).toHaveBeenCalledWith(
        expect.objectContaining({ patientId: null, source: 'mcp', queryText: 'anxious and not sleeping', limit: 5 }),
      );
    });
  });
});

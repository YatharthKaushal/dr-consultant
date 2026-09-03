/**
 * The webhook's JSON body parser.
 *
 * These tests pin the behaviour that made `payment-webhook.service.ts`'s
 * parse-failure branch reachable at all. Before the fix, Fastify's stock parser
 * answered 400 for a malformed body and the request never reached a controller
 * — so the service's "record it, mark it failed, answer 2xx" path was dead code
 * in production while its unit tests passed.
 */
import { registerWebhookSafeJsonParser, type JsonParserHost } from './payment-webhook.body-parser';
import { PAYMENT_WEBHOOK_PATH } from './payment.constants';

type Handler = (
  request: { url: string },
  body: Buffer,
  done: (error: Error | null, result?: unknown) => void,
) => void;

/** A stand-in for Fastify's stock parser, so delegation is observable. */
const FALLBACK_MARKER = 'DELEGATED_TO_FASTIFY';

/** Captures what would be registered on a real Fastify instance. */
function register(): { handler: Handler; removed: string[]; poisoningArgs: string[] } {
  const removed: string[] = [];
  const poisoningArgs: string[] = [];
  let handler: Handler | undefined;

  const host: JsonParserHost = {
    removeContentTypeParser: (contentType) => removed.push(contentType),
    addContentTypeParser: (_contentType, _options, registered) => {
      handler = registered;
    },
    getDefaultJsonParser: (proto, ctor) => {
      poisoningArgs.push(proto, ctor);
      // Fastify's parser errors on a malformed body; the marker lets a test
      // assert that we delegated rather than imitated. It takes a STRING, as
      // Fastify's real one does.
      return (_request, body, done) => {
        expect(typeof body).toBe('string');
        try {
          done(null, JSON.parse(body) as unknown);
        } catch {
          done(new Error(FALLBACK_MARKER));
        }
      };
    },
  };

  registerWebhookSafeJsonParser(host, PAYMENT_WEBHOOK_PATH);
  if (!handler) throw new Error('no parser was registered');
  return { handler, removed, poisoningArgs };
}

/** Runs the registered parser and returns what it handed back. */
function parse(url: string, body: string): { error: Error | null; result: unknown; request: { url: string } } {
  const { handler } = register();
  const request = { url };
  let captured: { error: Error | null; result: unknown } = { error: null, result: undefined };
  handler(request, Buffer.from(body, 'utf8'), (error, result) => {
    captured = { error, result };
  });
  return { ...captured, request };
}

describe('registerWebhookSafeJsonParser', () => {
  it('replaces the existing application/json parser rather than adding a second', () => {
    expect(register().removed).toEqual(['application/json']);
  });

  /* ---------------------------------------------------------------- */
  /* THE WEBHOOK PATH                                                  */
  /* ---------------------------------------------------------------- */

  describe('on the webhook path', () => {
    /**
     * *** THE REGRESSION. *** A correctly-signed body that is not valid JSON
     * must reach the controller, so the signature can be verified, the delivery
     * recorded in `payment_events`, and a 2xx returned. Fastify's stock parser
     * answered 400 and Razorpay would have retried forever.
     */
    it('does NOT error on a body that is not valid JSON', () => {
      const { error, result } = parse(PAYMENT_WEBHOOK_PATH, 'this is not json at all {{{');
      expect(error).toBeNull();
      expect(result).toEqual({});
    });

    it('does NOT error on an empty body', () => {
      const { error, result } = parse(PAYMENT_WEBHOOK_PATH, '');
      expect(error).toBeNull();
      expect(result).toEqual({});
    });

    it('still parses a well-formed body normally', () => {
      const { error, result } = parse(PAYMENT_WEBHOOK_PATH, '{"event":"payment.captured"}');
      expect(error).toBeNull();
      expect(result).toEqual({ event: 'payment.captured' });
    });

    it('exempts the path even when a query string is present', () => {
      const { error } = parse(`${PAYMENT_WEBHOOK_PATH}?source=dashboard`, 'not json');
      expect(error).toBeNull();
    });

    /**
     * The HMAC is computed over these exact bytes, so the parser must preserve
     * them untouched — including for a body it could not parse.
     */
    it('attaches the raw bytes for the signature check, even when parsing fails', () => {
      const body = 'not json, but signed';
      const { handler } = register();
      const request: { url: string; rawBody?: Buffer } = { url: PAYMENT_WEBHOOK_PATH };
      handler(request, Buffer.from(body, 'utf8'), () => undefined);
      expect(request.rawBody?.toString('utf8')).toBe(body);
    });
  });

  /* ---------------------------------------------------------------- */
  /* EVERY OTHER ROUTE IS UNCHANGED                                    */
  /* ---------------------------------------------------------------- */

  describe('on every other route', () => {
    /**
     * *** DELEGATION, NOT IMITATION. ***
     *
     * A first attempt hand-rolled the 400 as `Object.assign(new Error(msg),
     * { statusCode: 400 })`. That is not the shape Nest's filter chain turns
     * into a 400, so malformed JSON on every non-webhook route started
     * answering 500 INTERNAL_SERVER_ERROR. Delegating to Fastify's own parser
     * is the only way to keep those routes byte-identical.
     */
    it('delegates a malformed body to Fastify’s own parser rather than imitating its error', () => {
      const { error } = parse('/api/admin/payments/transactions', '{ broken');
      expect(error?.message).toBe(FALLBACK_MARKER);
    });

    it('delegates an empty body to Fastify’s own parser', () => {
      const { error, result } = parse('/api/admin/payments/config', '');
      // Whatever Fastify does with it, we do — we do not decide.
      expect(error?.message === FALLBACK_MARKER || result !== undefined).toBe(true);
    });

    /** The prototype-pollution guards must not be weakened by the swap. */
    it('asks Fastify for a parser with both poisoning guards set to error', () => {
      expect(register().poisoningArgs).toEqual(['error', 'error']);
    });

    it('parses a well-formed body normally', () => {
      const { error, result } = parse('/api/admin/payments/config', '{"gstRate":18}');
      expect(error).toBeNull();
      expect(result).toEqual({ gstRate: 18 });
    });

    /** A path that merely CONTAINS the webhook path must not be exempted. */
    it('does not exempt a path that only resembles the webhook path', () => {
      expect(parse('/api/payments/webhook/extra', 'not json').error?.message).toBe(FALLBACK_MARKER);
      expect(parse('/api/evil/api/payments/webhook', 'not json').error?.message).toBe(FALLBACK_MARKER);
    });

    it('still attaches rawBody', () => {
      const { handler } = register();
      const request: { url: string; rawBody?: Buffer } = { url: '/api/admin/payments/config' };
      handler(request, Buffer.from('{"gstRate":18}', 'utf8'), () => undefined);
      expect(request.rawBody?.toString('utf8')).toBe('{"gstRate":18}');
    });
  });
});

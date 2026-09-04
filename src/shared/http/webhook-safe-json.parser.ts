/**
 * *** A SIGNED WEBHOOK MUST SURVIVE A BODY THAT IS NOT VALID JSON. ***
 *
 * ── WHY THIS LIVES IN `shared/` ────────────────────────────────────────────
 *
 * It began as `modules/payment/payment-webhook.body-parser.ts`, and its header
 * argued — correctly at the time — that the rule belonged to the Razorpay
 * webhook and was meaningless without it. That stopped being true the moment a
 * SECOND signed webhook arrived: LiveKit's `WebhookReceiver` verifies its
 * signature over the raw bytes exactly as Razorpay's HMAC does, and needs the
 * same exemption for the same reasons.
 *
 * Two modules cannot share a rule that lives inside one of them —
 * `backend/README.md` §2: "`src/shared` and `src/config` are imported by
 * modules and never import them." This file imports nothing from any module;
 * callers pass their own paths in.
 *
 * ── The hole this closes ──────────────────────────────────────────────────
 *
 * Fastify's built-in `application/json` parser answers
 *
 *     400 {"code":"BAD_REQUEST","message":"Body is not valid JSON but
 *          content-type is set to 'application/json'"}
 *
 * BEFORE any controller runs. For a signed webhook that is wrong twice over:
 *
 *   1. RETRY STORM. Both providers retry on a non-2xx. A body that will never
 *      parse would be redelivered forever. `payment-event.repository.ts`: "a
 *      retry storm on a poison event helps nobody."
 *
 *   2. LOST EVIDENCE. The signature is never even checked and no row is ever
 *      written, so the receiving service's carefully-built parse-failure branch
 *      is UNREACHABLE IN PRODUCTION — reachable only from unit tests that call
 *      it directly, which is exactly how a branch like that stays green while
 *      being dead.
 *
 * Confirmed originally by probing a booted server, not inferred.
 *
 * ── Why this is safe for every other route ────────────────────────────────
 *
 * Only the listed paths are exempted. Every other route keeps Fastify's
 * previous behaviour byte for byte: the same 400, the same two messages, the
 * same empty-body rejection. An exempted route does not read the parsed body at
 * all — it reads `request.rawBody`, verifies the signature over those exact
 * bytes, and runs its own `JSON.parse` — so handing it `{}` costs nothing and
 * changes no decision.
 *
 * `rawBody` is still populated for EVERY request, because replacing the parser
 * replaces the one `NestFactory.create(..., { rawBody: true })` installed.
 */

/** A Fastify body-parser callback. */
export type ParserDone = (error: Error | null, result?: unknown) => void;
/** The parser we register. Takes the raw bytes, because signature verification needs them. */
export type JsonParser = (request: { url: string }, body: Buffer, done: ParserDone) => void;
/** Fastify's stock JSON parser, which is typed for a decoded string body. */
export type StringJsonParser = (request: { url: string }, body: string, done: ParserDone) => void;

/** The Fastify surface this needs — kept structural so a test can pass a fake. */
export interface JsonParserHost {
  removeContentTypeParser(contentType: string): void;
  addContentTypeParser(contentType: string, options: { parseAs: 'buffer' }, handler: JsonParser): void;
  /**
   * Fastify's own stock JSON parser. Public API, and the reason every
   * non-exempt route keeps its previous behaviour EXACTLY: we delegate to it
   * rather than re-implementing its errors.
   *
   * An earlier attempt hand-rolled `Object.assign(new Error(msg), { statusCode:
   * 400 })` for the failure case. It looked right and was wrong — a plain
   * `Error` is not what Nest's filter chain turns into a 400, so every
   * malformed JSON body on every OTHER route started answering
   * `500 INTERNAL_SERVER_ERROR` instead of `400 BAD_REQUEST`. Caught by probing
   * a live route, which is exactly why this now delegates instead of imitating.
   */
  getDefaultJsonParser(
    onProtoPoisoning: 'error' | 'remove' | 'ignore',
    onConstructorPoisoning: 'error' | 'remove' | 'ignore',
  ): StringJsonParser;
}

/**
 * Replaces the `application/json` parser with one that never fails the listed
 * webhook routes, and defers to Fastify's own parser for everything else.
 *
 * *** MUST BE CALLED AFTER `app.init()` AND BEFORE `app.listen()`. *** Nest
 * registers its own `application/json` parser during `init()` (the one
 * `{ rawBody: true }` configures), and Fastify seals its parsers at `ready()`,
 * which `listen()` triggers. `main.ts` says the same at the call site.
 *
 * @param host         the Fastify instance
 * @param webhookPaths every request path to exempt, each including the global
 *                     prefix. Matched exactly, after the query string is
 *                     stripped. An empty list is legal and simply restores
 *                     stock behaviour everywhere.
 */
export function registerWebhookSafeJsonParser(
  host: JsonParserHost,
  webhookPaths: readonly string[],
): void {
  // Fastify's own defaults, read from a fresh instance rather than assumed —
  // these are the prototype-pollution guards and must not be weakened.
  const fallback = host.getDefaultJsonParser('error', 'error');

  // A Set so adding a third webhook costs nothing per request, and so a
  // duplicate path in the list is harmless rather than a subtle double-match.
  const exempt = new Set(webhookPaths);

  host.removeContentTypeParser('application/json');

  host.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    // Nest's own parser does exactly this when `rawBody: true`; replacing the
    // parser means we take the job on. Done for EVERY route, webhook or not.
    (request as { rawBody?: Buffer }).rawBody = body;

    // The query string is not part of the route path, and a webhook URL can
    // legitimately carry one.
    if (!exempt.has(request.url.split('?')[0])) {
      // *** Byte-for-byte Fastify behaviour for every other route. ***
      // Decoded to a string because that is what Fastify's own parser takes,
      // and because its empty-body branch tests `body === ''`.
      fallback(request, body.toString('utf8'), done);
      return;
    }

    // ---- An exempt path, and only an exempt path. ----
    //
    // An empty or unparseable body is NOT a transport error here. The signature
    // check still has to run, the delivery still has to be recorded, and the
    // answer still has to be a 2xx. The receiving service does all three from
    // `rawBody` and never reads the parsed body — so `{}` costs nothing and
    // changes no decision.
    if (body.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body.toString('utf8')) as unknown);
    } catch {
      done(null, {});
    }
  });
}

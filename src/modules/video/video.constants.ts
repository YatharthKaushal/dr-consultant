/**
 * M-14's constants: the `app_config` keys it OWNS, their compiled-in
 * fallbacks, its error-code vocabulary and its `audit_log.entity_type` values.
 *
 * Structure copied from `payment.constants.ts` and `instant.constants.ts` —
 * keys + defaults + seed source in one place, so the admin write path, the read
 * fallbacks and the seed can never drift apart.
 *
 * *** SEEDED BY STEP 0 WITH THE WEBHOOK PATH ONLY. *** `main.ts` needs that one
 * value to exempt the route from Fastify's JSON body parser, and `main.ts` is
 * owned by the coordinator while three worktrees are in flight. Everything else
 * in this file belongs to the M-14 track, which extends it.
 */

/**
 * The LiveKit webhook's full request path, INCLUDING `main.ts`'s `api` global
 * prefix.
 *
 * Exported because `main.ts` needs it: Fastify's JSON body parser rejects a
 * malformed body with a 400 before any controller runs, and LiveKit — like
 * Razorpay — signs its webhook over the RAW BYTES and retries on a non-2xx. A
 * literal in `main.ts` would silently stop matching the day the route moves.
 *
 * See `src/shared/http/webhook-safe-json.parser.ts` for what the exemption does
 * and why it is safe for every other route.
 */
export const VIDEO_WEBHOOK_PATH = '/api/video/webhook';

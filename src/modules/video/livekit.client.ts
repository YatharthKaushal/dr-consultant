import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk';
import { getEnv } from '../../config/env/env.validation';

/**
 * One verified LiveKit webhook delivery, flattened to the handful of fields
 * this module acts on.
 *
 * *** DELIBERATELY NOT THE SDK's `WebhookEvent`. *** Two reasons, and the
 * second one is the important one:
 *
 *   1. `WebhookEvent` is a generated protobuf message with ~10 branches
 *      (`egressInfo`, `ingressInfo`, `track`, ...) this module never reads.
 *      Returning it would leak the SDK's type into every consumer and every
 *      test, and a hand-rolled `jest.fn()` would then have to construct a
 *      protobuf.
 *
 *   2. *** THE DISCONNECT REASON MUST BE STORED VERBATIM, AND THE SDK LOSES
 *      IT. *** `docs/erd.sql` on `consultation_participants.disconnect_reason`:
 *      "LiveKit DisconnectReason verbatim (CLIENT_INITIATED,
 *      DUPLICATE_IDENTITY, ROOM_DELETED...). Not an enum: LiveKit owns this
 *      vocabulary and adds to it." LiveKit sends the enum as its NAME in the
 *      JSON body (proto3 JSON encoding), and `WebhookEvent.fromJson` decodes it
 *      to a NUMBER — so reading `event.participant.disconnectReason` would give
 *      `1`, and storing `1` would mean re-deriving the name from a table this
 *      module would then own, which is exactly the coupling the column comment
 *      forbids. The raw JSON is therefore read alongside the decoded event and
 *      the string is taken from there. A numeric value (also legal proto3 JSON)
 *      falls back to the SDK's own name mapping so nothing is lost either way.
 */
export interface LivekitWebhookDelivery {
  /** `participant_joined`, `room_finished`, ... Never empty for a real delivery. */
  event: string;
  /** LiveKit's own event uuid. Logged, not stored — the participant sid is the idempotency key here. */
  id: string;
  /** `room.name`, from which `video-room.util.ts` derives the consultation id. */
  roomName: string | null;
  /** Set for `participant_*` events. */
  participant: {
    /** `PA_xxx`, unique per CONNECTION. THE PRIMARY KEY of `consultation_participants`. */
    sid: string;
    /** `<party>:<uuid>` — see `video-room.util.ts`. */
    identity: string;
    /** When LiveKit says this participant connected. Milliseconds are used when present. */
    joinedAt: Date | null;
    /** LiveKit's `DisconnectReason` AS A NAME, verbatim. Null when absent or unrecognisable. */
    disconnectReason: string | null;
  } | null;
}

/**
 * The ONLY file in this codebase that holds `LIVEKIT_API_SECRET`, and the only
 * one that talks to the LiveKit SDK. Same contract `razorpay.client.ts` holds
 * for Razorpay: every caller gets back a typed result or a plain failure, and
 * no provider object and no credential ever escapes.
 *
 * ── THE SECRET ────────────────────────────────────────────────────────────
 *
 * `env.validation.ts` states the rule this class exists to enforce:
 * "*** `LIVEKIT_API_SECRET` SIGNS THE JOIN TOKEN AND VERIFIES THE WEBHOOK. ***
 * It never leaves the server, and it must never appear in a response, a log
 * line or a token PAYLOAD — a token is signed WITH it, not by carrying it."
 *
 * Concretely, in this file:
 *   - the secret is a `private readonly` field with NO getter. Contrast
 *     `RazorpayClient`, which exposes `getWebhookSecret()` because its webhook
 *     service computes the HMAC itself; here the SDK's `WebhookReceiver` does
 *     the verifying, so the secret has no reason to leave at all and does not.
 *   - `getServerUrl()` and `getApiKey()` DO exist. The URL is what the mobile
 *     client dials, and the API key is the token's `iss` claim — public by
 *     construction, the same way `gatewayKeyId` is Razorpay's publishable key.
 *   - no `catch` block in this file interpolates an error into a message that
 *     is returned. Errors from `AccessToken#toJwt` and
 *     `WebhookReceiver#receive` are produced with the secret in hand, so they
 *     are logged and swallowed, and the CALLER raises its own error code.
 *
 * `video.secret-leak.spec.ts` asserts all of that against a live-shaped secret.
 *
 * ── WHY THE SDK, RATHER THAN HAND-ROLLED JWT ──────────────────────────────
 *
 * The opposite call to the one `razorpay.client.ts` makes, and for the opposite
 * reason. That file rejected `razorpay@2.9.8` because its webhook helper
 * compares signatures with `===`. `livekit-server-sdk` verifies the webhook by
 * validating a signed JWT with `jose` and then comparing the body's SHA-256
 * against the token's `sha256` claim — the comparison that matters is inside a
 * vetted JWT library, not a string equality on a secret-derived digest. Its
 * `AccessToken` is likewise the definition of the claim shape LiveKit's own
 * server will parse, and re-implementing that shape by hand is how a `video`
 * grant silently stops meaning what a future LiveKit release thinks it means.
 */
@Injectable()
export class LivekitClient {
  private readonly logger = new Logger(LivekitClient.name);

  private readonly serverUrl: string;
  private readonly apiKey: string;
  /** *** NEVER EXPOSED. There is no getter, by design. *** */
  private readonly apiSecret: string;

  private readonly receiver: WebhookReceiver;

  constructor() {
    const env = getEnv();
    this.serverUrl = env.LIVEKIT_URL;
    this.apiKey = env.LIVEKIT_API_KEY;
    this.apiSecret = env.LIVEKIT_API_SECRET;
    this.receiver = new WebhookReceiver(this.apiKey, this.apiSecret);
  }

  /**
   * The self-hosted LiveKit server the app connects to (`wss://...`).
   *
   * Safe to return to a client, and it HAS to be: the mobile SDK needs a URL
   * and a token, and neither is useful without the other. One per deployment,
   * which is why it is env and not `app_config` — `docs/erd.sql` says so on
   * `app_config` itself.
   */
  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * The API key, which is the `iss` claim of every token this mints.
   *
   * Public by construction: it is already inside every token handed to a
   * client, so treating it as a secret would be theatre. Exposed only so a
   * caller can log or return the project identity; the SECRET is what protects
   * anything.
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Mints one short-lived join token (FR-8.5).
   *
   * *** THE GRANTS ARE THE NARROWEST SET THAT LETS A CONSULTATION HAPPEN. ***
   *
   *   `roomJoin` + `room`   admission to EXACTLY ONE room. Not `roomCreate`,
   *                         not `roomList`, not `roomAdmin` — a participant who
   *                         could list rooms could enumerate every live
   *                         consultation on the platform by id, and one who
   *                         could administer a room could remove the other
   *                         party or mute them permanently.
   *   `canPublish`          FR-8.3's mute and camera controls are CLIENT-side
   *                         toggles on a publishing participant. Both sides
   *                         publish; neither can stop the other from doing so.
   *   `canSubscribe`        each side sees and hears the other.
   *   `canPublishData`      the data channel. Cheap, and it is what a "the
   *                         doctor has ended the call" signal or an in-call
   *                         note would use without a second transport.
   *   `canUpdateOwnMetadata: false`
   *                         participant metadata is set by the SERVER at mint
   *                         time or not at all. If a participant could rewrite
   *                         it, nothing carried in it could be trusted.
   *   `roomRecord` / `recorder`
   *                         ABSENT, and that is a requirement rather than an
   *                         omission: FR-8.6 and SRS 6.2 both say video and
   *                         audio are not recorded. No token this platform
   *                         mints can start an egress.
   *
   * *** `name` IS A ROLE LABEL, NOT A PERSON'S NAME. *** A token's claims are
   * readable by whoever holds it and are echoed to every other participant in
   * the room, so putting a patient's real name in one would publish it to a
   * surface with no access control of its own. The doctor gets the patient's
   * details from FR-8.4's consultation-room endpoint, which is authenticated,
   * authorised and audited; the call itself needs to know only which side is
   * which. SRS 6.2: "a patient sees only their own records."
   *
   * Throws nothing of its own on failure — it returns `null`, because any error
   * here was raised by code holding the API secret and must not be re-thrown
   * with its message intact. `video.service.ts` turns `null` into
   * `VIDEO_TOKEN_MINT_FAILED`.
   */
  async mintJoinToken(input: {
    roomName: string;
    identity: string;
    /** A role label — `Patient` or `Doctor`. See above: never a person's name. */
    displayName: string;
    ttlSeconds: number;
  }): Promise<string | null> {
    try {
      const token = new AccessToken(this.apiKey, this.apiSecret, {
        identity: input.identity,
        name: input.displayName,
        ttl: input.ttlSeconds,
      });

      token.addGrant({
        roomJoin: true,
        room: input.roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: false,
      });

      return await token.toJwt();
    } catch (error) {
      // Deliberately NOT interpolated into anything returned to a caller. The
      // stack was produced by code holding the API secret.
      this.logger.error(
        `Failed to mint a LiveKit join token for room ${input.roomName}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  /**
   * *** THE AUTH BOUNDARY FOR THE WEBHOOK. ***
   *
   * `WebhookReceiver#receive` does two things, and both are required: it
   * verifies the `Authorization` JWT against the API secret, and it compares
   * the SHA-256 of the body against that token's `sha256` claim. The second is
   * why the RAW BYTES matter — `shared/http/webhook-safe-json.parser.ts` keeps
   * them, and re-serialising a parsed object would produce a different digest
   * and fail every genuine delivery.
   *
   * Returns `null` for EVERY failure mode rather than throwing, so the caller
   * has exactly one rejection path and no branch can fall through to
   * "verified": a missing header, a bad signature, a digest mismatch, a body
   * that is not JSON, or an SDK error.
   */
  async verifyWebhook(rawBody: Buffer, authHeader: string | undefined): Promise<LivekitWebhookDelivery | null> {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return null;
    if (typeof authHeader !== 'string' || authHeader.length === 0) return null;

    const body = rawBody.toString('utf8');

    try {
      const event = await this.receiver.receive(body, authHeader);
      return this.toDelivery(event, body);
    } catch (error) {
      // A rejected delivery is a security event, so it is logged — but at
      // `warn` and WITHOUT the body, which is attacker-controlled, and without
      // the header, which is a bearer credential.
      this.logger.warn(
        `Rejected a LiveKit webhook delivery: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Flattens the SDK's protobuf event, taking `disconnect_reason` from the RAW
   * JSON so it is stored exactly as LiveKit spelled it. See
   * `LivekitWebhookDelivery`'s header for why the decoded event cannot supply
   * it.
   *
   * The raw parse cannot fail here: `receive` already parsed the same string,
   * so reaching this line means it is valid JSON. It is still wrapped, because
   * "cannot fail" is a claim about today's SDK.
   */
  private toDelivery(
    event: { event: string; id: string; room?: { name?: string }; participant?: unknown },
    body: string,
  ): LivekitWebhookDelivery {
    const participant = event.participant as
      | { sid?: string; identity?: string; joinedAt?: bigint; joinedAtMs?: bigint; disconnectReason?: number }
      | undefined;

    return {
      event: typeof event.event === 'string' ? event.event : '',
      id: typeof event.id === 'string' ? event.id : '',
      roomName: typeof event.room?.name === 'string' && event.room.name.length > 0 ? event.room.name : null,
      participant:
        participant && typeof participant.sid === 'string' && participant.sid.length > 0
          ? {
              sid: participant.sid,
              identity: typeof participant.identity === 'string' ? participant.identity : '',
              joinedAt: toJoinedAt(participant.joinedAtMs, participant.joinedAt),
              disconnectReason: readDisconnectReason(body, participant.disconnectReason),
            }
          : null,
    };
  }
}

/**
 * `joined_at`, from whichever of LiveKit's two fields is populated.
 *
 * `joinedAtMs` is preferred when non-zero — `joinedAt` is whole SECONDS, and
 * rounding a join time down by up to a second would systematically overstate
 * every connection's duration. Both are proto3 `int64`, so they arrive as
 * `bigint` and a missing value is `0n`, not `undefined`.
 *
 * `null` when neither is set. The caller substitutes its own receipt time
 * rather than inventing one here, because only it knows whether that is
 * defensible for the event in hand.
 */
function toJoinedAt(joinedAtMs: bigint | undefined, joinedAtSeconds: bigint | undefined): Date | null {
  if (typeof joinedAtMs === 'bigint' && joinedAtMs > 0n) return new Date(Number(joinedAtMs));
  if (typeof joinedAtSeconds === 'bigint' && joinedAtSeconds > 0n) return new Date(Number(joinedAtSeconds) * 1000);
  return null;
}

/**
 * LiveKit's `DisconnectReason` AS A NAME.
 *
 * Read from the RAW JSON first, because that is literally what LiveKit sent and
 * `docs/erd.sql` asks for it "verbatim". proto3 JSON encodes an enum as its
 * name, so a real delivery carries `"disconnect_reason": "CLIENT_INITIATED"`.
 *
 * proto3 JSON ALSO permits the numeric form, and a future server or a
 * hand-rolled sender may use it — so a numeric value falls back to the SDK's
 * own generated name table rather than being dropped. `UNKNOWN_REASON` (0) and
 * an absent field are both stored as `null`: the column means "why did this
 * connection end", and "we do not know" is better said with a null than with a
 * word that looks like an answer.
 *
 * Truncated to the column's 40 characters. LiveKit's longest current name is
 * well under that; the slice is there so a future one cannot fail an insert.
 */
function readDisconnectReason(body: string, decoded: number | undefined): string | null {
  try {
    const raw = JSON.parse(body) as { participant?: { disconnect_reason?: unknown; disconnectReason?: unknown } };
    const value = raw.participant?.disconnect_reason ?? raw.participant?.disconnectReason;
    if (typeof value === 'string' && value.length > 0 && value !== 'UNKNOWN_REASON') {
      return value.slice(0, 40);
    }
  } catch {
    // Unreachable in practice — `receive` parsed the same string. Falls through
    // to the decoded value rather than failing the delivery.
  }

  if (typeof decoded === 'number' && decoded > 0) {
    const name = DISCONNECT_REASON_NAMES[decoded];
    if (name !== undefined) return name.slice(0, 40);
  }
  return null;
}

/**
 * `livekit.DisconnectReason`, value -> name.
 *
 * A LOCAL COPY of the generated enum rather than an import of
 * `@livekit/protocol`'s reverse mapping, for one reason: that mapping is an
 * implementation detail of `@bufbuild/protobuf`'s `makeEnum`, not part of the
 * package's documented surface, and this module would break silently — storing
 * `null` where it used to store a reason — if a future version stopped emitting
 * it. It is only ever consulted on the NUMERIC fallback path, which a real
 * LiveKit server does not take.
 *
 * A value not on this list stores `null`, which is the correct answer for a
 * reason this release does not know the name of.
 */
const DISCONNECT_REASON_NAMES: Record<number, string> = {
  1: 'CLIENT_INITIATED',
  2: 'DUPLICATE_IDENTITY',
  3: 'SERVER_SHUTDOWN',
  4: 'PARTICIPANT_REMOVED',
  5: 'ROOM_DELETED',
  6: 'STATE_MISMATCH',
  7: 'JOIN_FAILURE',
  8: 'MIGRATION',
  9: 'SIGNAL_CLOSE',
  10: 'ROOM_CLOSED',
  11: 'USER_UNAVAILABLE',
  12: 'USER_REJECTED',
  13: 'SIP_TRUNK_FAILURE',
  14: 'CONNECTION_TIMEOUT',
  15: 'MEDIA_FAILURE',
};

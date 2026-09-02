/** What a redacted secret is replaced with. Keeps the last four so a log line still identifies WHICH key failed. */
export function maskedKey(last4: string): string {
  return `****${last4}`;
}

/**
 * Removes every occurrence of `secret` from `text`, replacing it with
 * `****<last4>`.
 *
 * This exists because vendor error text is not trustworthy input. Google's
 * Generative Language REST API takes its API key as a `?key=` QUERY
 * PARAMETER, so any error that echoes a request URL echoes the key with it;
 * OpenAI-compatible gateways in front of third-party hosts sometimes reflect
 * request headers into an error body for "debuggability". Either would put a
 * live, billable credential into our logs the first time it failed.
 *
 * Applied by `ai-rotation.service.ts` to every `LlmFailure.detail` before it
 * is logged, returned from the credential-test endpoint, or allowed anywhere
 * near an `audit_log` row — with the plaintext key that was actually used for
 * that attempt, which is the only place both halves are known at once.
 *
 * Short secrets are ignored rather than redacted: replacing an 8-character
 * string would corrupt unrelated text far more often than it would protect
 * anything, and no real provider key is that short.
 */
export function redactSecret(text: string, secret: string, last4: string): string {
  if (secret.length < 12) {
    return text;
  }
  return text.split(secret).join(maskedKey(last4));
}

/**
 * The last four characters of a key, for display. Shorter keys are
 * left-padded with `*` so the column is always exactly four characters —
 * `agent_credentials.key_last4` is `varchar(4)` and a shorter value would
 * silently render as a shorter mask.
 */
export function lastFour(key: string): string {
  return key.slice(-4).padStart(4, '*');
}

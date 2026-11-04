/**
 * The words a provider send failure is logged with (#1524).
 *
 * WHY. `wrapCallable` and `wrapTrigger` log an error's `message` and nothing
 * else of it, and that log line is what the real-services classifier
 * (`auntieos-admin/scripts/e2e-real/classify-run.mjs`, D3-e) reads to tell a
 * vendor outage from a refused request. Twilio's `RestException` keeps the HTTP
 * status in `err.status` and its error code in `err.code`, and its `message` is
 * the body text alone ("Service Unavailable", "Authentication Error - invalid
 * username"), so a wrapper that forwards the message drops the one number the
 * verdict rule turns on. A 5xx with no status reads as "no status code to
 * read" and stops the release, when during a listed incident it should warn.
 *
 * SHAPE. `<provider> send failed (HTTP <status>, code <code>): <message>`. The
 * classifier's STATUS_PATTERNS read `HTTP NNN` first, so the status wins over
 * any other number on the line, and the provider name is on every line because
 * the classifier attributes a line by vendor name (`\btwilio\b`, `\bsmtp2go\b`);
 * Twilio's body text never names Twilio. An error with neither status nor code
 * reads `<provider> send failed: <message>` as before.
 *
 * A message that already starts with `<provider> send failed` is passed through
 * unchanged: `lib/email.ts` throws exactly that, status included, so wrapping
 * it again would only double the prefix.
 *
 * Only `status`, `code` and `message` are read. Never the whole object, and
 * never Twilio's `moreInfo` or `details`: the auth token and the request are
 * not something a log line should carry.
 */

export type ProviderName = 'Twilio' | 'smtp2go';

export interface ProviderFailureFields {
  /** The HTTP status the provider answered with, when the error carries one. */
  providerStatus?: number;
  /** The provider's own error code (Twilio 20500, 21211; a Node code such as ECONNRESET on a network failure). */
  providerCode?: number | string;
}

/** A recipient to scrub out of the provider's text, which can quote it verbatim (Twilio 21211 does). */
export interface RecipientScrub {
  plain: string;
  masked: string;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function codeOf(err: unknown): number | string | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim().length > 0) return code.trim();
  return undefined;
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return String(err);
}

/** The status and code a provider error carries, as structured log fields. Empty when it carries none. */
export function providerFailureFields(err: unknown): ProviderFailureFields {
  const providerStatus = statusOf(err);
  const providerCode = codeOf(err);
  return {
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
}

/** The log and error message for a failed provider send. See the file comment for the shape. */
export function providerFailureMessage(provider: ProviderName, err: unknown, scrub?: RecipientScrub): string {
  let message = messageOf(err);
  if (scrub && scrub.plain.length > 0) message = message.split(scrub.plain).join(scrub.masked);
  const prefix = `${provider} send failed`;
  if (message.startsWith(prefix)) return message;
  const { providerStatus, providerCode } = providerFailureFields(err);
  const parts = [
    ...(providerStatus !== undefined ? [`HTTP ${providerStatus}`] : []),
    ...(providerCode !== undefined ? [`code ${providerCode}`] : []),
  ];
  return parts.length > 0 ? `${prefix} (${parts.join(', ')}): ${message}` : `${prefix}: ${message}`;
}

/**
 * A new Error carrying the described message, with the provider's `status` and
 * `code` copied onto it and the original as `cause`, for a sender that
 * rethrows (the notification dispatcher's SMS channel). The outer trigger
 * wrapper logs only `message`; Sentry still gets the original through `cause`.
 */
export function describeProviderFailure(provider: ProviderName, err: unknown, scrub?: RecipientScrub): Error {
  const out = new Error(providerFailureMessage(provider, err, scrub), { cause: err });
  const status = statusOf(err);
  const code = codeOf(err);
  return Object.assign(out, status !== undefined ? { status } : {}, code !== undefined ? { code } : {});
}

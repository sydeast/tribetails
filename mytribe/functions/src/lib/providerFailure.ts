/**
 * The words a provider send failure is logged with (#1524, #1531).
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
 * TIMEOUTS (#1531). A timeout is the other half of the verdict rule, and the
 * two real shapes carried no timeout word: smtp2go sends over `fetch`, and
 * undici's timeout throws `TypeError: fetch failed` with the code on
 * `err.cause.code` (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`,
 * `UND_ERR_BODY_TIMEOUT`); Twilio's SDK sends over axios, whose client timeout
 * is `code: 'ECONNABORTED'` with `timeout of <n>ms exceeded`. When the error
 * has no status, the code is read from `err.code` and then `err.cause.code`
 * (one level: that is where undici puts it), and a known timeout code reads
 * `<provider> send timed out (code <code>): <message>`. An error that answered
 * with a status is never a timeout, whatever its cause says.
 *
 * A message that already starts with `<provider> send failed` or `<provider>
 * send timed out` is passed through unchanged: `lib/email.ts` throws exactly
 * the former, status included, and `describeProviderFailure` builds both, so
 * wrapping again would only double the prefix.
 *
 * Only `status`, `code`, `message` and `cause.code` are read. Never the whole
 * object, and never Twilio's `moreInfo` or `details`: the auth token and the
 * request are not something a log line should carry.
 */

export type ProviderName = 'Twilio' | 'smtp2go';

export interface ProviderFailureFields {
  /** The HTTP status the provider answered with, when the error carries one. */
  providerStatus?: number;
  /** The provider's own error code (Twilio 20500, 21211; a Node, undici or axios code such as ECONNRESET or UND_ERR_CONNECT_TIMEOUT on a network failure). */
  providerCode?: number | string;
}

/** A recipient to scrub out of the provider's text, which can quote it verbatim (Twilio 21211 does). */
export interface RecipientScrub {
  plain: string;
  masked: string;
}

/** The codes that mean the request never got an answer in time (#1531). */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNABORTED',
  'ETIMEDOUT',
]);

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function ownCodeOf(err: unknown): number | string | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim().length > 0) return code.trim();
  return undefined;
}

/**
 * The error's code: its own, or, when it answered with no status, the code one
 * level down on `err.cause` (undici's `fetch failed` keeps it there).
 */
function codeOf(err: unknown, status: number | undefined): number | string | undefined {
  const own = ownCodeOf(err);
  if (own !== undefined || status !== undefined) return own;
  return ownCodeOf((err as { cause?: unknown })?.cause);
}

function isTimeout(status: number | undefined, code: number | string | undefined): boolean {
  return status === undefined && typeof code === 'string' && TIMEOUT_CODES.has(code);
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return String(err);
}

/** The status and code a provider error carries, as structured log fields. Empty when it carries none. */
export function providerFailureFields(err: unknown): ProviderFailureFields {
  const providerStatus = statusOf(err);
  const providerCode = codeOf(err, providerStatus);
  return {
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
}

/** The log and error message for a failed provider send. See the file comment for the shape. */
export function providerFailureMessage(provider: ProviderName, err: unknown, scrub?: RecipientScrub): string {
  let message = messageOf(err);
  if (scrub && scrub.plain.length > 0) message = message.split(scrub.plain).join(scrub.masked);
  if (message.startsWith(`${provider} send failed`) || message.startsWith(`${provider} send timed out`)) return message;
  const { providerStatus, providerCode } = providerFailureFields(err);
  const prefix = isTimeout(providerStatus, providerCode) ? `${provider} send timed out` : `${provider} send failed`;
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
  const { providerStatus: status, providerCode: code } = providerFailureFields(err);
  return Object.assign(out, status !== undefined ? { status } : {}, code !== undefined ? { code } : {});
}

/**
 * #1592: the operator was shown "updateInvoice validation failed [400]".
 *
 * Two things in that line are for a developer. The function name comes from
 * the server: every admin callable refuses a bad payload with
 * `HttpsError('invalid-argument', '<name> validation failed', { validationErrors })`.
 * The " [400]" comes from the Firebase JS SDK, which appends the HTTP status to
 * every callable error message (`_errorForResponse` in @firebase/functions:
 * `${description} [${httpStatus}]`). Android's SDK and the desktop console's
 * REST client do not add the status, but they show the same function name.
 *
 * `plainCallableMessage` is the one rule, mirrored on Android
 * (`CallableErrorText.kt`) and the desktop console (`CallableErrorText.kt`):
 *   - the status suffix is dropped;
 *   - "<name> validation failed", an empty message, or the SDK's stand-in text
 *     for a code ("internal", "Backend error status: ...") becomes a plain
 *     sentence for that code;
 *   - any other server message is already written for the operator ("Pick a
 *     date in 2025 or later") and is kept, so are the machine tokens screens
 *     match on (`no_recipients`, `recipient_opted_out`).
 * The raw text stays in the console and a Sentry breadcrumb (see `fns.ts`).
 */

/** The sentence for each callable code, when the server's own text is not for the operator. */
const PLAIN_BY_CODE: Record<string, string> = {
  'invalid-argument': 'Something in this form was not accepted. Check what you entered and try again.',
  'failed-precondition': 'This cannot be done right now. Reload the screen and try again.',
  'out-of-range': 'Something in this form was not accepted. Check what you entered and try again.',
  'permission-denied': 'Your account is not allowed to do this.',
  unauthenticated: 'You are signed out. Sign in again, then try once more.',
  'not-found': 'That record was not found. It may have been deleted.',
  'already-exists': 'That already exists.',
  aborted: 'This changed while you were working on it. Reload the screen and try again.',
  'resource-exhausted': 'Too many tries in a short time. Wait a minute and try again.',
  unavailable: 'The server could not be reached. Try again in a moment.',
  cancelled: 'That was cancelled before it finished. Try again.',
};

/** For `internal`, `unknown`, `unimplemented` and anything unnamed. */
export const CALLABLE_FALLBACK_TEXT = 'Something went wrong on our side. Try again in a moment.';

/** The SDK's own stand-ins for a code, and every code's bare name. */
const CODE_NAMES = new Set([
  ...Object.keys(PLAIN_BY_CODE),
  'internal',
  'unknown',
  'unimplemented',
  'deadline-exceeded',
  'data-loss',
  'ok',
]);

/** "updateInvoice validation failed", "formSchema validation failed". */
const VALIDATION_FAILED = /^[a-z][A-Za-z0-9]*( [a-z][A-Za-z0-9]*)? validation failed\.?$/;
const STATUS_SUFFIX = /\s*\[\d{3}\]\s*$/;
const SDK_STATUS_TEXT = /^(Unknown backend error status|Backend error status):/;

/**
 * The operator's sentence for a callable error. `code` is the SDK's code, with
 * or without the `functions/` prefix; `message` is what the SDK reported.
 */
export function plainCallableMessage(code: string, message: string): string {
  const bare = code.replace(/^functions\//, '');
  const text = message.replace(STATUS_SUFFIX, '').trim();
  const forDeveloper =
    text === '' || VALIDATION_FAILED.test(text) || SDK_STATUS_TEXT.test(text) || CODE_NAMES.has(text.toLowerCase());
  if (!forDeveloper) return text;
  return PLAIN_BY_CODE[bare] ?? CALLABLE_FALLBACK_TEXT;
}

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
 *     sentence for that code; on web so does the staff gate's "Admin claim
 *     required." (#2199, see `STAFF_GATE_TEXT`);
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
 * #2199: what the staff gate says to an account it does not let through
 * (`functions/src/lib/wrapAdminCallable.ts`, and the two gates beside it). An
 * Auntie read "Admin claim required." under a Complete she was refused. It
 * names a token field, so it is developer wording and takes the sentence for
 * its code. Web only: neither Android nor the desktop console lets an Auntie
 * sign in.
 */
const STAFF_GATE_TEXT = /^admin claim required\b/i;

/**
 * The operator's sentence for a callable error. `code` is the SDK's code, with
 * or without the `functions/` prefix; `message` is what the SDK reported.
 */
export function plainCallableMessage(code: string, message: string): string {
  const bare = code.replace(/^functions\//, '');
  const text = message.replace(STATUS_SUFFIX, '').trim();
  const forDeveloper =
    text === '' ||
    VALIDATION_FAILED.test(text) ||
    SDK_STATUS_TEXT.test(text) ||
    STAFF_GATE_TEXT.test(text) ||
    CODE_NAMES.has(text.toLowerCase());
  if (!forDeveloper) return text;
  return PLAIN_BY_CODE[bare] ?? CALLABLE_FALLBACK_TEXT;
}

/**
 * #2287: the sentence for a failure caught on a screen, whichever road it came
 * by. A callable's error is already plain by the time a screen catches it
 * (`lib/fns.ts`). A direct database read or write is not: its refusal arrives
 * as the SDK's own text ("Missing or insufficient permissions."), with the
 * reason on `code`. That code gets the same sentence a callable refusal gets.
 * Anything else keeps its own message, and a blank one gets `fallback`.
 */
export function plainFailureText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && !code.startsWith('functions/')) {
    const bare = code.replace(/^firestore\//, '');
    if (CODE_NAMES.has(bare)) return PLAIN_BY_CODE[bare] ?? CALLABLE_FALLBACK_TEXT;
  }
  const text = err.message.trim();
  return text === '' ? fallback : text;
}
/** The verb a callable's name starts with, as the operator would say it failed. */
const FAILED_TO: Record<string, string> = {
  get: 'Could not load', list: 'Could not load', load: 'Could not load', fetch: 'Could not load', read: 'Could not load',
  preview: 'Could not show the preview',
  save: 'Could not save', update: 'Could not save', set: 'Could not save', adjust: 'Could not save',
  assign: 'Could not save', unassign: 'Could not save', link: 'Could not save', log: 'Could not save',
  mark: 'Could not save', submit: 'Could not save', record: 'Could not save',
  delete: 'Could not delete', remove: 'Could not remove',
  create: 'Could not create', generate: 'Could not create',
  archive: 'Could not archive', unarchive: 'Could not restore', restore: 'Could not restore',
  approve: 'Could not approve', reject: 'Could not decline', complete: 'Could not complete',
  cancel: 'Could not cancel', schedule: 'Could not schedule', reschedule: 'Could not reschedule',
  send: 'Could not send', resend: 'Could not send', reply: 'Could not send', review: 'Could not send',
  retry: 'Could not retry',
};

/**
 * #1592: the lead of an error line that used to start with a function name
 * ("markInvoicePaid failed: ..."). "Could not save", "Could not load" and so on,
 * read off the verb the name starts with; the name itself is never shown.
 */
export function failedToLead(callableOrAction: string): string {
  const verb = /^[a-z]+/.exec(callableOrAction)?.[0] ?? '';
  return FAILED_TO[verb] ?? 'That did not go through';
}

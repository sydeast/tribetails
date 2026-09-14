/**
 * #866: THE TWO WAYS A NOTIFICATION CAN FAIL TO FIND ANYONE, KEPT APART.
 *
 * Before this, `enqueueNotificationDetailed` swallowed every resolver error and
 * treated it as "this resolver has nobody", so a Firestore read that failed
 * (the office roster, say) looked exactly like an office with no roster. A
 * caller that treats "nobody exists" as final (the Stripe webhook, which stops
 * retrying) would then give up on a notice that one retry would have delivered.
 *
 *   recipients-unavailable  a resolver has nobody BY DEFINITION: the caller gave
 *                           no household uid, the visit has no assigned Auntie,
 *                           the office roster is empty with no env fallback.
 *                           The dispatcher treats that resolver as empty.
 *   no-recipients           every resolver came back empty that way. Nobody
 *                           exists to receive this; retrying changes nothing.
 *
 * Anything else a resolver throws (a failed read) is rethrown by the dispatcher,
 * so the caller sees a real, retryable failure.
 *
 * Marked by `code` and checked by duck typing, not `instanceof`, so a module
 * loaded twice or mocked in a test cannot make the check silently false.
 */
export const RECIPIENTS_UNAVAILABLE_CODE = 'recipients-unavailable';
export const NO_RECIPIENTS_CODE = 'no-recipients';

/** A resolver has nobody by definition. The dispatcher treats it as empty. */
export class RecipientsUnavailableError extends Error {
  readonly code = RECIPIENTS_UNAVAILABLE_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RecipientsUnavailableError';
  }
}

/** Every resolver was empty by definition. Final: nobody exists to receive it. */
export class NoRecipientsError extends Error {
  readonly code = NO_RECIPIENTS_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'NoRecipientsError';
  }
}

function codeOf(err: unknown): unknown {
  return err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

export function isRecipientsUnavailable(err: unknown): boolean {
  return codeOf(err) === RECIPIENTS_UNAVAILABLE_CODE;
}

export function isNoRecipientsError(err: unknown): boolean {
  return codeOf(err) === NO_RECIPIENTS_CODE;
}

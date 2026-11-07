/**
 * ISSUE #1608: the operator's "Verify arrival and departure" rule, checked on
 * the client BEFORE a Complete is confirmed.
 *
 * The rule is the server's. `transitionBookingStatus` refuses COMPLETE with
 * `arrival_verification_required` when the switch is on and the session has no
 * `arrivedAt` or no `departedAt` (`mytribe/functions/src/lib/arrivalVerification.ts`,
 * `missingVisitSteps` and `arrivalVerificationMessage`). Before this, the
 * operator confirmed, waited out a cold start, and only then read a refusal the
 * app could have given before the confirm. This file is a line-for-line mirror
 * of those two functions plus the setting read, so the client says the same
 * thing the server would have said, before anything is sent. The server check
 * stays: this only saves the round trip, it is not the enforcement.
 *
 * ABSENT MEANS OFF, as on the server. Only an explicit `true` on
 * `business_settings.requireArrivalDepartureVerification` turns the rule on.
 * The settings model (`api/settings.ts`) defaults the field to `true` for the
 * editor, so this file reads the raw document value instead; reading the
 * merged model would refuse visits the server would let through.
 *
 * Steps only. The #582 distance gate (arrival recorded too far from the
 * household) stays a server-side check: it is decided against a radius and an
 * accuracy the server owns, and its refusal already names the distance.
 */

/** The two stamps a session carries, as they come off the document. */
export interface VisitStamps {
  arrivedAt?: unknown;
  departedAt?: unknown;
}

/** Is the rule on, read off the raw settings document the way the server reads it? */
export function arrivalRuleRequired(rawSettings: Record<string, unknown> | undefined): boolean {
  return rawSettings?.requireArrivalDepartureVerification === true;
}

function stamped(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * Which of the two steps this visit is missing, in the order they happen.
 * Mirrors the server's `missingVisitSteps`: both stamps default to `""` on the
 * document, so a blank string counts as missing exactly as an absent key does.
 */
export function missingVisitSteps(session: VisitStamps): Array<'arrival' | 'departure'> {
  const missing: Array<'arrival' | 'departure'> = [];
  if (!stamped(session.arrivedAt)) missing.push('arrival');
  if (!stamped(session.departedAt)) missing.push('departure');
  return missing;
}

/** The server's refusal, word for word, so both places read the same. */
export function arrivalVerificationMessage(missing: readonly string[]): string {
  const steps = missing.length === 2 ? 'arrival and departure' : missing[0];
  return (
    `This visit has no ${steps} recorded, and your settings require ${missing.length === 2 ? 'both' : 'it'} ` +
    'before a visit can be marked complete. Mark it on the visit card first, or turn off ' +
    '"Verify arrival and departure" in Settings.'
  );
}

/**
 * Why Complete would be refused, or null when it may go ahead.
 *
 * `required` is null while the setting is still loading or could not be read:
 * the client does not guess, it lets the server decide, which is what happened
 * before this check existed.
 */
export function completeRefusal(required: boolean | null, session: VisitStamps): string | null {
  if (required !== true) return null;
  const missing = missingVisitSteps(session);
  return missing.length === 0 ? null : arrivalVerificationMessage(missing);
}

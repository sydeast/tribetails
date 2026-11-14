import type { StartFix } from '../api/sessionsWrite';

/**
 * #2279, operator ruling 2026-11-14: with "Verify arrival and departure" on, an
 * Auntie cannot start a visit (On my way, Arrived) from outside the range of
 * the household. Only the owner can.
 *
 * THE RULE AND THE RANGE ARE THE SERVER'S. `setVisitLifecycle` measures her
 * position against the household and refuses in its own words
 * (`functions/src/lib/visitStartRange.ts`). Nothing here computes a distance or
 * knows the range. This file gets the position the server needs, and holds the
 * two sentences the server cannot send.
 */

const FIX_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

/**
 * One position, asked for NOW. Call it synchronously inside the click that
 * confirms the step: the browser ties its location prompt to a user gesture,
 * the same reason `visitTracking.ts#beginVisitTracking` asks inside the click.
 * An arrival asks twice in one gesture (this, and the tracker) and the browser
 * shows one prompt for both.
 *
 * Resolves null when there is no position to send: no geolocation in this
 * browser, the prompt refused, or no fix inside the timeout. Never rejects.
 */
export function requestStartFix(): Promise<StartFix | null> {
  const geo = typeof navigator !== 'undefined' && 'geolocation' in navigator ? navigator.geolocation : null;
  if (!geo) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      geo.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            resolve(null);
            return;
          }
          resolve({
            lat: latitude,
            lng: longitude,
            ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyMeters: accuracy } : {}),
          });
        },
        () => resolve(null),
        FIX_OPTIONS,
      );
    } catch {
      resolve(null);
    }
  });
}

/** The two steps that start a visit. Departed and Undo arrival are not held to the range. */
export function startsVisit(action: string): action is 'ON_MY_WAY' | 'ARRIVED' {
  return action === 'ON_MY_WAY' || action === 'ARRIVED';
}

/**
 * What an Auntie reads when `firestore.rules` refused her own start write. That
 * happens when this screen still held "the rule is off" from before the owner
 * switched it on, and a rules refusal carries no words of its own. Her next tap
 * goes through the server, which measures and answers properly.
 */
export const START_NEEDS_PROPERTY_MESSAGE =
  'You need to be at the property to start this visit. Tap again and allow location when asked. ' +
  'The owner can also start it.';

/** Was this a refusal by the rules, as opposed to a network or validation failure? */
export function isRulesRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'permission-denied' || code === 'firestore/permission-denied';
}

/** Metres as they are read on a card: `40 m`, `1.2 km`. Matches the server's `formatDistance`. */
export function formatRangeDistance(meters: number): string {
  if (!Number.isFinite(meters)) return 'an unknown distance';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * What the OWNER reads after arriving outside the range, or '' when there is
 * nothing to say. The owner is allowed to; the sentence says it was recorded.
 * Silent inside the range, silent with the rule off, and silent when nothing
 * could be measured: an arrival is not a moment for a sentence about nothing.
 */
export function ownerOutsideRangeSentence(check: {
  status: string;
  distanceMeters: number | null;
  verificationRequired: boolean;
}): string {
  if (!check.verificationRequired || check.status !== 'outside' || check.distanceMeters === null) return '';
  return (
    `You arrived ${formatRangeDistance(check.distanceMeters)} from this household, outside the range. ` +
    'That is recorded on the visit and in the Activity Log.'
  );
}

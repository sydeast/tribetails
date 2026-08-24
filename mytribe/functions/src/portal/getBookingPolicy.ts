import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveBookingPolicy, type BookableTimeBlock, type BookingMode } from '../lib/bookingTimeBlocks';

/**
 * How a household is allowed to say WHEN, and which named windows it may pick.
 *
 * Operator requirement, 2026-08-24: "kinfolk book within time blocks, not at a
 * specific set time." The windows themselves have lived on
 * `business_settings.timeBlocks` for months and, along with the three mode
 * switches, were read by nothing. This callable is the portal's seam onto them.
 *
 * SAME SHAPE OF THING AS `getBusinessClosures.ts`, and for the same reason:
 * `business_settings` is admin-only in `firestore.rules`
 * (`allow read: if isAuntie() || isTestAdmin();`), so the booking wizard cannot
 * read the doc the admin apps read. That is deliberate for the doc AS A WHOLE —
 * rates, integration state, notification policy, GPS and retention settings are
 * none of a household's business — but a household DOES have to know which
 * windows it may choose between, or the wizard is asking it to guess.
 *
 * ── EXACTLY WHAT CROSSES THE BOUNDARY ────────────────────────────────────────
 *
 *   allowTimeBlockBooking     bool
 *   allowSpecificTimeBooking  bool
 *   defaultBookingMode        'SPECIFIC_TIME' | 'TIME_BLOCK'
 *   timeBlocks[]              id, label, startTime, endTime, durationMinutes
 *
 * and NOTHING else. Not `timeZone`, not `defaultTimeBlockDurationHours` (it is
 * consumed server-side, as a fallback END for a legacy row, and folded into the
 * `endTime`/`durationMinutes` a client actually needs), not `businessHours`,
 * not `serviceRates` — the catalog has its own callable. This is a projection,
 * never a document read: adding a field here is a decision that a household
 * should see it.
 *
 * The values are the NORMALIZED ones from `lib/bookingTimeBlocks.ts`, not the
 * stored ones, and `requestBooking` validates against that same resolver. That
 * is the property worth protecting: what the wizard is told it may send and
 * what the server will accept are decoded by one function, so they cannot drift
 * into a portal that offers a control the write path refuses.
 */

export interface TimeBlockDto {
  id: string;
  label: string;
  /** `HH:MM` in the business's timezone, inclusive. */
  startTime: string;
  /** `HH:MM` in the business's timezone, exclusive. */
  endTime: string;
  durationMinutes: number;
}

export interface GetBookingPolicyResult {
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
  defaultBookingMode: BookingMode;
  timeBlocks: TimeBlockDto[];
}

/** The projection, spelled out field by field so an added `BookableTimeBlock` field cannot leak by spread. */
function toDto(block: BookableTimeBlock): TimeBlockDto {
  return {
    id: block.id,
    label: block.label,
    startTime: block.startTime,
    endTime: block.endTime,
    durationMinutes: block.durationMinutes,
  };
}

export async function getBookingPolicyHandler(
  req: CallableRequest<unknown>,
): Promise<GetBookingPolicyResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let raw: unknown = {};
  try {
    const snap = await db().collection('business_settings').doc('business_settings').get();
    raw = snap.data() ?? {};
  } catch (err) {
    // A settings read that fails must not take the wizard down: the resolver's
    // own defaults (both modes allowed, no blocks -> block booking off) are a
    // usable, honest policy, and they are the pre-time-block behaviour exactly.
    logEvent({
      severity: 'warn',
      function: 'getBookingPolicy',
      event: 'settings.read.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }

  const { policy, degrades } = resolveBookingPolicy(raw);

  logEvent({
    severity: degrades.length > 0 ? 'warn' : 'info',
    function: 'getBookingPolicy',
    event: 'portal.bookingPolicy.resolved',
    uid,
    extra: {
      allowTimeBlockBooking: policy.allowTimeBlockBooking,
      allowSpecificTimeBooking: policy.allowSpecificTimeBooking,
      defaultBookingMode: policy.defaultBookingMode,
      blockCount: policy.timeBlocks.length,
      // Named, not counted: 'no-usable-blocks' means an operator turned block
      // booking on and every stored row was unreadable, which is a settings bug
      // nobody would otherwise find out about.
      degrades,
    },
  });

  return {
    allowTimeBlockBooking: policy.allowTimeBlockBooking,
    allowSpecificTimeBooking: policy.allowSpecificTimeBooking,
    defaultBookingMode: policy.defaultBookingMode,
    timeBlocks: policy.timeBlocks.map(toDto),
  };
}

export const getBookingPolicy = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getBookingPolicy', getBookingPolicyHandler),
);

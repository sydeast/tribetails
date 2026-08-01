import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { parseClosureEntry, closureOccurrencesInRange } from '../lib/closureRecurrence';

/**
 * C1: the ONE way a kinfolk client can find out which dates are closed.
 *
 * `business_settings` (where `companyHolidays` lives) is admin-only in
 * `firestore.rules` (`allow read: if isAuntie() || isTestAdmin();`), so the
 * portal's booking wizard cannot read the raw doc the way the admin apps do.
 * That is deliberate for the doc as a whole (rates, notification toggles,
 * integration state are none of a household's business), but a household DOES
 * need to know which of the dates it is about to tap are closed -- otherwise
 * the portal's month picker looks authoritative about a day it cannot actually
 * book (`requestBooking` will refuse it server-side either way, but a picker
 * that offers a doomed date is worse than one that marks it up front).
 *
 * This callable is the narrow, read-only seam that answers exactly that
 * question, and nothing else off the doc: it returns concrete closed dates
 * inside a caller-supplied, capped range, resolved server-side through the
 * SAME `closureRecurrence.ts` yearly-recurrence math `requestBooking`'s guard
 * uses (`lib/companyHolidayConflict.ts`), so what the picker marks and what
 * the server will actually refuse can never drift into two different
 * calendars decoded two different ways.
 */

const MAX_RANGE_DAYS = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const Args = z.object({
  /** `YYYY-MM-DD`, inclusive. */
  fromDate: z.string().regex(DATE_RE, 'fromDate must be YYYY-MM-DD'),
  /** `YYYY-MM-DD`, inclusive. */
  toDate: z.string().regex(DATE_RE, 'toDate must be YYYY-MM-DD'),
});

export interface BusinessClosureDto {
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
}

export interface GetBusinessClosuresResult {
  closures: BusinessClosureDto[];
}

/** Whole-day span in ms, for the range-size gate below. */
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getBusinessClosuresHandler(
  req: CallableRequest<unknown>,
): Promise<GetBusinessClosuresResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getBusinessClosures validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  if (args.toDate < args.fromDate) {
    throw new HttpsError('invalid-argument', 'toDate must not be before fromDate.');
  }
  // Bounded so a caller cannot force a years-long recurrence expansion per
  // request; the booking wizards this backs only ever need a few weeks to a
  // few months of lookahead at a time.
  const spanDays = (Date.parse(`${args.toDate}T00:00:00.000Z`) - Date.parse(`${args.fromDate}T00:00:00.000Z`)) / DAY_MS;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new HttpsError('invalid-argument', `Range too wide: max ${MAX_RANGE_DAYS} days.`);
  }

  const settingsSnap = await db().collection('business_settings').doc('business_settings').get();
  const raw = settingsSnap.data()?.companyHolidays;
  const entries = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').map(parseClosureEntry) : [];

  const closures: BusinessClosureDto[] = [];
  for (const entry of entries) {
    for (const date of closureOccurrencesInRange(entry, args.fromDate, args.toDate)) {
      closures.push({ date, name: entry.name.trim() || 'Closed' });
    }
  }
  closures.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  logEvent({
    severity: 'info',
    function: 'getBusinessClosures',
    event: 'portal.businessClosures.resolved',
    uid,
    extra: { fromDate: args.fromDate, toDate: args.toDate, count: closures.length },
  });
  return { closures };
}

export const getBusinessClosures = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getBusinessClosures', getBusinessClosuresHandler),
);

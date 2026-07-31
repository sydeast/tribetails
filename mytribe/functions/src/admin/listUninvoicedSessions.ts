import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema } from '../lib/invoiceResponseSchema';

/**
 * Completed visits in a date window that no invoice has claimed yet, priced
 * from the rate card where that is possible. The read half of "turn last
 * month's work into an invoice"; it writes nothing.
 *
 * FOUR THINGS ABOUT `kin_care_sessions` MAKE THE OBVIOUS QUERY WRONG, and each
 * one is a silent failure rather than an error, so they are all handled here
 * and all covered by a test.
 *
 * 1. `invoiceId` IS OFTEN ABSENT, NOT EMPTY. `createKinCareSession` and
 *    `approveBookingSeriesCore` never write the field at all, and Firestore
 *    equality SKIPS documents that lack the field, so
 *    `where('invoiceId', '==', '')` would silently miss every session either of
 *    them created, which is most of them. Unlinking, meanwhile, writes `''`
 *    rather than deleting (`AuntieRepository.updateSessionInvoiceId`). So the
 *    filter is applied in memory over the loaded page, treating absent, empty
 *    and whitespace alike.
 *
 * 2. `status` CASING IS UNENFORCED. The field is a raw string with no
 *    validator, and the repo already normalizes it at every read site. A visit
 *    stored as `completed` is as done as one stored as `COMPLETED`.
 *
 * 3. `startTime` IS AN ISO-8601 STRING, not a Timestamp. Firestore orders every
 *    timestamp after every string, so a range query against a `Timestamp` here
 *    returns nothing and does not error. The window is therefore a LEXICAL
 *    range on the string, which works precisely because the format is ISO. Same
 *    technique as `optimizeRoute`.
 *
 * 4. A SESSION CARRIES NO PRICE. There is no rate, price or amount field on the
 *    model. The only route to money is joining `serviceType` against
 *    `business_settings.serviceRates`, which is keyed BY NAME and holds dollars
 *    as strings.
 *
 * STATUS IS FILTERED IN MEMORY, NOT SERVER-SIDE, and that is deliberate even
 * though `(status ASC, startTime DESC)` is a deployed index. A server equality
 * on `status` would inherit problem 2: it would drop every visit whose status
 * was written in the wrong case, and drop it INVISIBLY, which on this callable
 * means quietly not billing for real work. A lexical range on `startTime` alone
 * needs no composite index, so nothing is paid for the safer read.
 *
 * NOTHING IS EVER PRICED AT ZERO BY DEFAULT. A `serviceType` the rate card does
 * not hold, a rate that will not parse, and a rate of zero or less all resolve
 * to `unitCents: null` plus an entry in `unpriceable`. A silent 0 would bill a
 * household nothing for real work and look deliberate on the invoice. The
 * caller is told which sessions need a price typed in, and `rateCardLoaded`
 * distinguishes "this service is not on the card" from "there is no card".
 */

/** Exported so the callable-contract drift guard can freeze this request shape. */
export const Args = z
  .object({
    /** Inclusive window start, `YYYY-MM-DD`. Compared lexically against the ISO `startTime`. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
    /** Inclusive window end, `YYYY-MM-DD`. */
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  })
  .strict()
  .refine((a) => a.from <= a.to, { message: 'from must not be after to', path: ['from'] });

export type ListUninvoicedSessionsArgs = z.infer<typeof Args>;

/**
 * Page cap. Generous next to a real month of visits, and bounded so one call
 * cannot read an unbounded collection. `truncated` tells the caller when the
 * cap was actually reached, so an empty or short result is never mistaken for a
 * complete one.
 */
const MAX_SESSIONS = 500;

const SESSIONS_COLLECTION = 'kin_care_sessions';
const SETTINGS_DOC = 'business_settings/business_settings';

/** One completed, unclaimed visit, as the invoice composer needs it. */
const UninvoicedSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    kinfolkId: z.string(),
    serviceType: z.string(),
    durationMinutes: z.number(),
    /** ISO-8601 STRING on this collection, never a Timestamp. See the header. */
    startTime: z.string(),
    /**
     * Integer cents from the rate card, or NULL when it could not be priced.
     *
     * `.nullable()`, never `.optional()`, and that distinction is the whole
     * point of the field: an ABSENT key would let a client read it as 0 and
     * bill a household nothing for real work. Null is a value that has to be
     * handled.
     */
    unitCents: CentsSchema.nullable(),
  })
  .strict();

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS types
 * below.
 *
 * NO `ok` FIELD, unlike every write on this surface. This is a pure read: it
 * answers with data or it throws, and there is no partial success for it to
 * report. Kept as it ships rather than "tidied" into the `ok` convention,
 * because the React admin returns this response object verbatim.
 */
export const Result = z
  .object({
    sessions: z.array(UninvoicedSessionSchema),
    /** Sessions returned above with no usable rate, so the caller can prompt for one. */
    unpriceable: z.array(z.object({ sessionId: z.string(), serviceType: z.string() }).strict()),
    /**
     * Billable sessions carrying an EMPTY `startTime`, which no date window can
     * ever reach. The window above is a lexical range on the ISO string, so ''
     * sorts before every real date and such a session is invisible to this
     * callable, to `optimizeRoute` and to the calendar push. Reported rather
     * than dropped: an unbillable visit that nobody can see is how real work
     * goes unpaid, and the operator can only fix what is named.
     */
    unplaceable: z.array(z.object({ sessionId: z.string(), kinfolkId: z.string() }).strict()),
    /** False when `business_settings.serviceRates` is missing, so a miss is not a real miss. */
    rateCardLoaded: z.boolean(),
    /** Rows read before filtering. An empty result over 400 scanned rows means something. */
    scanned: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .strict();

export type UninvoicedSession = z.infer<typeof UninvoicedSessionSchema>;
export type ListUninvoicedSessionsResult = z.infer<typeof Result>;

/** The day after `day` (`YYYY-MM-DD`), so an inclusive `to` becomes an exclusive bound. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** True when this session is done. Case and padding are not guaranteed by any writer. */
function isCompleted(status: unknown): boolean {
  return typeof status === 'string' && status.trim().toUpperCase() === 'COMPLETED';
}

/**
 * True when nothing has claimed this session. Absent, empty and whitespace are
 * one state: unclaimed. See point 1 in the file comment.
 */
function isUnclaimed(invoiceId: unknown): boolean {
  if (invoiceId === undefined || invoiceId === null) return true;
  return typeof invoiceId === 'string' && invoiceId.trim() === '';
}

/**
 * A rate-card entry as integer cents, or null when it cannot be trusted.
 *
 * `serviceRates` stores dollars as strings (`"25.00"`), though numbers appear in
 * older documents, so both are accepted. Zero and negative are refused rather
 * than passed through: a zero on the card is far more likely to be a blank
 * someone never filled in than a service the business genuinely gives away, and
 * guessing wrong bills nothing for real work.
 */
function rateToCents(rate: unknown): number | null {
  const dollars = typeof rate === 'number' ? rate : typeof rate === 'string' ? Number.parseFloat(rate) : NaN;
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export async function listUninvoicedSessionsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: ListUninvoicedSessionsArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listUninvoicedSessions validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const firestore = db();

  // Lexical range on the ISO string; `to` is inclusive, so the exclusive bound
  // is the day after it. No status predicate here on purpose (see the header).
  const snap = await firestore
    .collection(SESSIONS_COLLECTION)
    .where('startTime', '>=', args.from)
    .where('startTime', '<', nextDay(args.to))
    .orderBy('startTime', 'desc')
    .limit(MAX_SESSIONS)
    .get();

  const settingsSnap = await firestore.doc(SETTINGS_DOC).get();
  const rawRates = (settingsSnap.data() ?? {})['serviceRates'];
  const rateCardLoaded =
    typeof rawRates === 'object' && rawRates !== null && !Array.isArray(rawRates);
  const rates = rateCardLoaded ? (rawRates as Record<string, unknown>) : {};

  // The window above cannot reach a session whose startTime is ''. One extra
  // equality read finds exactly those. It needs no composite index (equality on
  // a single field is served by the automatic index), and it is bounded by the
  // same page size. A session MISSING the field entirely is still unreachable,
  // because Firestore cannot query for absence; no writer produces that shape
  // (`createKinCareSession` requires min(1) and `approveBookingSeriesCore` now
  // refuses an empty one), and prod carries none, so the gap is documented
  // rather than papered over with a full-collection scan.
  const unplaceableSnap = await firestore
    .collection(SESSIONS_COLLECTION)
    .where('startTime', '==', '')
    .limit(MAX_SESSIONS)
    .get();

  const sessions: UninvoicedSession[] = [];
  const unpriceable: Array<{ sessionId: string; serviceType: string }> = [];
  const unplaceable: Array<{ sessionId: string; kinfolkId: string }> = [];

  for (const d of unplaceableSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    // Same two filters the window uses, so this reports only sessions that
    // WOULD be billable. An already-invoiced or unfinished visit with a broken
    // startTime is a different problem and not this callable's to raise.
    if (!isCompleted(data['status'])) continue;
    if (!isUnclaimed(data['invoiceId'])) continue;
    unplaceable.push({
      sessionId: d.id,
      kinfolkId: typeof data['kinfolkId'] === 'string' ? data['kinfolkId'] : '',
    });
  }

  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (!isCompleted(data['status'])) continue;
    if (!isUnclaimed(data['invoiceId'])) continue;

    const serviceType = typeof data['serviceType'] === 'string' ? data['serviceType'] : '';
    const unitCents = rateCardLoaded ? rateToCents(rates[serviceType]) : null;
    if (unitCents === null) unpriceable.push({ sessionId: d.id, serviceType });

    sessions.push({
      sessionId: d.id,
      kinfolkId: typeof data['kinfolkId'] === 'string' ? data['kinfolkId'] : '',
      serviceType,
      durationMinutes:
        typeof data['serviceDurationMinutes'] === 'number' ? data['serviceDurationMinutes'] : 0,
      startTime: typeof data['startTime'] === 'string' ? data['startTime'] : '',
      unitCents,
    });
  }

  logEvent({
    severity: 'info',
    function: 'listUninvoicedSessions',
    event: 'admin.invoice.uninvoiced.listed',
    uid,
    extra: {
      from: args.from,
      to: args.to,
      scanned: snap.docs.length,
      matched: sessions.length,
      unpriceable: unpriceable.length,
      unplaceable: unplaceable.length,
      rateCardLoaded,
    },
  });

  return validateResponse('listUninvoicedSessions', Result, {
    sessions,
    unpriceable,
    unplaceable,
    rateCardLoaded,
    scanned: snap.docs.length,
    truncated: snap.docs.length >= MAX_SESSIONS,
  });
}

export const listUninvoicedSessions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listUninvoicedSessions', listUninvoicedSessionsHandler),
);

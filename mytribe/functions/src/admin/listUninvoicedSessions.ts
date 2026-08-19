import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema } from '../lib/invoiceResponseSchema';
import {
  isSessionCompleted,
  isSessionDoNotInvoice,
  isSessionUnclaimed,
  sessionDoNotInvoiceReason,
} from '../lib/sessionInvoicing';

/**
 * Completed visits that no invoice has claimed yet, priced from the rate card
 * where that is possible. The read half of "turn this household's work into an
 * invoice"; it writes nothing.
 *
 * SCOPED BY HOUSEHOLD, AND THE DATE RANGE IS NOW OPTIONAL (#408). The composer
 * asks one question, which household, and the work appears. It used to demand a
 * date range as well, defaulting to the last 30 days, which meant the operator
 * had to already know when the work happened in order to bill it: a visit from
 * five weeks ago produced a correct, confident "no un-invoiced visits" and no
 * hint that a wider window would find one. `kinfolkId` narrows the read at the
 * server instead, so all of a household's outstanding work arrives at once, and
 * the range survives as a NARROWING option for the case where the page cap is
 * actually reached.
 *
 * THE HOUSEHOLD-SCOPED READ NEEDS NO NEW INDEX. `kin_care_sessions
 * (kinfolkId ASC, startTime DESC)` is already declared in
 * `mytribe/firestore.indexes.json`, and `portal/getMyVisits.ts` has been
 * running exactly this equality-plus-order against it in production since long
 * before this change.
 *
 * FOUR THINGS ABOUT `kin_care_sessions` MAKE THE OBVIOUS QUERY WRONG, and each
 * one is a silent failure rather than an error, so they are all handled here
 * and all covered by a test. The predicates themselves now live in
 * `lib/sessionInvoicing.ts` so that `setSessionDoNotInvoice` cannot disagree
 * with this list about which visits exist.
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
 *    returns nothing and does not error. The optional window is therefore a
 *    LEXICAL range on the string, which works precisely because the format is
 *    ISO. Same technique as `optimizeRoute`.
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
 * means quietly not billing for real work.
 *
 * WORK THE OPERATOR HAS DECIDED NEVER TO BILL comes back in its own list rather
 * than vanishing (#408). `setSessionDoNotInvoice` is what puts a visit there;
 * `excluded` is how the composer offers to put it back. Without both halves the
 * queue only ever grows, and no count taken from it can be trusted.
 *
 * NOTHING IS EVER PRICED AT ZERO BY DEFAULT. A `serviceType` the rate card does
 * not hold, a rate that will not parse, and a rate of zero or less all resolve
 * to `unitCents: null` plus an entry in `unpriceable`. A silent 0 would bill a
 * household nothing for real work and look deliberate on the invoice. The
 * caller is told which sessions need a price typed in, and `rateCardLoaded`
 * distinguishes "this service is not on the card" from "there is no card".
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Exported so the callable-contract drift guard can freeze this request shape. */
export const Args = z
  .object({
    /**
     * Only this household's visits. Optional, for the callers that predate the
     * #408 composer; supplying it narrows the read at the SERVER, which is what
     * lets the date range be dropped.
     */
    kinfolkId: z.string().min(1).max(200).optional(),
    /** Inclusive window start, `YYYY-MM-DD`. Compared lexically against the ISO `startTime`. */
    from: z.string().regex(DAY, 'from must be YYYY-MM-DD').optional(),
    /** Inclusive window end, `YYYY-MM-DD`. */
    to: z.string().regex(DAY, 'to must be YYYY-MM-DD').optional(),
  })
  .strict()
  // BOTH DATES OR NEITHER. A window with one end is not a narrower window, it
  // is a different question ("everything since", "everything until"), and no
  // caller asks it. Half a range is far more likely to be a caller that lost a
  // field on the way than a deliberate open-ended read.
  .refine((a) => (a.from === undefined) === (a.to === undefined), {
    message: 'from and to must be given together, or both left out',
    path: ['from'],
  })
  .refine((a) => a.from === undefined || a.to === undefined || a.from <= a.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

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

/** One visit the operator has taken out of the queue on purpose. */
const ExcludedSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    kinfolkId: z.string(),
    serviceType: z.string(),
    startTime: z.string(),
    /** The operator's note, or '' when they gave none. Never null: it is text, or it is absent text. */
    reason: z.string(),
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
     * ever reach. The optional window is a lexical range on the ISO string, so
     * '' sorts before every real date and such a session is invisible to a
     * windowed read of this callable, to `optimizeRoute` and to the calendar
     * push. Reported rather than dropped: an unbillable visit that nobody can
     * see is how real work goes unpaid, and the operator can only fix what is
     * named.
     */
    unplaceable: z.array(z.object({ sessionId: z.string(), kinfolkId: z.string() }).strict()),
    /**
     * Completed, unclaimed visits the operator has marked do-not-invoice. They
     * are NOT in `sessions`: they are out of the queue by decision. Returned so
     * that decision stays visible, and reversible, in the same place it was
     * taken.
     */
    excluded: z.array(ExcludedSessionSchema),
    /** False when `business_settings.serviceRates` is missing, so a miss is not a real miss. */
    rateCardLoaded: z.boolean(),
    /** Rows read before filtering. An empty result over 400 scanned rows means something. */
    scanned: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .strict();

export type UninvoicedSession = z.infer<typeof UninvoicedSessionSchema>;
export type ExcludedSession = z.infer<typeof ExcludedSessionSchema>;
export type ListUninvoicedSessionsResult = z.infer<typeof Result>;

/** The day after `day` (`YYYY-MM-DD`), so an inclusive `to` becomes an exclusive bound. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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

/** A string field read off a document nothing validates on write. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
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

  // Equality on the household first, then the optional lexical window on the
  // ISO string, then the order. That is exactly the shape of the declared
  // `(kinfolkId ASC, startTime DESC)` composite; with no household it is a
  // single-field order, which every collection has automatically. No status
  // predicate here on purpose (see the header).
  let query = firestore.collection(SESSIONS_COLLECTION) as FirebaseFirestore.Query;
  if (args.kinfolkId !== undefined) query = query.where('kinfolkId', '==', args.kinfolkId);
  if (args.from !== undefined && args.to !== undefined) {
    query = query.where('startTime', '>=', args.from).where('startTime', '<', nextDay(args.to));
  }
  const snap = await query.orderBy('startTime', 'desc').limit(MAX_SESSIONS).get();

  const settingsSnap = await firestore.doc(SETTINGS_DOC).get();
  const rawRates = (settingsSnap.data() ?? {})['serviceRates'];
  const rateCardLoaded =
    typeof rawRates === 'object' && rawRates !== null && !Array.isArray(rawRates);
  const rates = rateCardLoaded ? (rawRates as Record<string, unknown>) : {};

  // The ordered read above cannot reach a session whose startTime is '' while a
  // window is set, and sorts it last when one is not. One extra equality read
  // finds exactly those. Scoped to the same household when there is one, which
  // the same composite serves (both clauses are equalities on its two fields).
  // A session MISSING the field entirely is still unreachable, because
  // Firestore cannot query for absence; no writer produces that shape
  // (`createKinCareSession` requires min(1) and `approveBookingSeriesCore` now
  // refuses an empty one), and prod carries none, so the gap is documented
  // rather than papered over with a full-collection scan.
  let unplaceableQuery = firestore
    .collection(SESSIONS_COLLECTION)
    .where('startTime', '==', '') as FirebaseFirestore.Query;
  if (args.kinfolkId !== undefined) {
    unplaceableQuery = unplaceableQuery.where('kinfolkId', '==', args.kinfolkId);
  }
  const unplaceableSnap = await unplaceableQuery.limit(MAX_SESSIONS).get();

  const sessions: UninvoicedSession[] = [];
  const unpriceable: Array<{ sessionId: string; serviceType: string }> = [];
  const unplaceable: Array<{ sessionId: string; kinfolkId: string }> = [];
  const excluded: ExcludedSession[] = [];

  for (const d of unplaceableSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    // Same filters the ordered read uses, so this reports only sessions that
    // WOULD be billable. An already-invoiced, unfinished, or deliberately
    // excluded visit with a broken startTime is a different problem and not
    // this callable's to raise.
    if (!isSessionCompleted(data['status'])) continue;
    if (!isSessionUnclaimed(data['invoiceId'])) continue;
    if (isSessionDoNotInvoice(data)) continue;
    unplaceable.push({ sessionId: d.id, kinfolkId: str(data['kinfolkId']) });
  }

  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (!isSessionCompleted(data['status'])) continue;
    if (!isSessionUnclaimed(data['invoiceId'])) continue;

    const serviceType = str(data['serviceType']);

    // Out of the queue by decision, not by accident, so it is reported on its
    // own channel rather than dropped or mixed in with billable work.
    if (isSessionDoNotInvoice(data)) {
      excluded.push({
        sessionId: d.id,
        kinfolkId: str(data['kinfolkId']),
        serviceType,
        startTime: str(data['startTime']),
        reason: sessionDoNotInvoiceReason(data),
      });
      continue;
    }

    const unitCents = rateCardLoaded ? rateToCents(rates[serviceType]) : null;
    if (unitCents === null) unpriceable.push({ sessionId: d.id, serviceType });

    sessions.push({
      sessionId: d.id,
      kinfolkId: str(data['kinfolkId']),
      serviceType,
      durationMinutes:
        typeof data['serviceDurationMinutes'] === 'number' ? data['serviceDurationMinutes'] : 0,
      startTime: str(data['startTime']),
      unitCents,
    });
  }

  logEvent({
    severity: 'info',
    function: 'listUninvoicedSessions',
    event: 'admin.invoice.uninvoiced.listed',
    uid,
    extra: {
      kinfolkId: args.kinfolkId ?? '',
      from: args.from ?? '',
      to: args.to ?? '',
      scanned: snap.docs.length,
      matched: sessions.length,
      excluded: excluded.length,
      unpriceable: unpriceable.length,
      unplaceable: unplaceable.length,
      rateCardLoaded,
    },
  });

  return validateResponse('listUninvoicedSessions', Result, {
    sessions,
    unpriceable,
    unplaceable,
    excluded,
    rateCardLoaded,
    scanned: snap.docs.length,
    truncated: snap.docs.length >= MAX_SESSIONS,
  });
}

export const listUninvoicedSessions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listUninvoicedSessions', listUninvoicedSessionsHandler),
);

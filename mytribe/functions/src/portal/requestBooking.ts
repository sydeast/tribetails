import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { resolveNonStaffKinfolkId } from '../lib/resolveNonStaffKinfolkId';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { approveBookingSeriesCore } from '../admin/approveBookingSeriesCore';
import { resolveDefaultAssignee, type Assignee } from '../lib/defaultAssignee';
import { materializeKinRoster } from '../lib/kinRoster';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { validateResponse } from '../lib/callableResponse';
import {
  IdempotencyKeyArg,
  assertSameCaller,
  lookupIdempotentEnvelope,
  readEnvelopeVisitIds,
} from '../lib/bookingIdempotency';
import { mapServiceRates } from './getServiceCatalog';
import {
  businessCalendarDate,
  businessTimeZone,
  containmentIsInert,
  findTimeBlock,
  resolveBookingPolicy,
  visitMatchesBlock,
  type BookingPolicy,
} from '../lib/bookingTimeBlocks';

/**
 * #9 (2026-06-08): Auto-confirm repeat kinfolk. When the operator turns on
 * `business_settings/business_settings.autoConfirmRepeatKinfolk` AND the kinfolk
 * has booked before (a prior envelope exists), a new request is confirmed
 * immediately, skipping the manual Incoming-requests queue. This reuses the same
 * approve core as manageBookingSeries (creates sessions + rolls the envelope), so
 * an auto-confirmed booking is indistinguishable from an admin-approved one.
 *
 * Fail-safe: any failure (setting read, repeat check, or approve) leaves the
 * series 'requested' so it falls back to the manual queue. Never throws.
 */
async function maybeAutoConfirm(kinfolkId: string, batchId: string, uid: string): Promise<void> {
  try {
    const settingsSnap = await db().collection('business_settings').doc('business_settings').get();
    const autoConfirm = settingsSnap.data()?.autoConfirmRepeatKinfolk === true;
    if (!autoConfirm) return;

    // Repeat kinfolk = has at least one prior booking envelope (other than this one).
    const priorSnap = await db().collection(`families/${kinfolkId}/bookings`).limit(2).get();
    const isRepeat = priorSnap.docs.some((d) => d.id !== batchId);
    if (!isRepeat) return;

    const r = await approveBookingSeriesCore({ kinfolkId, batchId, actorUid: uid, actorRole: 'SYSTEM' });
    logEvent({
      severity: 'info', function: 'requestBooking', event: 'portal.booking.autoConfirmed',
      uid, extra: { kinfolkId, batchId, sessionsCreated: r.sessionsCreated, failedVisits: r.failedVisits },
    });
  } catch (err) {
    // Fail-safe: leave the booking in the manual queue rather than dropping it.
    logEvent({
      severity: 'warn', function: 'requestBooking', event: 'autoConfirm.failed',
      uid, extra: { kinfolkId, batchId }, errorMessage: (err as Error)?.message,
    });
  }
}

/** Single-visit (legacy) shape, kept for backward compat. */
const LegacyArgs = z.object({
  kinfolkId: z.string().optional(),
  /** #644. See `lib/bookingIdempotency.ts`; absent means today's behaviour. */
  idempotencyKey: IdempotencyKeyArg,
  serviceType: z.string().min(1),
  title: z.string().optional(),
  startTimeMs: z.number().int().positive(),
  endTimeMs: z.number().int().positive().nullable().optional(),
  kinIds: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * Multi-visit (new wizard) shape.
 *
 * A VISIT CARRIES NO ADDRESS, and never will. Operator ruling, 2026-08-04:
 * addresses come from the household. `optimizeRoute.ts` and every navigation
 * affordance already read `serviceAddress` / `homeAddress` / `address` off the
 * household doc and nothing else, so a per-visit place field was an override
 * for an address the booking is not the authority on.
 *
 * This schema is deliberately NOT `.strict()`, which is what makes the removal
 * safe to deploy ahead of the clients: a cached wizard that still sends
 * `location` has the key stripped by zod rather than being refused.
 */
const VisitArgs = z.object({
  startTimeMs: z.number().int().positive(),
  endTimeMs: z.number().int().positive().nullable().optional(),
  serviceId: z.string().min(1),
  serviceName: z.string().min(1).max(120),
  priceCents: z.number().int().nonnegative().nullable().optional(),
  /**
   * Time-block booking (operator requirement 2026-08-24): the NAMED window this
   * visit was asked for, from `business_settings.timeBlocks`.
   *
   * It is the mode marker as well as the value: present means "this visit was
   * chosen by block", absent means "this visit was chosen by clock", and
   * `assertVisitBookingMode` below decides whether this business allows the one
   * that was used. The id is never trusted — it is looked up in the resolved
   * policy, and a visit whose start does not fall inside that window is
   * refused, so a client cannot send an arbitrary time under a block's name.
   *
   * Optional rather than nullable here so a client built before this field
   * existed parses unchanged. See `ExportedVisitArgs` for why the GENERATED
   * shape spells it the other way round.
   */
  timeBlockId: z.string().min(1).max(80).optional(),
});

/**
 * HOW the booking is meant to be billed, recorded as the operator's stated
 * intent, NOT as an instruction this callable acts on.
 *
 * The enum has exactly one member because the wizard's Review step offers
 * exactly one choice: "New Invoice". A second member would be a branch nothing
 * can produce, nothing has tested, and no reader could tell was real. Adding
 * one is a schema change AND a UI change, together.
 *
 * Nothing here raises an invoice. This system has no path that turns an
 * approved booking into an invoice automatically: invoices are created by
 * `createInvoice` and the completed sessions are attached with
 * `linkInvoiceSessions`. Persisting the preference is what lets that later step
 * know what was promised, and the wizard's own copy says so rather than
 * claiming an invoice appears on its own.
 */
const BillingArgs = z
  .object({
    mode: z.enum(['new-invoice']),
  })
  .optional();

/**
 * What the household is told, and how much of it.
 *
 * Both default FALSE, per the mock, which shows both with a red cross:
 * "Email confirmation: Won't send" and "Time visibility: Time windows".
 *
 *   emailConfirmation  send the household a confirmation email for this
 *                      booking. Off means the operator is telling them another
 *                      way.
 *   timeVisibility     show the household the EXACT start time of each visit.
 *                      Off means they see the time window instead, which is the
 *                      honest thing to show when an Auntie's arrival depends on
 *                      the visit before it.
 *
 * Optional as a whole: an absent object means both false, so a legacy payload
 * and an explicit `{ emailConfirmation: false, timeVisibility: false }` persist
 * identically. Neither field is optional WITHIN the object: a half-specified
 * preference is a caller bug, and defaulting one of two booleans silently is
 * how a household gets an email nobody chose to send.
 */
const CommunicationArgs = z
  .object({
    emailConfirmation: z.boolean(),
    timeVisibility: z.boolean(),
  })
  .optional();

const MultiArgs = z.object({
  kinfolkId: z.string().optional(),
  /** #644. See `lib/bookingIdempotency.ts`; absent means today's behaviour. */
  idempotencyKey: IdempotencyKeyArg,
  kinIds: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  pattern: z.enum(['individual', 'weekly']).optional(),
  weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
  visits: z.array(VisitArgs).min(1),
  billing: BillingArgs,
  communication: CommunicationArgs,
});

/**
 * ADR-0003's requestBooking decision: COLLAPSE, not union.
 *
 * The registry (`scripts/contracts/registry.ts`) models one `args` schema per
 * callable, and `readModel.ts` refuses anything whose root is not a single
 * `z.object` (a `z.union` hits its `default` case and throws naming the
 * construct). `MultiArgs` and `LegacyArgs` above are genuinely two different
 * shapes, kept exactly as they are: this handler still dispatches on
 * `Array.isArray(data.visits)` and parses through whichever one matches,
 * UNCHANGED by anything below.
 *
 * `Args` here is a THIRD, separate schema: the superset of both, used ONLY by
 * the registry for contract generation, never for parsing. Checked against
 * what actually calls this callable (`mytribe/web/src/api/bookingApi.ts`,
 * the kinfolk portal's only caller): every live request is `MultiArgs`
 * shaped. Nothing sends the legacy single-visit shape today; `LegacyArgs`
 * is dead-letter back-compat for whatever cached client or webhook still
 * might. A union would document a live fork that does not exist; a superset
 * documents the one shape clients actually build while still typing the
 * legacy fields for the caller that needs them.
 *
 * SAFETY PROPERTY: every payload `Args` can produce also parses under
 * `MultiArgs` or `LegacyArgs`. Two fields are deliberately narrower here than
 * the branch schemas allow, because `readModel.ts` refuses a field that is
 * both `.nullable()` and `.optional()` (Kotlin's one `T?` cannot tell "key
 * omitted" from "key sent null", and on a PATCH those differ). Neither
 * branch here is a patch -- this is a create, so "omitted" and "sent null"
 * already mean the same thing to the handler -- so narrowing the GENERATED
 * shape to one of the two costs nothing real:
 *   - `visits[].endTimeMs` / `priceCents` / `timeBlockId`: always-present,
 *     nullable (the generated client always sends the key, `null` when there is
 *     no value), never omitted.
 *   - the legacy flat `endTimeMs`: optional, never asserted `null` (a
 *     generated legacy caller either has an end time or leaves the key out).
 */
const ExportedVisitArgs = z
  .object({
    startTimeMs: z.number().int().positive(),
    endTimeMs: z.number().int().positive().nullable(),
    serviceId: z.string().min(1),
    serviceName: z.string().min(1).max(120),
    priceCents: z.number().int().nonnegative().nullable(),
    /** The named window this visit was booked in, or null when it was booked by clock. */
    timeBlockId: z.string().min(1).max(80).nullable(),
  })
  .strict();

export const Args = z
  .object({
    kinfolkId: z.string().optional(),
    /**
     * #644: the caller-minted booking id that makes a retry safe. Optional on
     * BOTH branch schemas above, so a generated client that omits it still
     * parses -- which is what lets the four clients adopt it one at a time.
     */
    idempotencyKey: IdempotencyKeyArg,
    kinIds: z.array(z.string()).optional(),
    notes: z.string().max(1000).optional(),
    pattern: z.enum(['individual', 'weekly']).optional(),
    weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
    /** Multi-visit (preferred) shape. Present <=> this is a multi-visit request. */
    visits: z.array(ExportedVisitArgs).optional(),
    billing: BillingArgs,
    communication: CommunicationArgs,
    /** Legacy single-visit shape. See the header above: no live caller sends this today. */
    serviceType: z.string().min(1).optional(),
    title: z.string().optional(),
    startTimeMs: z.number().int().positive().optional(),
    endTimeMs: z.number().int().positive().optional(),
  })
  .strict();

/** The billing preference as persisted. `null` when the caller stated none. */
export type BookingBilling = { mode: 'new-invoice' } | null;

/** The communication preference as persisted. Always concrete, never null. */
export interface BookingCommunication {
  emailConfirmation: boolean;
  timeVisibility: boolean;
}

/** Both preferences default to the mock's OFF, so an absent object is not an absent decision. */
export const COMMUNICATION_DEFAULT: BookingCommunication = {
  emailConfirmation: false,
  timeVisibility: false,
};

/**
 * Both write paths (multi and legacy) return the identical shape, and both
 * always set `bookingId` -- the interface this replaced marked it optional,
 * but nothing on this file has ever returned without it, so the schema below
 * describes what actually ships rather than carrying a `?` no caller needs.
 */
export const Result = z
  .object({
    /** The envelope id (parent `bookings/{batchId}` doc). */
    batchId: z.string().min(1),
    /**
     * Legacy multi-id alias. In the envelope model this is `[batchId]`, callers
     * that grouped by the returned ids now get the single envelope id.
     */
    bookingIds: z.array(z.string().min(1)).min(1),
    /** Legacy single-id alias, always `batchId` today. */
    bookingId: z.string().min(1),
  })
  .strict();

/** Normalized per-visit input the envelope writer consumes. */
export interface NormalizedVisit {
  startTimeMs: number;
  endTimeMs: number | null;
  serviceId: string | null;
  serviceName: string | null;
  priceCents: number | null;
  title: string | null;
  /**
   * Time-block booking: the window this visit was asked for, resolved and
   * verified server-side, or null when it was booked by clock.
   *
   * OPTIONAL ON THIS INTERFACE, not on the stored document. `writeEnvelope` has
   * a second caller — `admin/createMultiDateBookingRequest.ts`, where an
   * operator is picking real times on the office's own calendar and there is no
   * block to name — and making these required would have forced a field into a
   * builder that has no value for it. `writeEnvelope` persists an explicit
   * `null` either way, so a reader never has to tell "absent" from "by clock".
   */
  timeBlockId?: string | null;
  /** The block's label AS IT WAS WHEN BOOKED, so an admin sees the name the household picked even if it is later renamed. */
  timeBlockLabel?: string | null;
}

/** One catalog entry as the write path needs it: the canonical label and the price it carries. */
export interface ServicePriceEntry {
  name: string | null;
  priceCents: number | null;
}

/** serviceId -> canonical name + price. Built once per request; see {@link loadServicePriceBook}. */
export type ServicePriceBook = ReadonlyMap<string, ServicePriceEntry>;

/**
 * #546, server half: THE SAME CATALOG THE WIZARD PRICED FROM.
 *
 * `resolveService` used to read `base_services/{serviceId}` and nothing else.
 * But `getServiceCatalog` — the callable the wizard's duration cards are built
 * from — resolves `business_settings.serviceRates` FIRST and only falls back to
 * `base_services`, and this business's real catalog lives in `serviceRates`
 * (keys like `30Minute`, values "25"). So every booking a household made from
 * the real catalog looked its serviceId up in a collection that has never held
 * it, logged `service.resolve.miss`, and persisted `priceCents: null`.
 *
 * That is why fixing #546's estimate is not a client-only job: the number the
 * wizard now shows would have had no persisted counterpart at all. This reader
 * is `getServiceCatalog`'s FIRST source, resolved once for the whole request —
 * `resolveService` still falls back to the `base_services` document when the
 * rates map does not carry the id, which is `getServiceCatalog`'s second
 * source and the behaviour every existing caller already had.
 *
 * Read once per request rather than once per visit: a booking may now name
 * several different KinCares (#541), and each used to cost its own read.
 */
export async function loadServicePriceBook(): Promise<ServicePriceBook> {
  const book = new Map<string, ServicePriceEntry>();
  try {
    const settingsSnap = await db().collection('business_settings').doc('business_settings').get();
    for (const s of mapServiceRates(settingsSnap.data()?.serviceRates)) {
      book.set(s.id, { name: s.name, priceCents: s.priceCents });
    }
  } catch (err) {
    // A settings read that fails must not take the booking down with it: the
    // per-service `base_services` fallback below still resolves, exactly as it
    // did before this book existed.
    logEvent({
      severity: 'warn',
      function: 'requestBooking',
      event: 'serviceRates.read.failed',
      errorMessage: (err as Error)?.message,
    });
  }
  return book;
}

/**
 * NOTE-56: resolve `serviceName` + `priceCents` SERVER-SIDE from the canonical
 * catalog. A kinfolk client must never be trusted to supply its own price (it
 * could send `priceCents: 0`) or an arbitrary service label. When the serviceId
 * resolves, the catalog value wins; the client-supplied `priceCents` is ignored
 * entirely.
 *
 * Sources, in `getServiceCatalog`'s own order: the `serviceRates` book first
 * (#546), then the `base_services/{serviceId}` document.
 *
 * When the serviceId is absent or in neither source we set `priceCents = null`
 * and let pricing be resolved downstream at invoice time, rather than persist a
 * client-asserted amount. The client `serviceName` is used only as a display
 * fallback label when the catalog has no entry.
 *
 * `book` is optional so a caller resolving ONE visit does not have to arrange
 * the read itself; both live callers pass a book loaded once per request.
 */
export async function resolveService(
  serviceId: string | null,
  clientServiceName: string | null,
  book?: ServicePriceBook,
): Promise<{ serviceName: string | null; priceCents: number | null }> {
  if (!serviceId) {
    return { serviceName: clientServiceName, priceCents: null };
  }
  const fromRates = (book ?? (await loadServicePriceBook())).get(serviceId);
  if (fromRates) {
    const ratesName = fromRates.name !== null && fromRates.name.length > 0 ? fromRates.name : clientServiceName;
    return { serviceName: ratesName, priceCents: fromRates.priceCents };
  }
  const snap = await db().collection('base_services').doc(serviceId).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) {
    // Unknown serviceId -> do NOT trust a client price. Resolve at invoice time.
    logEvent({
      severity: 'warn',
      function: 'requestBooking',
      event: 'service.resolve.miss',
      extra: { serviceId },
    });
    return { serviceName: clientServiceName, priceCents: null };
  }
  const canonicalName = typeof data['name'] === 'string' && (data['name'] as string).length > 0
    ? (data['name'] as string)
    : clientServiceName;
  const rawPrice = data['priceCents'];
  const priceCents =
    typeof rawPrice === 'number' && isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : null;
  return { serviceName: canonicalName, priceCents };
}

/**
 * #541 / #543, server half: a booking day may carry SEVERAL KinCares, and two
 * of them may share a duration. What it may never carry is the same duration at
 * the same instant twice — that is not two visits, it is one visit asked for
 * twice, and it would put two identical `kinCares` docs in front of an Auntie
 * with nothing to tell them apart.
 *
 * Deliberately NOT an overlap rule. A 60-minute KinCare starting half an hour
 * into a 30-minute one is a scheduling question for the human who vets the
 * request (every envelope lands 'requested'), not something this callable gets
 * to decide on their behalf. Exact duplicates are the only case where refusing
 * cannot be wrong.
 */
export function duplicateVisitKey(
  visits: ReadonlyArray<{ startTimeMs: number; serviceId: string; timeBlockId?: string | null | undefined }>,
  /** `business_settings.timeZone`. Required, never defaulted: keying block dates in a silently-assumed zone is the bug. */
  timeZone: string,
): string | null {
  const seen = new Set<string>();
  for (const v of visits) {
    // Time-block booking: in block mode EVERY visit in a block starts at that
    // block's first minute, so keying on the instant would refuse "a 30 minute
    // and a 60 minute, both in the Midday block" — which is exactly the
    // several-KinCares-a-day case #541/#543 built. Worse, the message would
    // tell a household to "change one of the times" next to a picker that has
    // no times in it.
    //
    // #597: dropping the instant entirely dropped the DAY with it, and a
    // household picking Sep 4, Sep 5 and Sep 6 in the Midday block was told it
    // had asked for the same visit three times — which broke Pattern = Dates
    // (#547) and weekly recurring the moment block mode was on. The identity of
    // a block-mode visit is (date, KinCare, block): what is refused is the SAME
    // KinCare in the SAME block ON THE SAME DAY, which is still one visit asked
    // for twice, and nothing else is.
    //
    // The date is the BUSINESS's calendar date, not the instant and not the
    // device's day — see `businessCalendarDate`, including what it does when the
    // stored zone is unusable. The block id is trimmed here for the same reason
    // `assertVisitBookingMode` trims it: " midday " and "midday" are one block,
    // and a stray space must not walk a duplicate past this check.
    const blockId = typeof v.timeBlockId === 'string' ? v.timeBlockId.trim() : '';
    const when =
      blockId.length > 0
        ? `${businessCalendarDate(v.startTimeMs, timeZone)}@block:${blockId}`
        : `${v.startTimeMs}`;
    const key = `${v.serviceId}@${when}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/** Which duplicate rule tripped, so the refusal can name a control the household actually has. */
function duplicateVisitMessage(key: string): string {
  return key.includes('@block:')
    ? 'Two KinCares in this request are the same duration in the same time block on the same day. Remove one, or move it to another block.'
    : 'Two KinCares in this request have the same duration at the same time. Change one of the times.';
}

/**
 * Time-block booking: the policy this request is judged against, plus the zone
 * its windows are stated in.
 *
 * Read through `resolveBookingPolicy` — the SAME decoder `getBookingPolicy`
 * serves the portal from — so the wizard cannot be offered a control this
 * validator refuses. Validating against the raw `business_settings` fields
 * instead is the one bug this design can produce by accident, so the raw fields
 * are never read here at all.
 *
 * A failed settings read falls back to the resolver's own defaults (specific
 * time allowed, no blocks), which is the pre-time-block behaviour exactly: a
 * Firestore blip must not start refusing every booking in the business.
 */
export async function loadBookingPolicy(): Promise<{ policy: BookingPolicy; timeZone: string }> {
  let raw: unknown = {};
  try {
    const snap = await db().collection('business_settings').doc('business_settings').get();
    raw = snap.data() ?? {};
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'requestBooking',
      event: 'bookingPolicy.read.failed',
      errorMessage: (err as Error)?.message,
    });
  }
  const policy = resolveBookingPolicy(raw).policy;
  const timeZone = businessTimeZone(raw);

  // #596, the wider half: `visitMatchesBlock` fails open on a zone it cannot
  // read, which is deliberate and stays — but a business taking block bookings
  // with no usable `timeZone` has rule 4 of `assertVisitBookingMode` switched
  // off for EVERY block, and that is an enforcement control not running rather
  // than a household-side unknown. It gets a named line at the enforcement
  // point, so it shows up in a log search instead of being inferred from
  // bookings that should have been refused. Deliberately NOT also logged in
  // `getBookingPolicy`: that callable enforces nothing, runs on every wizard
  // open, and would only bury this one under its own copies.
  if (containmentIsInert(policy, timeZone)) {
    logEvent({
      severity: 'error',
      function: 'requestBooking',
      event: 'timeblock.containment.inert',
      errorMessage:
        'business_settings.timeZone is blank or not a usable IANA zone, so time-block containment is not being checked on any block.',
      extra: { timeZone, blockCount: policy.timeBlocks.length },
    });
  }

  return { policy, timeZone };
}

/** What the server decided one visit's WHEN actually is. Persisted on the visit. */
export interface ResolvedVisitBlock {
  timeBlockId: string | null;
  timeBlockLabel: string | null;
}

/**
 * Is this visit's WHEN something this business allows, and is the block real?
 *
 * Throws `invalid-argument` and returns the verified block otherwise. THIS IS
 * THE REFUSAL PATH the whole feature turns on: a client that sends an arbitrary
 * clock time while the business only allows block booking is refused, not
 * trusted, and so is a client that names a block that does not exist, is not
 * active, or does not contain the time it sent.
 *
 * Four rules, in the order a reader should think about them:
 *
 *  1. NO BLOCK NAMED + specific-time not allowed -> refused. This is the
 *     operator's requirement enforced: "kinfolk book within time blocks, not at
 *     a specific set time".
 *  2. BLOCK NAMED + block booking not allowed -> refused. Symmetry matters:
 *     an operator who turned blocks off should not keep receiving them from a
 *     stale client.
 *  3. BLOCK NAMED but unknown to the policy -> refused. `findTimeBlock` searches
 *     the RESOLVED list, which already dropped inactive and unreadable rows, so
 *     "not active" and "not a block" refuse identically and for one reason.
 *  4. BLOCK NAMED and real, but `startTimeMs` falls outside its window ->
 *     refused. Containment is checked on the BUSINESS's wall clock; when the
 *     stored ZONE is unusable the check is skipped (see `visitMatchesBlock`)
 *     rather than guessed at, and rules 1-3 still stand. A block whose OWN
 *     times are unreadable is the other way round and refuses (#596): the
 *     server wrote those strings, so that is a bug here, not missing operator
 *     configuration, and it must never read as a "cannot tell".
 */
export function assertVisitBookingMode(
  visit: { startTimeMs: number; timeBlockId?: string | null | undefined },
  policy: BookingPolicy,
  timeZone: string,
): ResolvedVisitBlock {
  const namedId = typeof visit.timeBlockId === 'string' ? visit.timeBlockId.trim() : '';

  if (namedId.length === 0) {
    if (!policy.allowSpecificTimeBooking) {
      throw new HttpsError(
        'invalid-argument',
        'This business takes bookings inside its time blocks. Choose a time block for every KinCare.',
      );
    }
    return { timeBlockId: null, timeBlockLabel: null };
  }

  if (!policy.allowTimeBlockBooking) {
    throw new HttpsError(
      'invalid-argument',
      'This business is not taking time-block bookings right now. Choose a specific time for every KinCare.',
    );
  }

  const block = findTimeBlock(policy, namedId);
  if (block === null) {
    throw new HttpsError(
      'invalid-argument',
      'That time block is no longer available. Reload the booking wizard and pick one of the current blocks.',
    );
  }

  const match = visitMatchesBlock(visit.startTimeMs, block, timeZone);
  if (match === 'outside') {
    throw new HttpsError(
      'invalid-argument',
      `That visit time is outside the ${block.label} block (${block.startTime}-${block.endTime}). Pick the block again.`,
    );
  }
  // #596: a block whose OWN times will not parse is a server-side defect, not a
  // household-side unknown, so it refuses rather than falling open the way an
  // unusable ZONE does. It should be unreachable — `parseTimeBlockRow` re-parses
  // what it emits — and if it ever fires, the alternative is accepting a visit
  // under the name of a window nothing can check it against.
  if (match === 'block-unreadable') {
    logEvent({
      severity: 'error',
      function: 'requestBooking',
      event: 'timeblock.block.unreadable',
      errorMessage: `Time block ${block.id} has unreadable times ${block.startTime}-${block.endTime}.`,
      extra: { timeBlockId: block.id, startTime: block.startTime, endTime: block.endTime },
    });
    throw new HttpsError(
      'invalid-argument',
      `Something is wrong with the ${block.label} block on our side, so it cannot be booked right now. Pick another block.`,
    );
  }

  return { timeBlockId: block.id, timeBlockLabel: block.label };
}

/**
 * Sanity bound on one request. The wizard's own weekly cap is 26
 * (MAX_RECURRING_VISITS) but the Individual pattern has no such ceiling —
 * dates x KinCares can be arbitrarily large — and `writeEnvelope` puts every
 * visit in ONE Firestore transaction, which has a hard 500-write limit. 200
 * leaves generous room under it for the envelope doc and any future per-visit
 * write, while being far more than a household plans by hand.
 */
export const MAX_VISITS_PER_REQUEST = 200;

/**
 * Writes one parent envelope `families/{kinfolkId}/bookings/{batchId}` plus one
 * `kinCares/{visitId}` per visit inside a single transaction. Envelope-level
 * fields are rolled up from the visit list.
 */
export async function writeEnvelope(opts: {
  kinfolkId: string;
  uid: string;
  batchId: string;
  pattern: 'individual' | 'weekly';
  weeklyDays: number[] | null;
  /**
   * The Kin the caller NAMED. Empty means the caller named none, which under
   * R1 means the whole household and is materialized into the concrete roster
   * below. It is never persisted as `[]`.
   */
  kinIds: string[];
  notes: string | null;
  visits: NormalizedVisit[];
  /** Default-assignee (2026-07-02): the Auntie every new visit starts assigned to. */
  assignee: Assignee | null;
  /** Stated billing intent, or null when the caller stated none. */
  billing?: BookingBilling;
  /** Stated communication preference. Absent means both false, never "unknown". */
  communication?: BookingCommunication;
}): Promise<{ batchId: string; visitIds: string[]; deduped: boolean }> {
  const { kinfolkId, uid, batchId, pattern, weeklyDays, kinIds, notes, visits, assignee } = opts;
  // Resolved HERE rather than at each call site, so every writer, portal and
  // admin, persists the same concrete pair. A missing preference is a decision
  // (the mock's default is off for both), not an unknown to leave undefined for
  // a reader to guess at.
  const billing = opts.billing ?? null;
  const communication = opts.communication ?? COMMUNICATION_DEFAULT;
  const firestore = db();
  const parentRef = firestore.doc(`families/${kinfolkId}/bookings/${batchId}`);

  // Roll envelope fields from the visits.
  const startMsList = visits.map((v) => v.startTimeMs);
  const firstStartMs = Math.min(...startMsList);
  const lastStartMs = Math.max(...startMsList);
  const serviceIds = new Set(visits.map((v) => v.serviceId ?? null));
  const serviceNames = new Set(visits.map((v) => v.serviceName ?? null));
  const homogeneousServiceId = serviceIds.size === 1 ? [...serviceIds][0] : null;
  const homogeneousServiceName = serviceNames.size === 1 ? [...serviceNames][0] : null;
  // R1: an empty `kinIds` means the WHOLE HOUSEHOLD, and is materialized into
  // the concrete roster here rather than persisted as the literal `[]` that
  // left every reader downstream with nothing to name. See kinRoster.ts for the
  // ruling and for the roster-drift consequence this freeze-at-write accepts.
  //
  // Resolved once for the whole envelope (every visit here shares the same
  // kinIds today) and stamped on the envelope AND each visit, rather than the
  // `kinNames: []` that used to leave the portal saying "your kin" and
  // Android's Schedule with no Pets line at all.
  const { kinIds: kinIdUnion, kinNames } = await materializeKinRoster(kinfolkId, kinIds);

  const visitIds: string[] = [];
  let storedEnvelope: Record<string, unknown> | undefined;
  await firestore.runTransaction(async (tx) => {
    // Reset per attempt: Firestore re-runs this callback on contention, and the
    // ids are minted inside it. Before the read below there was nothing to
    // contend on and the array could only be filled once; now that this
    // transaction reads, a re-run would otherwise return the previous attempt's
    // ids appended to this one's.
    visitIds.length = 0;
    storedEnvelope = undefined;

    // #644: THE DEDUPE, and the reason it lives inside the transaction rather
    // than in a check-then-write before it. Two attempts at one submission can
    // be in flight at once (the automatic retry racing a request that was slow
    // rather than dropped); a read outside the transaction lets both see
    // "absent" and both write. Firestore aborts the loser here instead.
    //
    // Reached at all only when the caller supplied an idempotencyKey — without
    // one the batchId is freshly minted per call and this read always misses,
    // which is exactly the pre-#644 behaviour.
    const existing = await tx.get(parentRef);
    if (existing.exists) {
      const data = existing.data() ?? {};
      assertSameCaller(data, uid);
      storedEnvelope = data;
      return;
    }

    // Minted BEFORE the envelope write so the envelope can carry them: #644's
    // deduped reply has to return the same visit ids the first attempt did, and
    // one denormalized array beats a subcollection scan on every retry.
    const visitRefs = visits.map(() => parentRef.collection('kinCares').doc());
    for (const ref of visitRefs) visitIds.push(ref.id);

    tx.set(parentRef, {
      familyId: kinfolkId,
      requestBatchId: batchId,
      visitIds: [...visitIds],
      envelopeStatus: 'requested',
      requestedByUid: uid,
      pattern,
      weeklyDays,
      serviceId: homogeneousServiceId,
      serviceName: homogeneousServiceName,
      kinIds: kinIdUnion,
      kinNames,
      notes,
      // Booking-level preferences, stated once for the whole request. They are
      // not per-visit: an operator does not send one confirmation email per
      // visit, and does not bill half a series to a different invoice.
      billing,
      communication,
      visitCount: visits.length,
      confirmedCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      firstStartTime: Timestamp.fromMillis(firstStartMs),
      lastStartTime: Timestamp.fromMillis(lastStartMs),
      targetType: 'KIN',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    visits.forEach((v, i) => {
      const visitRef = visitRefs[i];
      tx.set(visitRef, {
        batchId,
        familyId: kinfolkId,
        status: 'requested',
        visitProgress: null,
        serviceId: v.serviceId,
        serviceName: v.serviceName,
        serviceType: v.serviceName,
        priceCents: v.priceCents,
        // Time-block booking: WHICH named window this visit was asked for, so
        // the admin side reads the household's actual choice rather than
        // inferring it. AuntieOS already labels a session by containment
        // (`resolveTimeBlock(startTime, timeBlocks)`), and that still works —
        // this is the household's stated answer, which survives an operator
        // later moving or renaming the window.
        //
        // Always written, `null` for a by-the-clock visit, so no reader has to
        // tell "this predates blocks" from "this was booked by clock".
        timeBlockId: v.timeBlockId ?? null,
        timeBlockLabel: v.timeBlockLabel ?? null,
        // No `location`. A visit happens at the household's address, which is
        // read live off the household doc by everything that needs it
        // (`optimizeRoute.ts`, the address chips, `BookingDetailModal.tsx`).
        // Operator ruling, 2026-08-04.
        title: v.title ?? v.serviceName,
        startTime: Timestamp.fromMillis(v.startTimeMs),
        endTime: v.endTimeMs != null ? Timestamp.fromMillis(v.endTimeMs) : null,
        kinIds: kinIdUnion,
        kinNames,
        // Default-assignee (2026-07-02): new visits start on the admin's plate;
        // onBookingsWrite fires assignment.assigned off this field.
        assignedAuntieUid: assignee?.uid ?? null,
        auntieDisplayName: assignee?.displayName ?? null,
        auntieAvatarUrl: null,
        requestedByUid: uid,
        sourceBookingId: null,
        sessionId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  });

  if (storedEnvelope !== undefined) {
    // #644: nothing was written. The reply is rebuilt from the envelope the
    // first attempt stored, so a retry is indistinguishable to the caller from
    // the success it never saw.
    return {
      batchId,
      visitIds: await readEnvelopeVisitIds(kinfolkId, batchId, storedEnvelope),
      deduped: true,
    };
  }
  return { batchId, visitIds, deduped: false };
}

/**
 * Kinfolk-initiated booking request.
 * Two payload shapes supported:
 *   - Multi-visit (preferred): { visits: [...], kinIds, pattern }
 *   - Legacy: { serviceType, startTimeMs, endTimeMs, kinIds }
 *
 * Both shapes now write the envelope model: ONE parent
 * `families/{kinfolkId}/bookings/{batchId}` doc plus one `kinCares/{visitId}`
 * per visit. The legacy single-visit path is stored as a 1-visit envelope.
 */
export async function requestBookingHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();

  const data = (req.data ?? {}) as Record<string, unknown>;
  const isMulti = Array.isArray((data as { visits?: unknown }).visits);

  // PR28b: both branches below resolve the household AFTER parsing their args.
  // This used to be split: the clients/{uid} lookup and the zero-households
  // check ran here, above the dispatch and before either parse, while the
  // actual id matching already ran after it. Now the whole resolution is one
  // call, after parsing. The reorder has one narrow deliberate consequence: a
  // caller with zero linked households who also sends a malformed payload now
  // gets the zod 'invalid-argument' where they used to get
  // 'failed-precondition'. Both refuse the request; every other ordering is
  // unchanged.
  if (isMulti) {
    const args = MultiArgs.parse(req.data);
    const kinfolkId = await resolveNonStaffKinfolkId(uid, args.kinfolkId);

    // #644: a retry of a submission that already landed returns what it stored,
    // without re-running a single guard below. Placed AFTER household
    // resolution because the envelope path is scoped by household, and before
    // everything else because none of it should run twice. See
    // `lookupIdempotentEnvelope` for why a re-run is not merely wasteful.
    const replayed = await lookupIdempotentEnvelope({ kinfolkId, key: args.idempotencyKey, uid });
    if (replayed) {
      logEvent({
        severity: 'info', function: 'requestBooking',
        event: 'portal.booking.requested.deduped', uid,
        extra: { kinfolkId, batchId: replayed.batchId, count: replayed.visitCount },
      });
      return validateResponse('requestBooking', Result, {
        batchId: replayed.batchId,
        bookingIds: [replayed.batchId],
        bookingId: replayed.batchId,
      });
    }

    const now = Date.now();
    if (args.visits.length > MAX_VISITS_PER_REQUEST) {
      throw new HttpsError(
        'invalid-argument',
        `A booking request can carry at most ${MAX_VISITS_PER_REQUEST} visits. Send fewer dates or fewer KinCares per day.`,
      );
    }
    args.visits.forEach((v) => {
      if (v.startTimeMs < now - 60_000) {
        throw new HttpsError('invalid-argument', 'Visit startTime must be in the future.');
      }
      if (v.endTimeMs && v.endTimeMs <= v.startTimeMs) {
        throw new HttpsError('invalid-argument', 'endTime must be after startTime.');
      }
    });
    // Time-block booking: resolved BEFORE the duplicate check, because in block
    // mode the duplicate rule keys on the block rather than the instant, and
    // before the busy/holiday guards, because a refusal a household can act on
    // ("pick a block") should not be reached through one it cannot.
    const { policy, timeZone } = await loadBookingPolicy();
    const resolvedBlocks = args.visits.map((v) => assertVisitBookingMode(v, policy, timeZone));

    // #543: several KinCares in one day are fine; the SAME one twice is not.
    // #597: "one day" is the BUSINESS's day, which is why the zone goes in.
    const dupKey = duplicateVisitKey(args.visits, timeZone);
    if (dupKey !== null) {
      throw new HttpsError('invalid-argument', duplicateVisitMessage(dupKey));
    }
    // Kinfolk have no override: a busy-import conflict always refuses the request.
    await guardBookingBusyConflict({ firestore, visits: args.visits, actorUid: uid, actorRole: 'PRIMARY' });
    // A closed day always refuses the request too -- no override, for anyone.
    // See companyHolidayConflict.ts's header for why this guard has none.
    await guardCompanyHolidayConflict({ firestore, visits: args.visits });

    // #644: the caller's key IS the envelope id when it sent one. Without one
    // this is the same server-minted id it has always been, and the dedupe read
    // inside `writeEnvelope` can never hit.
    const batchId = args.idempotencyKey ?? `req_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const pattern = args.pattern ?? 'individual';
    // NOTE-56: resolve serviceName + priceCents from the canonical catalog. The
    // client-supplied `v.priceCents` is intentionally discarded here. The book is
    // read ONCE for the whole request; a booking may now name several different
    // KinCares (#541) and used to cost one catalog read per visit.
    const priceBook = await loadServicePriceBook();
    const normalized: NormalizedVisit[] = await Promise.all(
      args.visits.map(async (v, idx) => {
        // Time-block booking does NOT touch pricing. A block says WHEN; the
        // KinCare (`serviceId`) still says how long and how much, and it is
        // still resolved here through `resolveService` against the same
        // `serviceRates`-first price book #546 fixed. A block-booked visit
        // therefore reaches `priceCents` by the identical path a clock-booked
        // one does, which is the whole reason the block is a separate field
        // rather than a replacement for the service.
        const resolved = await resolveService(v.serviceId, v.serviceName, priceBook);
        const block = resolvedBlocks[idx] ?? { timeBlockId: null, timeBlockLabel: null };
        return {
          startTimeMs: v.startTimeMs,
          endTimeMs: v.endTimeMs ?? null,
          serviceId: v.serviceId,
          serviceName: resolved.serviceName,
          priceCents: resolved.priceCents,
          title: resolved.serviceName ?? v.serviceName,
          timeBlockId: block.timeBlockId,
          timeBlockLabel: block.timeBlockLabel,
        };
      }),
    );

    const written = await writeEnvelope({
      kinfolkId,
      uid,
      batchId,
      pattern,
      weeklyDays: args.weeklyDays ?? null,
      kinIds: args.kinIds ?? [],
      notes: args.notes ?? null,
      visits: normalized,
      assignee: await resolveDefaultAssignee(),
      billing: args.billing ?? null,
      ...(args.communication ? { communication: args.communication } : {}),
    });

    if (written.deduped) {
      // Lost a race with this submission's OWN other attempt: the fast path
      // above missed because the winner had not committed yet, and the
      // transaction guard caught it instead. The winner has already audited and
      // already run auto-confirm, so this attempt does neither and only reports
      // what is stored. A second BOOKING_SUBMITTED row and a second approve
      // pass are precisely the duplicates #644 exists to prevent.
      logEvent({
        severity: 'info', function: 'requestBooking',
        event: 'portal.booking.requested.deduped', uid,
        extra: { kinfolkId, batchId, count: written.visitIds.length, race: true },
      });
      return validateResponse('requestBooking', Result, { batchId, bookingIds: [batchId], bookingId: batchId });
    }

    logEvent({
      severity: 'info', function: 'requestBooking',
      event: 'portal.booking.requested.multi', uid,
      extra: {
        kinfolkId,
        batchId,
        count: normalized.length,
        pattern,
        blockVisits: normalized.filter((v) => v.timeBlockId !== null).length,
      },
    });
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BOOKING_SUBMITTED,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: uid,
      targetUid: batchId,
      targetCollection: `families/${kinfolkId}/bookings/${batchId}`,
      description: `Kinfolk submitted ${normalized.length} visit(s) (${pattern})`,
      payload: { kinfolkId, batchId, count: normalized.length, pattern, requestBatchId: batchId },
    }).catch((err) => {
      logEvent({
        severity: 'warn', function: 'requestBooking', event: 'audit.write.failed',
        uid, errorMessage: (err as Error)?.message,
      });
    });
    await maybeAutoConfirm(kinfolkId, batchId, uid);
    return validateResponse('requestBooking', Result, { batchId, bookingIds: [batchId], bookingId: batchId });
  }

  // Legacy single-visit path, stored as a 1-visit envelope.
  const args = LegacyArgs.parse(req.data);
  // Household resolution: see the PR28b note above the isMulti dispatch.
  const kinfolkId = await resolveNonStaffKinfolkId(uid, args.kinfolkId);

  // #644, same fast path as the multi branch. The legacy shape has no live
  // caller today, but it writes the same envelope through the same writer, so
  // leaving it out would mean one of the two branches could still double-book.
  const replayedLegacy = await lookupIdempotentEnvelope({ kinfolkId, key: args.idempotencyKey, uid });
  if (replayedLegacy) {
    logEvent({
      severity: 'info', function: 'requestBooking',
      event: 'portal.booking.requested.deduped', uid,
      extra: { kinfolkId, batchId: replayedLegacy.batchId, legacy: true },
    });
    return validateResponse('requestBooking', Result, {
      batchId: replayedLegacy.batchId,
      bookingIds: [replayedLegacy.batchId],
      bookingId: replayedLegacy.batchId,
    });
  }

  if (args.endTimeMs && args.endTimeMs <= args.startTimeMs) {
    throw new HttpsError('invalid-argument', 'endTime must be after startTime.');
  }
  if (args.startTimeMs < Date.now() - 60_000) {
    throw new HttpsError('invalid-argument', 'startTime must be in the future.');
  }
  // Time-block booking: the legacy shape carries NO `timeBlockId` and never
  // will, so under a block-only policy every request through it is an arbitrary
  // clock time and is refused here. Without this line the refusal above would
  // be bypassable by sending the older payload — a guard on one branch of a
  // two-branch handler is not a guard.
  const legacyPolicy = await loadBookingPolicy();
  assertVisitBookingMode({ startTimeMs: args.startTimeMs }, legacyPolicy.policy, legacyPolicy.timeZone);
  // Kinfolk have no override: a busy-import conflict always refuses the request.
  await guardBookingBusyConflict({
    firestore,
    visits: [{ startTimeMs: args.startTimeMs, endTimeMs: args.endTimeMs }],
    actorUid: uid,
    actorRole: 'PRIMARY',
  });
  // A closed day always refuses the request too -- no override, for anyone.
  await guardCompanyHolidayConflict({
    firestore,
    visits: [{ startTimeMs: args.startTimeMs, endTimeMs: args.endTimeMs }],
  });

  const batchId = args.idempotencyKey ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const writtenLegacy = await writeEnvelope({
    kinfolkId,
    uid,
    batchId,
    pattern: 'individual',
    weeklyDays: null,
    kinIds: args.kinIds ?? [],
    notes: args.notes ?? null,
    visits: [
      {
        startTimeMs: args.startTimeMs,
        endTimeMs: args.endTimeMs ?? null,
        serviceId: null,
        serviceName: args.serviceType,
        priceCents: null,
        title: args.title ?? args.serviceType,
      },
    ],
    assignee: await resolveDefaultAssignee(),
  });

  if (writtenLegacy.deduped) {
    // See the multi branch's own deduped return for why this audits nothing.
    logEvent({
      severity: 'info', function: 'requestBooking',
      event: 'portal.booking.requested.deduped', uid,
      extra: { kinfolkId, batchId, legacy: true, race: true },
    });
    return validateResponse('requestBooking', Result, { batchId, bookingIds: [batchId], bookingId: batchId });
  }

  logEvent({ severity: 'info', function: 'requestBooking', event: 'portal.booking.requested', uid, extra: { kinfolkId, batchId } });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BOOKING_SUBMITTED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: uid,
    targetUid: batchId,
    targetCollection: `families/${kinfolkId}/bookings/${batchId}`,
    description: 'Kinfolk submitted booking (legacy single-visit)',
    payload: { kinfolkId, batchId, serviceType: args.serviceType },
  }).catch((err) => {
    logEvent({
      severity: 'warn', function: 'requestBooking', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  await maybeAutoConfirm(kinfolkId, batchId, uid);
  return validateResponse('requestBooking', Result, { batchId, bookingIds: [batchId], bookingId: batchId });
}

export const requestBooking = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    // AUNTIE_OPERATOR_UIDS: `maybeAutoConfirm` runs `approveBookingSeriesCore`,
    // which since #536 dispatches `kincare.booking.confirm` to the household AND
    // to `businessAdmins`. `lib/businessAdmins` self-heals an empty roster from
    // this secret only inside a function that binds it. Same reason
    // `manageBookingSeries` gained it.
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapCallable('requestBooking', requestBookingHandler),
);

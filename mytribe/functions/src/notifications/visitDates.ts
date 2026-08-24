import { db } from '../lib/firestoreAdmin';

/**
 * ONE rule for every message that names visit dates.
 *
 * Implements steps 1 and 3 of
 * `docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md`: the shared
 * reader, the formatter, and the structured data shape that `kincare.booking.confirm`
 * now carries (#536). The remaining steps in that spec (adopting the shape on
 * `kincare.requested` / `kincare.request.declined`, the "what was removed" diff
 * store, the envelope-grained reminder, and the Auntie's `assignment.*` copy)
 * are deliberately NOT here: each needs an operator answer the spec names.
 *
 * WHY A STRUCTURED ARRAY AND NOT A RENDERED STRING. `{{bookingDates}}` (#534)
 * hands the template a pre-formatted blob: "4 visits, Sep 4 to Sep 7". The
 * Template Bank can move that phrase around; it cannot restyle it, and it cannot
 * make it true. Operator ruling 2026-08-23: NO SUMMARISING. A span is false the
 * moment one visit of the four is cancelled, and it reads as a four-day block
 * when the real set is four Thursdays across a month. Kinfolk and Aunties both
 * need to know exactly which days.
 *
 * Every sender renders with Handlebars over `{ ...data }` and runs
 * `stripUnresolvedTokens` AFTER compilation, so putting an ARRAY in `data` gives
 * the template author the loop and the layout:
 *
 *   {{#each visits}}  - {{this.weekday}}, {{this.date}} at {{this.time}}
 *   {{/each}}
 *
 * Code owns correct, live, structured data. The Template Bank owns how it reads.
 *
 * `{{bookingDate}}` / `{{bookingTime}}` are NOT superseded by any of this. They
 * are correct for a message about ONE visit, and `enrichTemplateData` still owns
 * them. It imports the two formatters below so there is exactly one spelling of
 * a booking date in the codebase, not two.
 */

/**
 * Display timezone fallback, shared with `enrichTemplateData`. The operator's
 * real value lives in `business_settings/business_settings.timeZone`.
 */
export const DEFAULT_TIME_ZONE = 'America/New_York';

/** Where SMS and push send a recipient who cannot be given the whole list. */
export const PORTAL_URL = 'https://kinfolk.tribetails.com';

/** One visit of an envelope, reduced to the two things the formatter needs. */
export interface EnvelopeVisit {
  visitId: string;
  startTimeMs: number;
}

/** One visit as a template author consumes it. No formatting left to do. */
export interface RenderedVisit {
  /** '2026-09-04'. Sorting key, and the portal deep-link's day. */
  dateIso: string;
  /** 'Thu' */
  weekday: string;
  /** 'Sep 4' */
  date: string;
  /** '9:00 AM' */
  time: string;
  visitId: string;
}

/** The exact `data` block a date-bearing dispatch carries (spec: "Data shape"). */
export interface VisitDateData {
  visits: RenderedVisit[];
  visitCount: number;
  /** SMS and push name this one instead of enumerating. Null on an empty set. */
  nextVisit: { weekday: string; date: string; time: string } | null;
  /**
   * Dates the recipient was told about and that are no longer happening.
   *
   * ALWAYS EMPTY TODAY, and that is the spec's own answer, not an oversight:
   * naming what was dropped needs the `lastNotifiedVisitIds` diff store, which
   * is step 4 and blocked on an open operator question (does `removed`
   * accumulate across messages, or reset once reported?). Carried in the shape
   * now so a template written today does not have to be rewritten when it lands.
   */
  removed: Array<{ weekday: string; date: string; dateIso: string }>;
  removedCount: number;
  portalUrl: string;
}

/** Timestamp | ISO string | epoch millis -> millis, or null when unreadable. */
export function startMillisOf(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  const ts = v as { toMillis?: () => number; toDate?: () => Date };
  if (typeof ts.toMillis === 'function') {
    try {
      const ms = ts.toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  if (typeof ts.toDate === 'function') {
    try {
      const ms = ts.toDate().getTime();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 'Thu' */
export function formatWeekday(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(new Date(ms));
}

/** 'Sep 4' */
export function formatDayAndMonth(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(
    new Date(ms),
  );
}

/** '2026-09-04'. en-CA is ISO-ordered, which is why it is the locale here. */
export function formatDateIso(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz,
  }).format(new Date(ms));
}

/**
 * 'Thu, Sep 4'. The single-visit `{{bookingDate}}` spelling every booking
 * template has always used. Exported so `enrichTemplateData` and the emitters
 * below share ONE definition rather than drifting apart.
 */
export function formatBookingDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  }).format(new Date(ms));
}

/** '2:30 PM'. The `{{bookingTime}}` spelling; same single-definition reason. */
export function formatBookingTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(ms));
}

/** One visit, fully formatted. */
export function renderVisit(visit: EnvelopeVisit, tz: string): RenderedVisit {
  return {
    dateIso: formatDateIso(visit.startTimeMs, tz),
    weekday: formatWeekday(visit.startTimeMs, tz),
    date: formatDayAndMonth(visit.startTimeMs, tz),
    time: formatBookingTime(visit.startTimeMs, tz),
    visitId: visit.visitId,
  };
}

/**
 * The whole `data` block for a date-bearing dispatch.
 *
 * Sorts oldest-first here rather than trusting the caller, because `nextVisit`
 * is defined as the earliest one and an unsorted list would name the wrong day
 * on the two channels that only get to name one.
 */
export function buildVisitDateData(visits: EnvelopeVisit[], tz: string): VisitDateData {
  const sorted = [...visits].sort((a, b) => a.startTimeMs - b.startTimeMs);
  const rendered = sorted.map((v) => renderVisit(v, tz));
  const first = rendered[0];
  return {
    visits: rendered,
    visitCount: rendered.length,
    nextVisit: first ? { weekday: first.weekday, date: first.date, time: first.time } : null,
    removed: [],
    removedCount: 0,
    portalUrl: PORTAL_URL,
  };
}

/**
 * The operator's display timezone. Never throws: an unreadable settings document
 * falls back to the zone the schedulers already run in.
 */
export async function loadBusinessTimeZone(): Promise<string> {
  try {
    const snap = await db().collection('business_settings').doc('business_settings').get();
    const tz = (snap.data() as Record<string, unknown> | undefined)?.['timeZone'];
    if (typeof tz === 'string' && tz.trim().length > 0) return tz;
  } catch {
    // keep the default
  }
  return DEFAULT_TIME_ZONE;
}

/** Statuses that are not part of "the visits this booking covers". */
const NOT_HAPPENING = new Set(['cancelled', 'unavailable']);

/**
 * Every live visit of one envelope, oldest first, read at CALL time.
 *
 * "At call time" is the point. A `startTimeMsList` captured when the booking was
 * made is stale the moment a visit is cancelled, and the message would then
 * report visits that are not happening. So this re-reads, and it drops
 * `cancelled` / `unavailable` children.
 *
 * DELIBERATE DIFFERENCE FROM `onBookingEnvelopeCreate` (#532), which reads ALL
 * children including confirmed ones and filters nothing: at the CREATE moment
 * `maybeAutoConfirm` may already have flipped every child, so filtering there
 * would hand an auto-confirmed envelope an empty list. Every LATER moment wants
 * cancelled visits excluded. The two rules look contradictory and are not; this
 * is written down because the spec asked for it to be.
 *
 * Never throws: a failed read returns an empty list and the caller decides
 * whether a message with no dates still beats no message at all.
 */
export async function loadEnvelopeVisits(
  kinfolkId: string,
  batchId: string,
): Promise<EnvelopeVisit[]> {
  const snap = await db()
    .doc(`families/${kinfolkId}/bookings/${batchId}`)
    .collection('kinCares')
    .get();
  const out: EnvelopeVisit[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const status = typeof data['status'] === 'string' ? data['status'] : '';
    if (NOT_HAPPENING.has(status)) continue;
    const ms = startMillisOf(data['startTime']);
    if (ms == null) continue;
    out.push({ visitId: doc.id, startTimeMs: ms });
  }
  return out.sort((a, b) => a.startTimeMs - b.startTimeMs);
}

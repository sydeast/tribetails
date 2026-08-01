import { threadHouseholdName, threadPreviewText } from './inboxFormat';
import { sessionState, sessionDayKey, sessionHousehold, shiftDayIso } from './sessionFormat';
import { isoDatePrefixOrNull } from './invoiceFormat';
import { str, arr } from './coerce';
import { isArchivedInvoice, type InvoiceEntry } from '../api/invoices';
import type { GeneratedDraftRow } from '../api/drafts';
import type { ConversationSummary } from '../api/inbox';
import type { SessionEntry } from '../api/sessions';
import type { KinfolkProfile } from '../api/kinfolkProfile';
import type { ExpirationRow } from '../api/expirations';
import type { ExpenseRow } from '../api/expenses';
import type { SupplyRow } from '../api/supplies';

/**
 * Pure logic behind the Home dashboard insight widgets (the React port of the
 * Compose `screens/home/DashboardInsights.kt`). Every rule lives here, free of
 * React and Firebase, so it is unit-testable in isolation (see
 * `dashboardInsights.test.ts`); the widget components in `screens/widgets/` only
 * render what these functions return.
 *
 * The Compose dashboard already ships W8..W13 (weekly capacity, overdue,
 * species, frequent flyers, holiday runway); this module is where the React
 * rebuild's own widgets land, widget by widget, starting with the ones that read
 * an existing data source with no new backend.
 */

// ── AO-38 / W6 Unread Client Messages ─────────────────────────────────────────

/** One unread household thread, ready to render as a dashboard row. */
export interface UnreadMessage {
  kinfolkId: string;
  household: string;
  preview: string;
  atMs: number;
}

/**
 * The most recent unread client threads for the "Unread Client Messages" widget
 * (AO-38 / punch-list W6). Reads the SAME `listConversations` summaries the
 * Inbox screen loads (`api/inbox.ts`) and keeps only rows the admin has not read
 * (`unreadForAdmin`, the positive `threadReadState === 'unread'` signal, never a
 * negation), most recent first, capped at [limit]. A blank household name falls
 * back to the id and a blank preview to '' via the shared inbox helpers, so a
 * partial thread never renders `undefined`. Does not mutate [rows].
 */
export function unreadClientMessages(
  rows: readonly ConversationSummary[],
  limit = 5,
): UnreadMessage[] {
  return rows
    .filter((r) => r.unreadForAdmin)
    .slice()
    .sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs)
    .slice(0, Math.max(0, limit))
    .map((r) => ({
      kinfolkId: r.kinfolkId,
      household: threadHouseholdName(r.kinfolkName, r.kinfolkId),
      preview: threadPreviewText(r.lastMessagePreview),
      atMs: r.lastMessageAtMs,
    }));
}

/**
 * Total unread threads (the widget's headline count), independent of the
 * [unreadClientMessages] display cap so "3 shown" can still say "12 waiting".
 */
export function unreadClientMessageCount(rows: readonly ConversationSummary[]): number {
  return rows.reduce((n, r) => (r.unreadForAdmin ? n + 1 : n), 0);
}

// ── AO-36 / W3 Key & Code Safebox ──────────────────────────────────────────────

/**
 * The single NEXT upcoming visit for the "Key & Code Safebox" widget (AO-36 /
 * W3), which surfaces the access notes for that visit's household only. Keeps a
 * session whose start is now or later ([nowIso] is a full ISO instant, and start
 * times compare lexicographically for the `...Z` writes, the same string-compare
 * the sessions list already relies on) and whose state is neither cancelled nor
 * completed (the positive `sessionState` enum, never a status-string negation),
 * then returns the earliest such start. `null` when nothing is coming up.
 */
export function nextUpcomingSession(
  sessions: readonly SessionEntry[],
  nowIso: string,
): SessionEntry | null {
  let best: SessionEntry | null = null;
  let bestStart = '';
  for (const s of sessions) {
    const state = sessionState(str(s.status));
    if (state === 'cancelled' || state === 'completed') continue;
    const start = str(s.startTime);
    if (start === '' || start < nowIso) continue;
    if (best === null || start < bestStart) {
      best = s;
      bestStart = start;
    }
  }
  return best;
}

/** One labelled access fact (gate code, entry notes, ...). */
export interface AccessLine {
  label: string;
  value: string;
  /** Render monospaced (a code / password), not prose. */
  mono?: boolean;
  /**
   * A household access secret: render it masked behind a reveal toggle, not in
   * plaintext. Distinct from [mono], which is only typography. This is the
   * dashboard, so these lines sit on screen with no household even opened.
   */
  secret?: boolean;
}

/**
 * The household's access notes as display lines, blank fields dropped so a
 * partial household never renders an empty "Gate code:" row. Codes/passwords are
 * flagged [mono] so the widget renders them monospaced, and [secret] so it masks
 * them. Order is arrival order: where you're going, how you get in, then the wifi
 * once inside.
 */
export function safeboxAccessLines(p: KinfolkProfile): AccessLine[] {
  const lines: AccessLine[] = [];
  const add = (label: string, value: string, mono = false, secret = false): void => {
    if (value.trim() === '') return;
    const line: AccessLine = { label, value };
    if (mono) line.mono = true;
    if (secret) line.secret = true;
    lines.push(line);
  };
  add('Address', p.serviceAddress);
  add('Gate / door code', p.gateCode, true, true);
  add('Entry notes', p.entryNotes);
  add('Parking', p.parkingInstructions);
  add('WiFi network', p.wifiName);
  add('WiFi password', p.wifiPassword, true, true);
  return lines;
}

// ── shared date helper ─────────────────────────────────────────────────────────

/**
 * Whole-calendar-day difference `b - a` for two `YYYY-MM-DD` strings, via
 * UTC-anchored arithmetic (no time-of-day involved, so no zone ambiguity). Same
 * approach `sessionFormat.ts` uses for its day-group labels; duplicated here as a
 * tiny private helper rather than widening that module's surface.
 */
function wholeDaysBetween(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.slice(0, 10).split('-').map(Number);
  const [by, bm, bd] = bIso.slice(0, 10).split('-').map(Number);
  const aUtc = Date.UTC(ay ?? 1970, (am ?? 1) - 1, ad ?? 1);
  const bUtc = Date.UTC(by ?? 1970, (bm ?? 1) - 1, bd ?? 1);
  return Math.round((bUtc - aUtc) / 86_400_000);
}

// ── AO-37 Care Flags ────────────────────────────────────────────────────────────

/** Which care concern a flag is about. Drives both the label and the sort order. */
export type CareFlagKind = 'reactive' | 'medication' | 'feeding';

/** One care concern for one pet on today's roster, ready to render as a row. */
export interface CareFlag {
  kinId: string;
  kinName: string;
  household: string;
  kind: CareFlagKind;
  text: string;
}

/**
 * The three care fields `careFlags` reads off a `kin` doc. Kept minimal (a subset
 * of `api/kinCare.ts#KinCareRow`) so a caller can build the lookup map from any
 * pet source. `reactive` is already narrowed to a real boolean and the two note
 * fields to real strings by the caller, so this module never sees `undefined`.
 */
export interface KinCareInfo {
  name: string;
  reactive: boolean;
  medicationHealthNotes: string;
  feedingBrand: string;
}

/** reactive first, then medication, then feeding (the render + sort priority). */
const CARE_KIND_RANK: Record<CareFlagKind, number> = { reactive: 0, medication: 1, feeding: 2 };

/**
 * The care flags for TODAY's roster (AO-37). Reads no backend of its own: it
 * joins today's non-cancelled sessions ([sessions], filtered by LOCAL day via
 * `sessionDayKey` so the AO-18 zone bug cannot creep back in) to the pet docs in
 * [kinById] (keyed by the flat `kin` doc id, which is what `session.kinIds`
 * holds). For each pet on a session it emits a flag when the pet is reactive
 * (text "Reactive, handle with care"), has non-blank medication/health notes
 * (text = those notes), or has a non-blank feeding brand (text = the brand).
 *
 * A pet appearing on two of today's sessions is flagged once per concern (dedup
 * by `kinId` + `kind`), and the result is sorted reactive, then medication, then
 * feeding (a stable sort, so same-kind rows keep their first-seen order). A
 * session whose pet is not in [kinById] contributes nothing rather than a blank
 * row. Does not mutate its inputs.
 */
export function careFlags(
  sessions: readonly SessionEntry[],
  kinById: ReadonlyMap<string, KinCareInfo>,
  todayIso: string,
): CareFlag[] {
  const flags: CareFlag[] = [];
  const seen = new Set<string>();
  const push = (
    kinId: string,
    info: KinCareInfo,
    household: string,
    kind: CareFlagKind,
    text: string,
  ): void => {
    const key = `${kinId}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({ kinId, kinName: info.name, household, kind, text });
  };

  for (const s of sessions) {
    if (sessionState(str(s.status)) === 'cancelled') continue;
    if (sessionDayKey(str(s.startTime)) !== todayIso) continue;
    const household = sessionHousehold(str(s.kinfolkName));
    for (const kinId of arr<string>(s.kinIds)) {
      const info = kinById.get(kinId);
      if (!info) continue;
      if (info.reactive) push(kinId, info, household, 'reactive', 'Reactive, handle with care');
      const meds = info.medicationHealthNotes.trim();
      if (meds !== '') push(kinId, info, household, 'medication', meds);
      const feed = info.feedingBrand.trim();
      if (feed !== '') push(kinId, info, household, 'feeding', feed);
    }
  }

  flags.sort((a, b) => CARE_KIND_RANK[a.kind] - CARE_KIND_RANK[b.kind]);
  return flags;
}

// ── AO-39 Expiration Countdown ──────────────────────────────────────────────────

/** One upcoming expiry, ready to render as a countdown row. */
export interface ExpRow {
  label: string;
  /** Normalized `YYYY-MM-DD`. */
  dateIso: string;
  /** Whole days from today until the expiry (0 = expires today). */
  daysUntil: number;
  kind: string;
}

/**
 * The expiries falling in the near horizon (AO-39). Keeps a row whose `dateIso`
 * parses to a real `YYYY-MM-DD` (via `isoDatePrefixOrNull`, so "soon" text never
 * fabricates an ordering) AND is today-or-later AND within [withinDays], then
 * sorts by `dateIso` ascending. `daysUntil` is the whole-day gap from [todayIso].
 * A row with an unparseable date is dropped, not guessed at. Does not mutate its
 * input.
 */
export function upcomingExpirations(
  rows: readonly Pick<ExpirationRow, 'label' | 'dateIso' | 'kind'>[],
  todayIso: string,
  withinDays = 60,
): ExpRow[] {
  const out: ExpRow[] = [];
  for (const r of rows) {
    const iso = isoDatePrefixOrNull(str(r.dateIso));
    if (iso === null) continue;
    const daysUntil = wholeDaysBetween(todayIso, iso);
    if (daysUntil < 0 || daysUntil > withinDays) continue;
    out.push({ label: str(r.label), dateIso: iso, daysUntil, kind: str(r.kind) });
  }
  out.sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  return out;
}

// ── AO-40 Expense Quick-Log ──────────────────────────────────────────────────────

/**
 * The most recent expenses, newest first (AO-40). Sorts by `occurredAt` (an ISO
 * instant string, so a lexical compare is chronological for the `...Z` writes)
 * descending and caps at [limit]. A non-positive limit yields no rows. Does not
 * mutate its input.
 */
export function recentExpenses(list: readonly ExpenseRow[], limit = 5): ExpenseRow[] {
  return list
    .slice()
    .sort((a, b) => {
      const av = str(a.occurredAt);
      const bv = str(b.occurredAt);
      return av < bv ? 1 : av > bv ? -1 : 0;
    })
    .slice(0, Math.max(0, limit));
}

/**
 * "$12.34" from an integer count of cents. Negative renders "-$12.34" (a refund
 * / correction), and a non-finite input reads as $0.00 rather than "$NaN".
 */
export function formatCents(cents: number): string {
  const n = Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

// ── AO-41 Supplies Tracker ───────────────────────────────────────────────────────

/**
 * The supplies at or below their reorder threshold (AO-41), most-depleted first.
 * Keeps `onHand <= par` (the same "low" rule the server counts by) and sorts by
 * `onHand - par` ascending, so the deepest shortfall (most negative) leads. Does
 * not mutate its input.
 */
export function lowSupplies(list: readonly SupplyRow[]): SupplyRow[] {
  return list
    .filter((s) => s.onHand <= s.par)
    .slice()
    .sort((a, b) => a.onHand - a.par - (b.onHand - b.par));
}

// ── AO-35 Route Optimizer ────────────────────────────────────────────────────────

/** "12.3 mi" from a mileage. Non-finite reads as "0.0 mi", never "NaN mi". */
export function formatMiles(miles: number): string {
  const n = Number.isFinite(miles) ? miles : 0;
  return `${n.toFixed(1)} mi`;
}

/**
 * "45m" / "1h 05m" from a whole-minute duration. Rounds to the nearest minute,
 * floors negatives at zero, and pads the minutes inside an hour so "1h 5m" reads
 * "1h 05m". Non-finite reads as "0m".
 */
export function formatDuration(minutes: number): string {
  const total = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}
// ─────────────────────────────────────────────────────────────────────────────
// D2 PARITY PORT: the twelve widgets android draws and this admin did not.
//
// Everything below is a transcription of android's own pure logic, not a
// reinterpretation of it:
//   `ui/home/DashboardInsights.kt`  weekly capacity, overdue, species,
//                                   frequent flyers, holiday runway
//   `domain/HouseholdVisitGaps.kt`  gatekeeper
//   `domain/Stage2Step2Helpers.kt`  weekly revenue + the paid test
//   `ui/home/HomeViewModel.kt`      the stat row's four counts, cash flow
//   `ui/home/HomeScreen.kt`         the tale row's three slots, formatRevenue
//
// Same rules, same thresholds, same drop-rather-than-guess behaviour, because
// both surfaces read ONE set of documents and an operator who checks a number
// on the phone against the same number here must find them equal.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The Monday of [todayIso]'s week, as `YYYY-MM-DD`, or null when the input is
 * not a readable calendar day.
 *
 * UTC-anchored like `wholeDaysBetween` above and `shiftDayIso` in
 * `sessionFormat.ts`: no time-of-day is involved, so no zone can shift which
 * week a day belongs to. Mirrors android's `LocalDate.mondayOfWeek()`, which
 * uses `dayOfWeek.value` (Mon=1 … Sun=7); `getUTCDay()` is Sun=0 … Sat=6, hence
 * the `(dow + 6) % 7` rather than `dow - 1`.
 */
export function mondayOfWeekIso(todayIso: string): string | null {
  const iso = isoDatePrefixOrNull(todayIso);
  if (iso === null) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return shiftDayIso(iso, -((at.getUTCDay() + 6) % 7));
}
/** Cancelled spelled both ways, exactly as android's `CANCELLED_STATUSES`. */
function isCancelledSession(row: Pick<SessionEntry, 'status'>): boolean {
  const s = str(row.status).trim().toUpperCase();
  return s === 'CANCELLED' || s === 'CANCELED';
}
/** True only for a session whose status literally reads COMPLETED. */
function isCompletedSession(row: Pick<SessionEntry, 'status'>): boolean {
  return str(row.status).trim().toUpperCase() === 'COMPLETED';
}
// ── W8 Weekly capacity ────────────────────────────────────────────────────────
/**
 * This week's booked visits against the busiest of the four weeks before it.
 *
 * `capacity` is the denominator the bar fills against: the record, or this
 * week if this week is already bigger, and never zero (a first-ever week would
 * otherwise divide by nothing). `beatingRecord` mirrors android exactly,
 * including its "first week with any visits at all counts as beating a zero
 * record" branch.
 */
export interface WeeklyCapacity {
  booked: number;
  record: number;
  capacity: number;
  /** `booked / capacity`, clamped to 0..1. */
  fraction: number;
  beatingRecord: boolean;
}
/**
 * [sessions] counted into the current week and the four before it (AO-24 / W8).
 * A cancelled visit is not booked capacity, and a session whose `startTime`
 * carries no readable date is dropped rather than counted into whichever week
 * happens to be first. Null when [todayIso] is not a readable day.
 */
export function weeklyCapacity(
  sessions: readonly SessionEntry[],
  todayIso: string,
): WeeklyCapacity | null {
  const monday = mondayOfWeekIso(todayIso);
  if (monday === null) return null;
  const weekCount = (weekStart: string): number => {
    const weekEnd = shiftDayIso(weekStart, 7);
    let n = 0;
    for (const s of sessions) {
      if (isCancelledSession(s)) continue;
      const day = isoDatePrefixOrNull(str(s.startTime));
      if (day === null) continue;
      if (day >= weekStart && day < weekEnd) n += 1;
    }
    return n;
  };
  const booked = weekCount(monday);
  let record = 0;
  for (let back = 1; back <= 4; back += 1) {
    record = Math.max(record, weekCount(shiftDayIso(monday, -7 * back)));
  }
  const capacity = Math.max(record, booked, 1);
  return {
    booked,
    record,
    capacity,
    fraction: Math.min(1, Math.max(0, booked / capacity)),
    beatingRecord: (record >= 1 && record < booked) || (record === 0 && booked > 0),
  };
}
// ── W9 Overdue visits ─────────────────────────────────────────────────────────
/** One visit that is past its end and still not marked complete. */
export interface OverdueVisit {
  sessionId: string;
  household: string;
  serviceType: string;
  /** The `endTime` it ran past, or its `startTime` when no end was stamped. */
  endedAt: string;
}
/**
 * Visits whose end has passed with no COMPLETED (or CANCELLED) status on them,
 * newest miss first, within a [withinDays] staleness horizon so a visit
 * abandoned last year does not sit at the bottom of the card forever.
 *
 * [todayIso] is a `YYYY-MM-DD` day, matching android, which passes
 * `LocalDate.now().toString()`. The `end >= todayIso` guard is a lexical
 * compare of a full ISO instant against that day prefix, so anything ending
 * today or later is excluded: a visit still has the rest of its day to be
 * closed out before this card calls it overdue.
 */
export function overdueVisits(
  sessions: readonly SessionEntry[],
  todayIso: string,
  withinDays = 30,
): OverdueVisit[] {
  const today = isoDatePrefixOrNull(todayIso);
  if (today === null) return [];
  const staleBefore = shiftDayIso(today, -withinDays);
  const out: OverdueVisit[] = [];
  for (const s of sessions) {
    if (isCompletedSession(s) || isCancelledSession(s)) continue;
    const end = str(s.endTime) === '' ? str(s.startTime) : str(s.endTime);
    const endDay = isoDatePrefixOrNull(end);
    if (endDay === null) continue;
    if (end >= today || endDay < staleBefore) continue;
    out.push({
      sessionId: s._id,
      household: sessionHousehold(str(s.kinfolkName)),
      serviceType: str(s.serviceType),
      endedAt: end,
    });
  }
  out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : 0));
  return out;
}
// ── W10 Kin by type ───────────────────────────────────────────────────────────
/** One species and how many of the pack are it. */
export interface SpeciesSlice {
  species: string;
  count: number;
}
/**
 * The roster grouped by species, biggest group first then alphabetically
 * (AO-24 / W10). An archived pet is not in the pack. A blank species reads as
 * "Unknown" rather than being dropped, because a pet with no species on file is
 * still a pet in someone's care; only the label is unknown.
 */
export function speciesBreakdown(
  kin: readonly { species?: string | undefined; status?: string | undefined }[],
): SpeciesSlice[] {
  const counts = new Map<string, number>();
  for (const k of kin) {
    if (str(k.status).trim().toLowerCase() === 'archived') continue;
    const raw = str(k.species).trim().toLowerCase();
    const label = raw === '' ? 'Unknown' : raw.charAt(0).toUpperCase() + raw.slice(1);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([species, count]) => ({ species, count }))
    .sort((a, b) => b.count - a.count || (a.species < b.species ? -1 : a.species > b.species ? 1 : 0));
}
// ── W11 Frequent flyers ───────────────────────────────────────────────────────
/** One household and how many completed visits it has had in the window. */
export interface FrequentFlyer {
  household: string;
  visits: number;
}
/**
 * The most-visited households over the last [days] (AO-24 / W11). Counts
 * COMPLETED visits only, dated by `completedAt` where it was stamped and by
 * `startTime` where it was not (a completed visit did happen, so its start is
 * an honest stand-in). Grouped by `kinfolkId`, falling back to the name for a
 * legacy row that carries no id; a group with no readable name anywhere is
 * dropped rather than rendered as an anonymous count.
 */
export function frequentFlyers(
  sessions: readonly SessionEntry[],
  todayIso: string,
  days = 90,
  limit = 5,
): FrequentFlyer[] {
  const today = isoDatePrefixOrNull(todayIso);
  if (today === null) return [];
  const since = shiftDayIso(today, -days);
  const groups = new Map<string, { name: string; visits: number }>();
  for (const s of sessions) {
    if (!isCompletedSession(s)) continue;
    const stamp = str(s.completedAt) === '' ? str(s.startTime) : str(s.completedAt);
    const day = isoDatePrefixOrNull(stamp);
    if (day === null || day < since || day > today) continue;
    const name = str(s.kinfolkName).trim();
    const key = str(s.kinfolkId).trim() === '' ? name : str(s.kinfolkId).trim();
    const entry = groups.get(key) ?? { name: '', visits: 0 };
    entry.visits += 1;
    if (entry.name === '' && name !== '') entry.name = name;
    groups.set(key, entry);
  }
  return [...groups.values()]
    .filter((g) => g.name !== '')
    .map((g) => ({ household: g.name, visits: g.visits }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, Math.max(0, limit));
}
// ── W12 Holiday runway ────────────────────────────────────────────────────────
/** One US pet-care holiday and the day it falls on, as `YYYY-MM-DD`. */
export interface PetCareHoliday {
  name: string;
  dateIso: string;
}
/** The [n]th [isoWeekday] (Mon=1 … Sun=7) of a month, as `YYYY-MM-DD`. */
function nthWeekdayIso(year: number, month: number, isoWeekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstIso = ((first.getUTCDay() + 6) % 7) + 1;
  const offset = (isoWeekday - firstIso + 7) % 7;
  const day = 1 + offset + 7 * (n - 1);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
/** The last [isoWeekday] on or before [lastDay] of a month, as `YYYY-MM-DD`. */
function lastWeekdayIso(year: number, month: number, lastDay: number, isoWeekday: number): string {
  const last = new Date(Date.UTC(year, month - 1, lastDay));
  const lastIso = ((last.getUTCDay() + 6) % 7) + 1;
  const back = (lastIso - isoWeekday + 7) % 7;
  return shiftDayIso(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    -back,
  );
}
/**
 * The six US holidays that move a pet-care book (AO-24 / W12), for one year.
 * Same six, same rules, as android's `usPetCareHolidays`.
 */
export function usPetCareHolidays(year: number): PetCareHoliday[] {
  return [
    { name: "New Year's Day", dateIso: `${String(year).padStart(4, '0')}-01-01` },
    { name: 'Memorial Day', dateIso: lastWeekdayIso(year, 5, 31, 1) },
    { name: 'July 4th', dateIso: `${String(year).padStart(4, '0')}-07-04` },
    { name: 'Labor Day', dateIso: nthWeekdayIso(year, 9, 1, 1) },
    { name: 'Thanksgiving', dateIso: nthWeekdayIso(year, 11, 4, 4) },
    { name: 'Christmas', dateIso: `${String(year).padStart(4, '0')}-12-25` },
  ];
}
/** One upcoming holiday and what is already on the books around it. */
export interface HolidayRunway {
  name: string;
  dateIso: string;
  daysUntil: number;
  /** Non-cancelled visits within two days either side of the holiday. */
  bookedVisits: number;
}
/**
 * The next [count] pet-care holidays and the visits already booked in the
 * five-day window around each (AO-24 / W12). Looks at this year and next, so
 * December never reports "no holidays coming".
 */
export function holidayRunway(
  sessions: readonly SessionEntry[],
  todayIso: string,
  count = 3,
): HolidayRunway[] {
  const today = isoDatePrefixOrNull(todayIso);
  if (today === null) return [];
  const year = Number(today.slice(0, 4));
  if (!Number.isFinite(year)) return [];
  return [...usPetCareHolidays(year), ...usPetCareHolidays(year + 1)]
    .filter((h) => h.dateIso >= today)
    .sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0))
    .slice(0, Math.max(0, count))
    .map((h) => {
      const from = shiftDayIso(h.dateIso, -2);
      const to = shiftDayIso(h.dateIso, 2);
      let booked = 0;
      for (const s of sessions) {
        if (isCancelledSession(s)) continue;
        const day = isoDatePrefixOrNull(str(s.startTime));
        if (day === null) continue;
        if (day >= from && day <= to) booked += 1;
      }
      return {
        name: h.name,
        dateIso: h.dateIso,
        daysUntil: wholeDaysBetween(today, h.dateIso),
        bookedVisits: booked,
      };
    });
}
// ── W14 Gatekeeper ────────────────────────────────────────────────────────────
/** One household and how long it has gone without a completed visit. */
export interface HouseholdGap {
  household: string;
  daysSinceLastVisit: number;
}
/**
 * Households ranked by days since their last COMPLETED visit, longest gap
 * first (the port of android's `domain/HouseholdVisitGaps.kt`). Dated by
 * `completedAt` where stamped, `startTime` otherwise. A household whose most
 * recent completed visit is in the FUTURE is dropped rather than reported as a
 * negative gap: that is a clock or data problem, not a household to chase.
 */
export function householdVisitGaps(
  sessions: readonly SessionEntry[],
  todayIso: string,
  limit = 5,
): HouseholdGap[] {
  const today = isoDatePrefixOrNull(todayIso);
  if (today === null) return [];
  const groups = new Map<string, { name: string; last: string }>();
  for (const s of sessions) {
    if (!isCompletedSession(s)) continue;
    const name = str(s.kinfolkName).trim();
    const key = str(s.kinfolkId).trim() === '' ? name : str(s.kinfolkId).trim();
    const stamp = str(s.completedAt) === '' ? str(s.startTime) : str(s.completedAt);
    const day = isoDatePrefixOrNull(stamp);
    const entry = groups.get(key) ?? { name: '', last: '' };
    if (entry.name === '' && name !== '') entry.name = name;
    if (day !== null && day > entry.last) entry.last = day;
    groups.set(key, entry);
  }
  return [...groups.values()]
    .filter((g) => g.name !== '' && g.last !== '')
    .map((g) => ({ household: g.name, daysSinceLastVisit: wholeDaysBetween(g.last, today) }))
    .filter((g) => g.daysSinceLastVisit >= 0)
    .sort((a, b) => b.daysSinceLastVisit - a.daysSinceLastVisit)
    .slice(0, Math.max(0, limit));
}
// ── W15 Cash flow + the stat row's "This week" ────────────────────────────────
/**
 * The canonical PAID test for revenue, ported verbatim from android's
 * `invoiceIsPaidForRevenue`: not a draft, nothing still owed, and a positive
 * total. A zero-total invoice is not revenue, it is paperwork.
 */
export function invoiceIsPaidForRevenue(
  row: Pick<InvoiceEntry, 'status' | 'amountDue' | 'total'>,
): boolean {
  return str(row.status).trim().toLowerCase() !== 'draft' && row.amountDue <= 0 && row.total > 0;
}
/**
 * Money collected in the week window [weekStartIso]..[nowIso], both inclusive
 * on the `YYYY-MM-DD` prefix of the invoice's own `date`.
 *
 * ARCHIVED INVOICES ARE NOT REVENUE, and that guard stays separate from the
 * paid test above for the reason android's copy of this records: the paid test
 * is mirrored on three surfaces, and folding an archive concern into it would
 * make them disagree about what "paid" means. An invoice whose `date` does not
 * parse is skipped, never counted into whichever week is nearest.
 */
export function weeklyRevenue(
  invoices: readonly InvoiceEntry[],
  weekStartIso: string,
  nowIso: string,
): number {
  const start = isoDatePrefixOrNull(weekStartIso);
  const end = isoDatePrefixOrNull(nowIso);
  if (start === null || end === null) return 0;
  let sum = 0;
  for (const inv of invoices) {
    if (isArchivedInvoice(inv)) continue;
    if (!invoiceIsPaidForRevenue(inv)) continue;
    const date = isoDatePrefixOrNull(str(inv.date));
    if (date === null) continue;
    if (date >= start && date <= end) sum += inv.total;
  }
  return sum;
}
/** What is still owed across the book, and across how many invoices. */
export interface OutstandingTotals {
  total: number;
  count: number;
}
/**
 * The Cash Flow card's second row: every non-archived invoice with a positive
 * `amountDue`, summed. Android reads `invoices.filter { it.amountDue > 0.0 }`;
 * the archive guard is the same one `weeklyRevenue` applies, because an invoice
 * that has been written off is not money anyone is waiting on.
 */
export function outstandingTotals(invoices: readonly InvoiceEntry[]): OutstandingTotals {
  let total = 0;
  let count = 0;
  for (const inv of invoices) {
    if (isArchivedInvoice(inv)) continue;
    if (!(inv.amountDue > 0)) continue;
    total += inv.amountDue;
    count += 1;
  }
  return { total, count };
}
/**
 * "$1,280" from a dollar amount: the stat tile's compact label, rounded to the
 * dollar and thousands-grouped, ported from android's `formatRevenue`. The Cash
 * Flow rows use `formatUsd` (cents kept) instead, exactly as android uses its
 * own `formatMoney` there: a tile is a glance, a ledger row is an amount.
 */
export function formatRevenue(dollars: number): string {
  const n = Number.isFinite(dollars) ? Math.round(dollars) : 0;
  const sign = n < 0 ? '-' : '';
  const grouped = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}`;
}
// ── W1 Stats + W2 Today's Pack ────────────────────────────────────────────────
/** Today's visit run, and how much of it is already behind the operator. */
export interface TodayPack {
  /** Every session starting on [todayIso], soonest first. */
  visits: SessionEntry[];
  done: number;
  onTheWay: number;
}
/**
 * Today's run (AO-24 / W1+W2). "Today" is the LOCAL calendar day via
 * `sessionDayKey`, the AO-18 fix, so an operator west of Greenwich does not
 * lose the evening's visits to UTC. Every status is included, cancellations
 * too, because android's `getKinCareSessionsForDay` does not filter and the
 * headline count has to match the phone's. `done` counts COMPLETED and
 * `onTheWay` counts ON_MY_WAY + ARRIVED, exactly as the phone's trend line does.
 */
export function todayPack(sessions: readonly SessionEntry[], todayIso: string): TodayPack {
  const visits = sessions
    .filter((s) => sessionDayKey(str(s.startTime)) === todayIso)
    .slice()
    .sort((a, b) => {
      const av = str(a.startTime);
      const bv = str(b.startTime);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  let done = 0;
  let onTheWay = 0;
  for (const s of visits) {
    const state = sessionState(str(s.status));
    if (state === 'completed') done += 1;
    if (state === 'onMyWay' || state === 'arrived') onTheWay += 1;
  }
  return { visits, done, onTheWay };
}
// ── W3 KinTales pending ───────────────────────────────────────────────────────
/**
 * The three slots one "KinTales pending" row fills. Android's `TaleRow` builds
 * exactly these, and the naming here keeps the spec's item-6 fix explicit: the
 * household name appears ONCE, in the meta line, never repeated as the blurb.
 */
export interface TaleRow {
  id: string;
  title: string;
  blurb: string;
  meta: string;
}
/**
 * The drafts worth reviewing, newest first, capped at [limit].
 *
 * Rows with no `generatedCopy` at all are dropped, matching android: those are
 * leftover import/seed shells with nothing in them to review, and rendering one
 * puts an empty card in front of the operator with no way to act on it.
 */
export function pendingTaleRows(
  drafts: readonly GeneratedDraftRow[],
  limit = 4,
): TaleRow[] {
  return drafts
    .filter((d) => str(d.generatedCopy).trim() !== '')
    .slice(0, Math.max(0, limit))
    .map((d) => {
      const type = str(d.communicationType).replace(/_/g, ' ').trim();
      const firstLine =
        str(d.generatedCopy)
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line !== '') ?? '';
      const household = str(d.kinfolkName).trim();
      const created = str(d.createdOn).slice(0, 10);
      const meta = [str(d.status).trim().toUpperCase() || 'DRAFT', household, created]
        .filter((part) => part !== '')
        .join(' · ');
      return {
        id: d._id,
        title: type === '' ? 'Visit report' : type,
        blurb: firstLine === '' ? 'No copy yet' : firstLine.slice(0, 120),
        meta,
      };
    });
}
/**
 * How many drafts are waiting on a decision: the stat row's "KinTales to
 * review". A POSITIVE match on `status === 'pending'`, which is the value
 * android's `getPendingDraftCount` counts server-side, never "not approved".
 */
export function pendingDraftCount(drafts: readonly GeneratedDraftRow[]): number {
  return drafts.reduce((n, d) => (str(d.status).trim().toLowerCase() === 'pending' ? n + 1 : n), 0);
}
/** Pets in care: the roster minus the archived. Mirrors android's kin count. */
export function activeKinCount(kin: readonly { status?: string | undefined }[]): number {
  return kin.reduce((n, k) => (str(k.status).trim().toLowerCase() === 'archived' ? n : n + 1), 0);
}

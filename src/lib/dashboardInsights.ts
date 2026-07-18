import { threadHouseholdName, threadPreviewText } from './inboxFormat';
import { sessionState, sessionDayKey, sessionHousehold } from './sessionFormat';
import { isoDatePrefixOrNull } from './invoiceFormat';
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
  for (const s of sessions) {
    const state = sessionState(s.status);
    if (state === 'cancelled' || state === 'completed') continue;
    if (s.startTime === '' || s.startTime < nowIso) continue;
    if (best === null || s.startTime < best.startTime) best = s;
  }
  return best;
}

/** One labelled access fact (gate code, entry notes, ...). */
export interface AccessLine {
  label: string;
  value: string;
  /** Render monospaced (a code / password), not prose. */
  mono?: boolean;
}

/**
 * The household's access notes as display lines, blank fields dropped so a
 * partial household never renders an empty "Gate code:" row. Codes/passwords are
 * flagged [mono] so the widget renders them monospaced. Order is arrival order:
 * where you're going, how you get in, then the wifi once inside.
 */
export function safeboxAccessLines(p: KinfolkProfile): AccessLine[] {
  const lines: AccessLine[] = [];
  const add = (label: string, value: string, mono = false): void => {
    if (value.trim() !== '') lines.push(mono ? { label, value, mono: true } : { label, value });
  };
  add('Address', p.serviceAddress);
  add('Gate / door code', p.gateCode, true);
  add('Entry notes', p.entryNotes);
  add('Parking', p.parkingInstructions);
  add('WiFi network', p.wifiName);
  add('WiFi password', p.wifiPassword, true);
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
    if (sessionState(s.status) === 'cancelled') continue;
    if (sessionDayKey(s.startTime) !== todayIso) continue;
    const household = sessionHousehold(s.kinfolkName);
    for (const kinId of s.kinIds) {
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
    const iso = isoDatePrefixOrNull(r.dateIso);
    if (iso === null) continue;
    const daysUntil = wholeDaysBetween(todayIso, iso);
    if (daysUntil < 0 || daysUntil > withinDays) continue;
    out.push({ label: r.label, dateIso: iso, daysUntil, kind: r.kind });
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
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
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

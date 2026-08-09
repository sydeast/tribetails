import type { Timestamp } from 'firebase/firestore';
import { dayKey, formatWhen, machineWhen, type FsTime } from './time';
import { sessionDayLabel, localDateIso } from './sessionFormat';

/**
 * Pure Inbox (message thread list) classification + display helpers, kept out
 * of the screen so the mapping logic has direct vitest coverage (the
 * invoiceFormat.ts / sessionFormat.ts convention).
 *
 * Source of truth: `listConversations` (MyTribe/functions/src/admin/
 * conversations.ts), confirmed live and deployed, admin-gated
 * (wrapAdminCallable), reading the `conversations/{kinfolkId}` collection (one
 * doc per household thread, defined in MyTribe/functions/src/lib/
 * conversations.ts). This module mirrors its `ConversationSummary` shape,
 * re-declared in `api/inbox.ts`.
 *
 * ── THE AO-18 FIX, adapted to THIS field's shape ──────────────────────────
 * `lastMessageAtMs` is a plain epoch-ms NUMBER (`Date.now()`, stamped in
 * `lib/conversations.ts#appendMessage`), not a Firestore `Timestamp` (like
 * notifications/invoices/sessions' `createdAt`) and not a free-text ISO
 * string (like `kin_care_sessions.startTime`, sessionFormat.ts's case). So
 * neither `lib/time.ts`'s Timestamp-typed helpers nor sessionFormat.ts's
 * ISO-string `sessionTimeOf` apply to it directly. `threadTimeOf` below wraps
 * the epoch ms in the SAME minimal fake-Timestamp `{ toDate: () => Date }`
 * sessionFormat.ts uses for its own different input shape, so day grouping and
 * clock display flow through `lib/time.ts`'s LOCAL
 * (`getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes`) helpers
 * unchanged. The bug this avoids is the same one AO-18 named elsewhere: a raw
 * `new Date(ms).toISOString().slice(0, 10)` would group an 8pm-CDT message
 * under the UTC next calendar day and show the UTC hour, five hours off from
 * what the operator actually saw arrive.
 *
 * `threadDayLabel` re-exports sessionFormat.ts's `sessionDayLabel` verbatim:
 * it is a pure `(dayKeyValue, todayIso) -> label` function with no
 * session-specific behavior (it already ships as the shared "relative day
 * label" helper for any `YYYY-MM-DD` pair), so this reuses it rather than
 * re-deriving the Today/Tomorrow/Yesterday/weekday logic a second time.
 * `localDateIso` is re-exported the same way sessionFormat.ts itself
 * re-exports it from invoiceFormat.ts, so this screen needn't reach into a
 * third module just for "today, as a local date".
 */

// ── epoch-ms -> local day/time (the AO-18 fix, this field's shape) ─────────

/**
 * Wraps a `conversations.lastMessageAtMs` epoch-ms number as a fake Firestore
 * `Timestamp` so it can flow through `lib/time.ts`'s LOCAL
 * `dayKey`/`formatWhen` unchanged. `null` for a non-finite / non-positive /
 * unparseable value, same "degrade honestly, never fabricate a date" contract
 * `lib/time.ts` and sessionFormat.ts already use for missing input.
 */
export function threadTimeOf(ms: number): FsTime {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/** LOCAL `YYYY-MM-DD` day-grouping key for a thread's `lastMessageAtMs`, or `'Undated'`. */
export function threadDayKey(ms: number): string {
  return dayKey(threadTimeOf(ms));
}

/**
 * LOCAL `HH:mm` clock time for a thread's `lastMessageAtMs`. Reuses
 * `formatWhen`'s `MM-DD HH:mm` in full and takes only the time half
 * (`.slice(6)`), matching sessionFormat.ts's `sessionClock`: the row's day
 * group header already carries the day, so repeating it per-row would be
 * noise, not a second AO-18 check.
 */
export function threadClock(ms: number): string {
  const full = formatWhen(threadTimeOf(ms));
  return full === '(no time)' ? full : full.slice(6);
}

/** Machine-readable local datetime for a row's `<time dateTime={…}>` attribute (the Notifications.tsx `machineWhen` convention). */
export function threadMachineTime(ms: number): string | undefined {
  return machineWhen(threadTimeOf(ms));
}

export { sessionDayLabel as threadDayLabel, localDateIso };

// ── read-state classification (positive enumeration, no negation) ─────────

/**
 * Every read state a thread can be in, from the server's `unreadForAdmin`
 * boolean. Named as its own type (rather than passing the boolean straight
 * through) so `FILTERS` in Inbox.tsx reads as a positive membership test
 * against an enumerated state, the sessionFormat.ts `SessionState` / AO-12
 * convention, not an ad hoc boolean check.
 */
export type ThreadReadState = 'unread' | 'read';

export function threadReadState(unreadForAdmin: boolean): ThreadReadState {
  return unreadForAdmin ? 'unread' : 'read';
}

/** Count of threads with an unread admin-side message, for the Inbox header badge. Pure. */
export function unreadThreadCount(rows: readonly { unreadForAdmin: boolean }[]): number {
  return rows.filter((r) => threadReadState(r.unreadForAdmin) === 'unread').length;
}

// ── reply readiness ───────────────────────────────────────────────────────

/**
 * The server's `MAX_MESSAGE_BODY` (mytribe/functions/src/lib/conversations.ts),
 * mirrored so the client can name the limit before the callable rejects it.
 * Kept as a named constant rather than an inline 5000 so the two sides are
 * greppable together if the server ever moves it.
 */
export const MAX_REPLY_BODY = 5000;

/**
 * Why a reply cannot be sent yet, or `null` when it can. Ported verbatim in
 * behaviour from the archive's `Conversations.kt#replyBlocker`, the one pure
 * chat-side rule the React port dropped.
 *
 * The length check matters because `replyToConversation`'s zod schema caps
 * `body` at `MAX_MESSAGE_BODY`, and a rejection there surfaces as
 * "replyToConversation validation failed", which tells the operator nothing
 * about a long message. Checking the RAW length (not the trimmed one) is what
 * the server does, so the two agree on the boundary case exactly.
 */
export function replyBlocker(body: string): string | null {
  if (body.trim() === '') return 'Write a reply first.';
  if (body.length > MAX_REPLY_BODY) {
    return `Message is too long (${MAX_REPLY_BODY} character max).`;
  }
  return null;
}

// ── last-sender classification (positive enumeration, unknown bucket) ─────

/**
 * Every sender role a thread's `lastSenderRole` can honestly report. Mirrors
 * the two real values `appendMessage` ever writes (`'kinfolk'` | `'auntie'`,
 * see `lib/conversations.ts`'s `SenderRole`), plus `'unknown'` for a thread
 * summary doc predating that field, or any value that doesn't match either
 * literal, an HONEST label instead of silently guessing one side (the
 * sessionFormat.ts `sessionState` / AO-12 convention: every branch is a
 * positive match against the literal text, never "not the other one, so must
 * be X").
 */
export type ThreadSender = 'kinfolk' | 'auntie' | 'unknown';

export function threadSender(lastSenderRole: string): ThreadSender {
  switch ((lastSenderRole ?? '').trim().toLowerCase()) {
    case 'kinfolk':
      return 'kinfolk';
    case 'auntie':
      return 'auntie';
    default:
      return 'unknown';
  }
}

// ── defensive field reads ──────────────────────────────────────────────────
//
// The callable response is server-validated on the way out (every field on
// `listConversationsHandler` is already `typeof`-checked with a default), but
// this module treats it as untrusted wire JSON anyway: a stale cached
// function revision, a future field rename, or a hand-rolled test fixture
// missing a key must never blank the whole row. Same shape as the
// `doc.foo?.trim() ?? ''` / `doc.count ?? 0` convention used for raw Firestore
// reads elsewhere in this port.

/** Household display name: the real `kinfolkName`, else the id (never blank). */
export function threadHouseholdName(
  kinfolkName: string | null | undefined,
  kinfolkId: string,
): string {
  const name = (kinfolkName ?? '').trim();
  return name === '' ? kinfolkId : name;
}

/** Last-message preview text, defensively trimmed. */
export function threadPreviewText(lastMessagePreview: string | null | undefined): string {
  return (lastMessagePreview ?? '').trim();
}

/** Message count, defensively defaulted to 0 for a missing/non-finite value. */
export function threadMessageCount(messageCount: number | null | undefined): number {
  return typeof messageCount === 'number' && Number.isFinite(messageCount) ? messageCount : 0;
}

// ── day grouping ─────────────────────────────────────────────────────────

/** One local calendar day's worth of thread rows, newest-first within the day. */
export interface ThreadDayGroup<T> {
  dayKeyValue: string;
  rows: T[];
}

/**
 * Groups thread rows by LOCAL day (via `threadDayKey`, the AO-18 fix) and
 * orders both the rows within a day AND the day groups themselves NEWEST
 * FIRST, with `'Undated'` always last.
 *
 * This is the deliberate inverse of sessionFormat.ts's `groupSessionsByDay`,
 * which sorts ascending: sessions are a SCHEDULE (today, then what's coming
 * up), while an inbox is an ACTIVITY FEED (what came in most recently, on
 * top), the same newest-first convention Notifications.tsx's `NOTIFICATIONS_QUERY`
 * uses. It also matches `listConversationsHandler`'s own in-memory sort
 * (`lastMessageAtMs` descending), so a thread's position here agrees with the
 * order the backend already computed, rather than silently re-deriving a
 * different one.
 */
export function groupThreadsByDay<T extends { lastMessageAtMs: number }>(
  rows: T[],
): ThreadDayGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = threadDayKey(row.lastMessageAtMs);
    const existing = map.get(key);
    if (existing) existing.push(row);
    else map.set(key, [row]);
  }
  const groups = Array.from(map.entries()).map(([dayKeyValue, groupRows]) => ({
    dayKeyValue,
    rows: [...groupRows].sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs),
  }));
  groups.sort((a, b) => {
    if (a.dayKeyValue === 'Undated') return b.dayKeyValue === 'Undated' ? 0 : 1;
    if (b.dayKeyValue === 'Undated') return -1;
    return a.dayKeyValue < b.dayKeyValue ? 1 : a.dayKeyValue > b.dayKeyValue ? -1 : 0;
  });
  return groups;
}

// ── status grouping (who is waiting) ─────────────────────────────────────

/** One waiting/answered section of the thread list. */
export interface ThreadSection<T> {
  key: 'waiting' | 'answered';
  label: string;
  threads: T[];
}

/**
 * The two sections in the order they are worked: threads WAITING on a reply
 * first, then the ones already answered.
 *
 * WHY BOTH SECTIONS ALWAYS COME BACK, empty or not. An operator opening the
 * Inbox is asking "is anyone waiting on me". A missing "Waiting on a reply"
 * header answers nothing: it looks the same as a list that has not finished
 * grouping. An empty one, with the screen's "Nothing is waiting on a reply"
 * line under it, answers the question outright.
 *
 * This WRAPS `groupThreadsByDay`, it does not replace it: the screen runs the
 * day grouping inside each section, so the AO-18 local-day fix still decides
 * every date header. Nothing here reads a timestamp at all, which is why the
 * ordering within a section is left entirely to that function.
 *
 * The split delegates to `threadReadState`, the same enumerated classifier the
 * "N unread" badge (`unreadThreadCount`) and the Unread filter chip use, so the
 * three surfaces can never disagree about one row. `unreadForAdmin` is a
 * STORED BOOLEAN (`api/inbox.ts`), never a count.
 */
export function groupThreadsByWaiting<T extends { unreadForAdmin: boolean }>(
  threads: readonly T[],
): ThreadSection<T>[] {
  const waiting: T[] = [];
  const answered: T[] = [];
  for (const t of threads) {
    if (threadReadState(t.unreadForAdmin) === 'unread') waiting.push(t);
    else answered.push(t);
  }
  return [
    { key: 'waiting', label: 'Waiting on a reply', threads: waiting },
    { key: 'answered', label: 'Answered', threads: answered },
  ];
}

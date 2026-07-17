import type { Timestamp } from 'firebase/firestore';
import { dayKey, formatWhen, machineWhen, type FsTime } from './time';
import { sessionDayLabel, localDateIso } from './sessionFormat';

/**
 * Pure Communicate "Recent" (sent-message history) classification + display
 * helpers, kept out of the screen so the mapping logic has direct vitest
 * coverage (the inboxFormat.ts / sessionFormat.ts convention).
 *
 * Source of truth: `listRecentSends` (MyTribe/functions/src/admin/
 * listRecentSends.ts, confirmed live), admin-gated (wrapAdminCallable),
 * reading `external_messages` ordered `sentAtMs desc`, capped 30 server-side.
 * That collection has NO client Firestore read rule (grepped MyTribe/
 * firestore.rules: no `external_messages` match anywhere, and the file
 * explicitly warns against a catch-all that would silently open one), so this
 * is the read path, not a `useCollection` listener. Mirrors the wasm
 * `RecentSend`/`SendCounts` (screens/communicate/RecentSends.kt's
 * `decodeRecentSends`) field-for-field; re-declared in `api/communicate.ts`.
 *
 * ── THE AO-18 FIX, adapted to THIS field's shape ──────────────────────────
 * `sentAtMs` is a plain epoch-ms NUMBER (stamped by the SendGrid/Twilio send
 * path when the external_messages doc is written), not a Firestore Timestamp
 * and not a free-text ISO string. Same shape as `conversations.
 * lastMessageAtMs` (inboxFormat.ts's `threadTimeOf`), so `sendTimeOf` below
 * wraps it in the identical fake-Timestamp `{ toDate: () => Date }` and flows
 * it through `lib/time.ts`'s LOCAL (`getFullYear`/`getMonth`/`getDate`/
 * `getHours`/`getMinutes`) helpers, never a raw
 * `new Date(ms).toISOString().slice(0, 10)` (that would group an 8pm-CDT send
 * under the UTC next calendar day and show the UTC hour, five hours off from
 * when it actually went out).
 */

// ── epoch-ms -> local day/time (the AO-18 fix, this field's shape) ─────────

/**
 * Wraps a `listRecentSends` row's `sentAtMs` epoch-ms number as a fake
 * Firestore `Timestamp` so it can flow through `lib/time.ts`'s LOCAL
 * `dayKey`/`formatWhen` unchanged. `null` for a non-finite / non-positive /
 * unparseable value, same "degrade honestly, never fabricate a date"
 * contract `lib/time.ts` and inboxFormat.ts already use for missing input.
 */
export function sendTimeOf(ms: number): FsTime {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/** LOCAL `YYYY-MM-DD` day-grouping key for a send's `sentAtMs`, or `'Undated'`. */
export function sendDayKey(ms: number): string {
  return dayKey(sendTimeOf(ms));
}

/**
 * LOCAL `HH:mm` clock time for a send's `sentAtMs`. Reuses `formatWhen`'s
 * `MM-DD HH:mm` in full and takes only the time half (`.slice(6)`), matching
 * inboxFormat.ts's `threadClock`: the row's day group header already carries
 * the day, so repeating it per-row would be noise, not a second AO-18 check.
 */
export function sendClock(ms: number): string {
  const full = formatWhen(sendTimeOf(ms));
  return full === '(no time)' ? full : full.slice(6);
}

/** Machine-readable local datetime for a row's `<time dateTime={…}>` attribute. */
export function sendMachineTime(ms: number): string | undefined {
  return machineWhen(sendTimeOf(ms));
}

export { sessionDayLabel as sendDayLabel, localDateIso };

// ── channel classification (positive enumeration, unknown bucket) ─────────

/**
 * Every channel `listRecentSends` can honestly report. Mirrors the two real
 * values `sendExternalMessage` ever writes (`'email'` | `'sms'`), plus
 * `'unknown'` for anything else, an HONEST label instead of silently folding
 * a future/renamed channel into email or sms (the sessionFormat.ts
 * `sessionState` / AO-12 convention: every branch is a positive match against
 * the literal text, never "not the other one, so must be X").
 */
export type SendChannel = 'email' | 'sms' | 'unknown';

export function sendChannelOf(channel: string): SendChannel {
  switch (channel.trim().toLowerCase()) {
    case 'email':
      return 'email';
    case 'sms':
      return 'sms';
    default:
      return 'unknown';
  }
}

/** Display label for a channel wire value. Ports the wasm `channelLabel`. */
export function channelLabel(channel: string): string {
  switch (sendChannelOf(channel)) {
    case 'email':
      return 'Email';
    case 'sms':
      return 'Text';
    case 'unknown':
      return channel.trim() === '' ? 'Send' : channel.trim();
  }
}

// ── engagement-state classification (positive enumeration, no negation) ────

/**
 * Every engagement state one send can be in, from its `counts`. Ordered by
 * severity/informativeness (a failed or bounced send is the thing an
 * operator most needs to see; a merely-delivered send with no further event
 * is the least informative "yes it went out" state), not by write order, so
 * `sendState` picks the single most useful bucket rather than the first
 * truthy count it happens to check. `'awaiting'` is the honest "no engagement
 * event has landed yet" state: never fabricated as delivered/opened when the
 * webhook simply hasn't fired.
 */
export type SendState = 'failed' | 'bounced' | 'clicked' | 'opened' | 'delivered' | 'awaiting';

/**
 * Classifies a send's engagement state from its counts. `clicked` is only
 * considered for email (mirrors the wasm `engagementSummary`'s
 * channel.equals("email", ignoreCase = true) gate: Twilio's SMS webhooks
 * report delivery status, not link clicks, so a `counts.clicked` on an sms
 * row would be a decode artifact, never a real signal to surface).
 */
export function sendStateOf(counts: SendCounts, channel: string): SendState {
  if (counts.failed > 0) return 'failed';
  if (counts.bounced > 0) return 'bounced';
  if (sendChannelOf(channel) === 'email' && counts.clicked > 0) return 'clicked';
  if (counts.opened > 0) return 'opened';
  if (counts.delivered > 0) return 'delivered';
  return 'awaiting';
}

export interface SendStateInfo {
  label: string;
  /**
   * A `DenTone` value (DenScreenKit.tsx / DenScreenKit.css's `[data-tone]`
   * resolution table), not an invented colour class. Reusing that shared
   * vocabulary means this pill's colour comes from the same one theme source
   * as every stat card and chip in the app, rather than a second copy of
   * "which token is teal" living in this screen's CSS.
   */
  tone: 'muted' | 'teal' | 'orange' | 'success' | 'warning' | 'error';
}

/** Friendly label + DenTone per state. Pure 1:1 map. */
export function sendStateInfo(state: SendState): SendStateInfo {
  switch (state) {
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'bounced':
      return { label: 'Bounced', tone: 'warning' };
    case 'clicked':
      return { label: 'Clicked', tone: 'success' };
    case 'opened':
      return { label: 'Opened', tone: 'orange' };
    case 'delivered':
      return { label: 'Delivered', tone: 'teal' };
    case 'awaiting':
      return { label: 'Sent', tone: 'muted' };
  }
}

/**
 * Honest one-line engagement summary: shows only what the providers actually
 * reported (click is email-only). Never fabricates a rate that hasn't been
 * measured. Ports the wasm `engagementSummary` verbatim.
 */
export function engagementSummary(channel: string, counts: SendCounts): string {
  const parts: string[] = [];
  if (counts.delivered > 0) parts.push(`${counts.delivered} delivered`);
  if (counts.opened > 0) parts.push(`${counts.opened} opened`);
  if (sendChannelOf(channel) === 'email' && counts.clicked > 0) parts.push(`${counts.clicked} clicked`);
  if (counts.bounced > 0) parts.push(`${counts.bounced} bounced`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.length === 0 ? 'Sent · awaiting delivery events' : parts.join(' · ');
}

// ── defensive field reads ──────────────────────────────────────────────────
//
// The callable response is server-validated on the way out (every field on
// `listRecentSendsHandler` is already `typeof`-checked with a default), but
// this module treats it as untrusted wire JSON anyway: a stale cached
// function revision, a future field rename, or a hand-rolled test fixture
// missing a key must never blank or throw on a row. Same shape as the
// `doc.foo?.trim() ?? ''` / `doc.count ?? 0` convention used elsewhere.

export interface SendCounts {
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
}

/** Defaults every counter to 0 for a missing/malformed counts object. */
export function sendCountsOf(counts: Partial<SendCounts> | null | undefined): SendCounts {
  const c = counts ?? {};
  const field = (n: number | null | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  return {
    delivered: field(c.delivered),
    opened: field(c.opened),
    clicked: field(c.clicked),
    bounced: field(c.bounced),
    failed: field(c.failed),
  };
}

/** Subject line, defensively trimmed. Blank/absent subject is honest (many sms sends have none). */
export function sendSubject(subject: string | null | undefined): string {
  return (subject ?? '').trim();
}

/** Redacted recipient display text, never blank (falls back to an honest placeholder). */
export function sendRecipient(recipientRedacted: string | null | undefined): string {
  const r = (recipientRedacted ?? '').trim();
  return r === '' ? '(recipient not on file)' : r;
}

// ── day grouping ─────────────────────────────────────────────────────────

/** One local calendar day's worth of send rows, newest-first within the day. */
export interface SendDayGroup<T> {
  dayKeyValue: string;
  rows: T[];
}

/**
 * Groups send rows by LOCAL day (via `sendDayKey`, the AO-18 fix) and orders
 * both the rows within a day AND the day groups themselves NEWEST FIRST, with
 * `'Undated'` always last. This is a sent-history ACTIVITY FEED (what went
 * out most recently, on top), the same newest-first convention
 * `groupThreadsByDay`/Notifications.tsx use, and matches
 * `listRecentSendsHandler`'s own Firestore-level `orderBy('sentAtMs', 'desc')`,
 * so a row's position here agrees with the order the backend already
 * computed rather than silently re-deriving a different one.
 */
export function groupSendsByDay<T extends { sentAtMs: number }>(rows: T[]): SendDayGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = sendDayKey(row.sentAtMs);
    const existing = map.get(key);
    if (existing) existing.push(row);
    else map.set(key, [row]);
  }
  const groups = Array.from(map.entries()).map(([dayKeyValue, groupRows]) => ({
    dayKeyValue,
    rows: [...groupRows].sort((a, b) => b.sentAtMs - a.sentAtMs),
  }));
  groups.sort((a, b) => {
    if (a.dayKeyValue === 'Undated') return b.dayKeyValue === 'Undated' ? 0 : 1;
    if (b.dayKeyValue === 'Undated') return -1;
    return a.dayKeyValue < b.dayKeyValue ? 1 : a.dayKeyValue > b.dayKeyValue ? -1 : 0;
  });
  return groups;
}

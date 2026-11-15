import { useSyncExternalStore } from 'react';

/**
 * #1833: the bell's unread count, kept live.
 *
 * The badge used to ride `getMyHome.unreadNotifications`, a number read when
 * the portal opened and cached for five minutes, so a notice that arrived
 * afterwards was listed (the list is read fresh when the bell is opened) and
 * never counted until a reload. The count now comes from one Firestore
 * listener on the signed-in person's own `notifications` rows
 * (lib/unreadNotificationsListener.ts, opened once by
 * components/UnreadNotificationsBridge.tsx), and this file is the store the
 * header reads it from. No Firebase import here, so every screen test that
 * renders the header stays free of it.
 *
 * ONE OWNER FOR THE NUMBER. The count is derived, never stored: the unread
 * rows in the latest snapshot, minus the rows tapped in this browser whose
 * read has not come back from the server yet. Nothing decrements a number, so
 * a tap cannot be counted twice when its snapshot lands, and a slow
 * `markNotificationRead` does not hold the badge back.
 *
 * THE PREDICATES ARE THE SERVER'S (functions/src/lib/recipientNotifications.ts):
 * archived means `archivedAt` carries a value (or `withdrawnAt` does: a notice
 * the office took back, #2038), unread means `readAt` does not,
 * and a row naming another household (`data.kinfolkId`, or the older
 * `data.familyId`) belongs to that tribe's bell. A row that names none is
 * counted under every tribe. The same case table is tested on the server, here
 * and in the Android app.
 */

/** The newest rows the count looks at. Same number as the server's UNREAD_SCAN_CAP. */
export const UNREAD_SCAN_CAP = 100;

/** What the count needs from one `notifications/{id}` row, and nothing else. */
export interface BadgeRow {
  id: string;
  unread: boolean;
  /** Filed away by the reader, or withdrawn by the office. Either way it is not counted. */
  archived: boolean;
  /** The household the row names, '' when it names none. */
  tribeId: string;
  /**
   * #2329: when the row was issued (`createdAt`, epoch ms), null when it
   * carries none. The office putting a notice back on the list (a real
   * arrival after an undone one, lib/arrivalNoticeWithdrawal.ts) stamps it
   * again, which is how a tap on the earlier issue is told apart from it.
   */
  issuedAtMs?: number | null;
}

function idOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** A Firestore Timestamp, or a plain number of ms, as epoch ms; null for anything else. */
function msOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && v !== null && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
export function badgeRowFromDoc(id: string, data: Record<string, unknown>): BadgeRow {
  const bag = data['data'];
  const named =
    typeof bag === 'object' && bag !== null
      ? idOf((bag as Record<string, unknown>)['kinfolkId']) || idOf((bag as Record<string, unknown>)['familyId'])
      : '';
  return {
    id,
    unread: data['readAt'] === undefined || data['readAt'] === null,
    archived:
      (data['archivedAt'] !== undefined && data['archivedAt'] !== null) ||
      // #2038: a notice the office took back ("Undo arrived"). It never counts,
      // whatever its archive stamp reads.
      (data['withdrawnAt'] !== undefined && data['withdrawnAt'] !== null),
    tribeId: named,
    issuedAtMs: msOf(data['createdAt']),
  };
}

/** Unread, not archived, about this tribe (or about none), and not already tapped here. */
export function countUnreadRows(rows: readonly BadgeRow[], kinfolkId: string, locallyRead: ReadonlySet<string>): number {
  let count = 0;
  for (const row of rows) {
    if (!row.unread || row.archived) continue;
    if (row.tribeId !== '' && row.tribeId !== kinfolkId) continue;
    if (locallyRead.has(row.id)) continue;
    count += 1;
  }
  return count;
}

type Feed = { kind: 'waiting' } | { kind: 'live'; rows: readonly BadgeRow[] } | { kind: 'error' };
/**
 * A row tapped in this browser whose read has not shown up in a snapshot yet.
 * `issuedAtMs` is the row's issue as the feed held it at the tap (undefined
 * when the feed did not hold the row yet: the first snapshot that does fills
 * it in). `answered` is set once `markNotificationRead` has come back.
 */
interface Tap {
  issuedAtMs: number | null | undefined;
  answered: boolean;
}
let feed: Feed = { kind: 'waiting' };
let taps: ReadonlyMap<string, Tap> = new Map();
/** #2329: a snapshot has come from the server at least once since sign-in. */
let serverAnswered = false;
let version = 0;
const listeners = new Set<() => void>();
function changed(): void {
  version += 1;
  for (const l of listeners) l();
}
function tappedIds(): ReadonlySet<string> {
  return new Set(taps.keys());
}
/**
 * A snapshot arrived. Answers whether it was taken.
 *
 * A TAP IS LET GO when the snapshot shows its read (the row reads as read, or
 * is gone), and also (#2329) when the row still reads unread but cannot be
 * waiting on the tap any more: the office has issued it again since
 * (`issuedAtMs` moved), or `markNotificationRead` had already come back
 * before this snapshot. Without those two the office marking a tapped notice
 * unread before the read reached this browser left the tap subtracting until
 * a reload.
 *
 * #2329: A SNAPSHOT FROM THE BROWSER'S CACHE BEFORE THE SERVER HAS ANSWERED
 * ONCE IS NOT TAKEN. The portal keeps no Firestore cache across loads, so on
 * an offline start that snapshot is empty, and taking it drew a confident 0
 * over the count the portal opened with. Once the server has answered, a
 * cached snapshot (the connection dropped) holds what the server last said
 * and is taken as usual.
 */
export function setLiveRows(rows: readonly BadgeRow[], opts: { fromCache?: boolean } = {}): boolean {
  if (opts.fromCache === true && !serverAnswered) return false;
  if (opts.fromCache !== true) serverAnswered = true;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kept = new Map<string, Tap>();
  for (const [id, tap] of taps) {
    const row = byId.get(id);
    if (row === undefined || !row.unread || tap.answered) continue;
    const issued = row.issuedAtMs ?? null;
    if (tap.issuedAtMs === undefined) kept.set(id, { ...tap, issuedAtMs: issued });
    else if (tap.issuedAtMs === issued) kept.set(id, tap);
  }
  taps = kept;
  feed = { kind: 'live', rows };
  changed();
  return true;
}
/** The listener failed. The bell draws no badge from here on; see PortalNav. */
export function setUnreadFeedFailed(): void {
  feed = { kind: 'error' };
  changed();
}
/** Signed out, or a different person signed in: nothing of the last session is kept. */
export function resetUnreadBadge(): void {
  feed = { kind: 'waiting' };
  taps = new Map();
  serverAnswered = false;
  changed();
}
/** A row was tapped: it stops counting at once, ahead of the server's answer. */
export function markReadLocally(id: string): void {
  if (taps.has(id)) return;
  const row = feed.kind === 'live' ? feed.rows.find((r) => r.id === id) : undefined;
  taps = new Map([...taps, [id, { issuedAtMs: row === undefined ? undefined : (row.issuedAtMs ?? null), answered: false }]]);
  changed();
}
/**
 * #2329: the server took the read. The row keeps not counting until the next
 * snapshot, which carries the read (or, if the office marked it unread again
 * in between, carries that, and the row counts again).
 */
export function confirmLocalRead(id: string): void {
  const tap = taps.get(id);
  if (tap === undefined || tap.answered) return;
  taps = new Map([...taps, [id, { ...tap, answered: true }]]);
}
/** The read was refused: the row counts again, which is the truth. */
export function undoLocalRead(id: string): void {
  if (!taps.has(id)) return;
  taps = new Map([...taps].filter(([x]) => x !== id));
  changed();
}
/**
 * What the bell knows right now.
 * - `waiting`: no snapshot yet (or no tribe to count for): the header shows
 *   the count `getMyHome` loaded with.
 * - `live`: the count, current.
 * - `error`: the listener failed; the header shows no badge instead of an old number.
 */
export type LiveUnread = { kind: 'waiting' } | { kind: 'live'; count: number } | { kind: 'error' };

export function liveUnreadOf(kinfolkId: string | undefined): LiveUnread {
  if (feed.kind === 'error') return { kind: 'error' };
  if (feed.kind === 'waiting' || !kinfolkId) return { kind: 'waiting' };
  return { kind: 'live', count: countUnreadRows(feed.rows, kinfolkId, tappedIds()) };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read for the header. The listener itself is owned by UnreadNotificationsBridge. */
export function useLiveUnread(kinfolkId: string | undefined): LiveUnread {
  useSyncExternalStore(subscribe, () => version);
  return liveUnreadOf(kinfolkId);
}

/**
 * The number the bell draws: the live count once there is one, the count the
 * portal opened with until then, and nothing after a failed listener.
 */
export function bellCount(live: LiveUnread, seeded: number | null | undefined): number | undefined {
  if (live.kind === 'live') return live.count;
  if (live.kind === 'error') return undefined;
  return seeded ?? undefined;
}

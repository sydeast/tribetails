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
 * archived means `archivedAt` carries a value, unread means `readAt` does not,
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
  archived: boolean;
  /** The household the row names, '' when it names none. */
  tribeId: string;
}

function idOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
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
    archived: data['archivedAt'] !== undefined && data['archivedAt'] !== null,
    tribeId: named,
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

let feed: Feed = { kind: 'waiting' };
let locallyRead: ReadonlySet<string> = new Set();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

/** A snapshot arrived. Taps the server has now answered (the row reads as read, or is gone) are forgotten. */
export function setLiveRows(rows: readonly BadgeRow[]): void {
  const stillUnread = new Set(rows.filter((r) => r.unread).map((r) => r.id));
  locallyRead = new Set([...locallyRead].filter((id) => stillUnread.has(id)));
  feed = { kind: 'live', rows };
  changed();
}

/** The listener failed. The bell draws no badge from here on; see PortalNav. */
export function setUnreadFeedFailed(): void {
  feed = { kind: 'error' };
  changed();
}

/** Signed out, or a different person signed in: nothing of the last session is kept. */
export function resetUnreadBadge(): void {
  feed = { kind: 'waiting' };
  locallyRead = new Set();
  changed();
}

/** A row was tapped: it stops counting at once, ahead of the server's answer. */
export function markReadLocally(id: string): void {
  if (locallyRead.has(id)) return;
  locallyRead = new Set([...locallyRead, id]);
  changed();
}

/** The read was refused: the row counts again, which is the truth. */
export function undoLocalRead(id: string): void {
  if (!locallyRead.has(id)) return;
  locallyRead = new Set([...locallyRead].filter((x) => x !== id));
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
  return { kind: 'live', count: countUnreadRows(feed.rows, kinfolkId, locallyRead) };
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

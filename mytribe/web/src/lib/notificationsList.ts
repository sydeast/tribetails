import type { InfiniteData } from '@tanstack/react-query';
import type { ListMyNotificationsResult, NotificationItemDto } from '../api/notificationsApi';

/**
 * #1316: the pure rules behind the bell and the notifications list. No React
 * and no network, so each is a plain node spec (notificationsList.test.ts),
 * and the screen stays a thin renderer.
 */

/**
 * What the bell draws for an unread count: nothing at 0 (or for a count the
 * server never sent), the number up to 99, then "99+". The same cap as the
 * portal Android app's BellButton.
 */
export function unreadBadgeLabel(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/**
 * The bell's accessible name. The badge is drawn `aria-hidden` (the link's
 * `aria-label` would override its text anyway), so the count has to be in the
 * name itself or a screen reader never hears it: "Notifications" at 0,
 * "Notifications, 3 unread" above. The exact count, not the 99+ cap, since a
 * spoken number has no room to run out of. Android's BellButton says the same.
 */
export function bellAccessibleName(count: number | null | undefined): string {
  return unreadBadgeLabel(count) === null ? 'Notifications' : `Notifications, ${Math.floor(count as number)} unread`;
}

/** Where a tapped row goes. `none` stays on the list, read but not opened. */
export type NotificationTarget =
  | { kind: 'visit'; visitId: string }
  | { kind: 'schedule' }
  | { kind: 'invoice'; invoiceId: string }
  | { kind: 'tale'; taleId: string }
  /** #1898: comments across several tales open the KinTales list. */
  | { kind: 'tales' }
  /** #1913: a notice about one Kin opens it; one about a Kin no longer listed opens the Kin list. */
  | { kind: 'kin'; kinId: string }
  | { kind: 'kinList' }
  /** The household's own profile, on Tribe. */
  | { kind: 'household' }
  /** #1874: a reply from the office opens Messages. */
  | { kind: 'messages' }
  | { kind: 'none' };

/**
 * The thing a row is about, read off the row's `targetType`. The server
 * (`householdNoticeTarget`) decides it per key, old rows included: `kin` for a
 * Kin notice (an empty id is a Kin no longer listed), `household` for the
 * profile, and `kintale` with no id for comments across several tales.
 *
 * A booking row's `targetId` is a VISIT for per-visit events and a BATCH for
 * whole-request events (the request itself, its approval, a decline), and the
 * id alone cannot say which. So the visit is opened only when the row carries
 * `visitId`; a row about a whole request, or one carrying no id this client
 * can place, lands on Schedule rather than on a visit page that says "not
 * found".
 */
export function notificationTarget(
  item: Pick<NotificationItemDto, 'targetType' | 'targetId' | 'visitId' | 'batchId'>,
): NotificationTarget {
  const id = (item.targetId ?? '').trim();
  switch (item.targetType) {
    case 'booking': {
      const visitId = (item.visitId ?? '').trim();
      return visitId ? { kind: 'visit', visitId } : { kind: 'schedule' };
    }
    case 'invoice':
      return id ? { kind: 'invoice', invoiceId: id } : { kind: 'none' };
    case 'kintale':
      return id ? { kind: 'tale', taleId: id } : { kind: 'tales' };
    case 'kin':
      return id ? { kind: 'kin', kinId: id } : { kind: 'kinList' };
    case 'household':
      return { kind: 'household' };
    case 'conversation':
      return { kind: 'messages' };
    default:
      return { kind: 'none' };
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a row happened, the short way: "Just now", "5m ago", "3h ago", "2d ago",
 * then "Mar 14" (with the year once it is not this year). The same shape as
 * the portal Android app's `relativeTime`. A row with no readable time shows
 * no time rather than a wrong one.
 */
export function notificationWhen(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ms);
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

/**
 * The optimistic half of a tap: the row reads as read at once and the first
 * page's `unreadCount` drops by one, without waiting on `markNotificationRead`.
 * Returns the same object when nothing changed (the row was already read, or
 * is not in the cache), so React Query skips a pointless re-render.
 */
export function markReadInPages(
  data: InfiniteData<ListMyNotificationsResult>,
  id: string,
  readAt: string,
): InfiniteData<ListMyNotificationsResult> {
  let changed = false;
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== id || item.readAt !== null) return item;
      changed = true;
      return { ...item, readAt };
    }),
  }));
  if (!changed) return data;
  return {
    ...data,
    pages: pages.map((page, i) => (i === 0 ? { ...page, unreadCount: Math.max(0, page.unreadCount - 1) } : page)),
  };
}
/**
 * #2030: the office's own words to the household on this notice (the note it
 * wrote when it booked or turned down their request), or null when it wrote
 * none. The dispatcher puts it on the card as `detail.householdNote` for the
 * answer keys only; any other shape reads as none.
 */
export function householdNoteOf(item: Pick<NotificationItemDto, 'detail'>): string | null {
  const raw = item.detail?.['householdNote'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

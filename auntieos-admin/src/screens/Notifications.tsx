import { useEffect, useState } from 'react';
import {
  NOTIFICATIONS_QUERY,
  markNotificationRead,
  markNotificationUnread,
  bulkMarkNotificationsRead,
  isRead,
  formatWhen,
  dayKey,
  machineWhen,
  type NotificationEntry,
} from '../api/notifications';
import { useCollection } from '../lib/firestore';
import { arr } from '../lib/coerce';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';

/** Groups rows by `dayKey`, preserving the stream's own (server) order within each day. */
/** Archived notifications never reappear in the feed (wasm activeNotifications). */
function activeNotifications(rows: NotificationEntry[]): NotificationEntry[] {
  return rows.filter((r) => r.archivedAt === undefined);
}

function byDay(rows: NotificationEntry[]): [string, NotificationEntry[]][] {
  const groups = new Map<string, NotificationEntry[]>();
  for (const r of rows) {
    const day = dayKey(r.createdAt);
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(r);
  }
  return [...groups.entries()];
}

/**
 * Admin Notifications inbox ("The Den · Notifications"). Streams the
 * `notifications` collection through the bounded, server-ordered listener
 * (createdAt desc, capped 200, see NOTIFICATIONS_QUERY for why no
 * recipientUid filter is applied), and wires the two mark-read callables:
 * markNotificationRead/markNotificationUnread per row, bulkMarkNotificationsRead
 * for a multi-selected batch.
 *
 * Deliberately NOT locally-optimistic about a row's read/unread state: the
 * wasm original (NotificationsScreen.kt onToggleRead) doesn't patch
 * NotificationEntry client-side either, it fires the callable and lets the
 * live Firestore listener re-render the truth once the write lands, which is
 * effectively instant on a `useCollection` subscription. What IS optimistic
 * here is button state, disabled the instant a call is in flight, and the
 * bulk selection, which clears immediately on a successful batch write.
 */
export function Notifications() {
  const rows = useCollection<NotificationEntry>(NOTIFICATIONS_QUERY);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Drop any selected id that has left the live list (e.g. it scrolled out of
  // the 200-row cap), so the bulk bar's count never lies about what's selected.
  useEffect(() => {
    if (rows.status !== 'ready') return;
    const live = new Set(rows.data.map((r) => r._id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  async function toggleOne(entry: NotificationEntry) {
    if (pendingIds.has(entry._id)) return;
    setPendingIds((prev) => new Set(prev).add(entry._id));
    setActionError(null);
    try {
      if (isRead(entry)) {
        await markNotificationUnread(entry._id);
      } else {
        await markNotificationRead(entry._id);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Marking the notification failed.');
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(entry._id);
        return next;
      });
    }
  }

  async function markSelectedRead() {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setActionError(null);
    try {
      const marked = await bulkMarkNotificationsRead(ids);
      setSelectedIds(new Set());
      if (marked < ids.length) {
        setActionError(
          `Marked ${marked} of ${ids.length}, the rest were already read or not yours to mark.`,
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Marking notifications read failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Only claimed once the stream has actually resolved, never a fabricated
  // 0 while loading/erroring (the StatCard / AsyncRegion policy this app
  // follows throughout; see lib/async.ts).
  const unreadCount = rows.status === 'ready' ? rows.data.filter((r) => !isRead(r)).length : 0;

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Notifications"
        title="Notifications"
        subtitle="Business-side notifications dispatched to your account."
        trailing={unreadCount > 0 ? <span className="notif-badge">{unreadCount} unread</span> : undefined}
      />

      {actionError ? (
        <Banner tone="error" title="Notification action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Banner>
      ) : null}

      {selectedIds.size > 0 ? (
        <div className="notif-bulkbar">
          <span className="notif-bulkbar__count">{selectedIds.size} selected</span>
          <GhostButton label="Clear" onClick={() => setSelectedIds(new Set())} disabled={bulkBusy} />
          <PrimaryButton
            label="Mark selected read"
            onClick={() => void markSelectedRead()}
            busy={bulkBusy}
          />
        </div>
      ) : null}

      <DenPanel title="Activity" subtitle="Catalog-dispatched events for your account, newest first.">
        <AsyncRegion
          state={rows}
          what="notifications"
          isEmpty={(data) => data.length === 0}
          loading={<p className="notif-hint">Loading notifications…</p>}
          empty={
            <p className="notif-hint">
              No notifications yet. Catalog-dispatched events appear here when MyTribe functions emit them.
            </p>
          }
        >
          {(data) => (
            <div className="notif-feed">
              {byDay(activeNotifications(data)).map(([day, group]) => (
                <section key={day} className="notif-day">
                  <h3 className="notif-day__label">{day}</h3>
                  <ul className="notif-rows">
                    {group.map((entry) => {
                      const read = isRead(entry);
                      const busy = pendingIds.has(entry._id);
                      // `channels` is absent on rows dispatched before it was
                      // written; `.length` on undefined would blank the page.
                      const channels = arr<string>(entry.channels);
                      return (
                        <li
                          key={entry._id}
                          className={read ? 'notif-row' : 'notif-row notif-row--unread'}
                        >
                          <input
                            type="checkbox"
                            className="notif-row__select"
                            aria-label={`Select ${entry.key || 'notification'}`}
                            checked={selectedIds.has(entry._id)}
                            onChange={(e) => toggleSelected(entry._id, e.target.checked)}
                          />
                          <div className="notif-row__body">
                            {/* AO-28: prefer the human title (catalog label); fall
                                back to the raw key for pre-AO-28 rows. */}
                            <span className="notif-row__key">{entry.title || entry.key || '(no key)'}</span>
                            {entry.description ? (
                              <span className="notif-row__desc">{entry.description}</span>
                            ) : null}
                            <span className="notif-row__meta">
                              {entry.actorName ? `${entry.actorName} · ` : ''}
                              {entry.category || 'uncategorized'} · {entry.mode || 'trigger'}
                            </span>
                            {channels.length > 0 ? (
                              <span className="notif-row__channels">
                                channels: {channels.join(', ')}
                              </span>
                            ) : null}
                            <span
                              className={`notif-row__status notif-row__status--${(entry.status || 'unknown').toLowerCase()}`}
                            >
                              {entry.status || 'unknown'}
                            </span>
                          </div>
                          <div className="notif-row__side">
                            <time className="notif-row__time" dateTime={machineWhen(entry.createdAt)}>
                              {formatWhen(entry.createdAt)}
                            </time>
                            <GhostButton
                              label={read ? 'Mark unread' : 'Mark read'}
                              onClick={() => void toggleOne(entry)}
                              disabled={busy}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

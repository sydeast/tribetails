import { useMemo, useState } from 'react';
import {
  NOTIFICATIONS_QUERY,
  markNotificationRead,
  markNotificationUnread,
  isRead,
  formatWhen,
  machineWhen,
  type NotificationEntry,
} from '../api/notifications';
import { archiveNotification, bulkArchiveNotifications } from '../api/notificationsWrite';
import { batchUpdateBookings, type BatchBookingAction } from '../api/bookingsWrite';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { useCollection } from '../lib/firestore';
import {
  NOTIF_UNREAD_FILTER,
  activeNotifications,
  notificationCategories,
  notificationsByDay,
  notificationsForFilter,
  unreadNotificationCount,
} from '../lib/notificationsFeed';
import { notificationKinfolkName, notificationTargetLabel } from '../lib/notificationContext';
import { type NotificationRoute } from '../lib/notificationActions';
import { useBulkMarkRead } from '../lib/useBulkMarkRead';
import { arr, str } from '../lib/coerce';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { NotificationQuickActions } from '../components/NotificationQuickActions';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';

export interface NotificationsProps {
  /**
   * Performs a navigation the feed asked for. Supplied by `router.tsx`; absent
   * when the screen is rendered standalone, in which case the Open / Create
   * quote buttons still render (their targets are real) but go nowhere.
   *
   * The screen deliberately does NOT call `useNavigate` itself. Which route a
   * notification opens is a decision with a routing table and tests
   * (lib/notificationActions.ts); performing the navigation is the router's
   * job. Keeping them apart is what lets the table be unit-tested and the
   * screen be rendered without a router, the same split `Directory`'s
   * `onSelectKinfolk` already uses.
   */
  onNavigate?: (route: NotificationRoute) => void;
}

/**
 * Admin Notifications inbox ("The Den · Notifications").
 *
 * WHY THIS IS NOT THE ACTIVITY LOG (operator issue #20). Both screens read an
 * append-only stream of events, and until now both RENDERED like one: a key, a
 * category, a timestamp. That is correct for `ActivityLog.tsx`, whose austerity
 * is the point, it is a tamper-evident, hash-chained audit trail and its rows
 * are evidence. It is wrong here. A notification is not evidence, it is a piece
 * of WORK: it concerns a household, it points at an invoice or a booking or a
 * KinTale, and the operator should be able to act on it without first going to
 * find out what it was about. So this feed carries the context the docs already
 * hold (household, catalog title and description, actor, linked entity) and a
 * quick-action bar that does the obvious next thing. The Activity Log is
 * untouched.
 *
 * TWO LISTENERS. The feed itself (`NOTIFICATIONS_QUERY`, createdAt desc, capped
 * 200) plus the `kinfolk` directory (`KINFOLK_QUERY`), because notification docs
 * carry a household ID and almost never a household NAME (see
 * lib/notificationContext.ts for the full accounting of what the dispatcher
 * actually writes). The directory is already streamed by Directory and
 * InvoiceCreate; resolving names against it is how the row gets to say "Dana
 * Ruiz" instead of "k_7fJ2". An unresolvable id renders no name at all rather
 * than a placeholder.
 *
 * STILL DELIBERATELY NON-OPTIMISTIC about read state, and now about archive
 * too. The wasm original (NotificationsScreen.kt) does not patch
 * NotificationEntry client-side either: it fires the callable and lets the live
 * Firestore listener re-render the truth, which is effectively instant on a
 * `useCollection` subscription. Preserved rather than "improved" into optimism,
 * because an optimistically-removed row that the server refused to archive is a
 * lie the operator cannot see. What IS immediate: button disabling while a call
 * is in flight, and the bulk selection clearing on a successful batch.
 *
 * Every action fails loud. That includes the two ways these callables report
 * refusal WITHOUT throwing: `archiveNotification` resolving `archived: 0` (the
 * doc was missing, or not the caller's), and `batchUpdateBookings` resolving
 * with a populated `failed[]`. Both surface in the error banner.
 */
export function Notifications({ onNavigate }: NotificationsProps = {}) {
  const rows = useCollection<NotificationEntry>(NOTIFICATIONS_QUERY);
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);

  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string | null>(null);
  const [bulkArchiving, setBulkArchiving] = useState(false);

  // Selection + bulk mark-read, shared verbatim with the Inbox's Notifications
  // digest (lib/useBulkMarkRead.ts): the prune-on-stream-change, the
  // keep-the-selection-on-failure, and the partial-batch report all live there
  // so the two surfaces cannot drift apart.
  const bulk = useBulkMarkRead(rows);
  const { selectedIds, error: actionError, setError: setActionError } = bulk;

  /**
   * Household id to display name. Only REAL names go in: `kinfolkDisplayName`
   * answers "Unnamed Kinfolk" for a doc with neither name, and putting that in
   * the map would print a placeholder on a notification row that would
   * otherwise honestly print nothing.
   */
  const namesById = useMemo(() => {
    const map = new Map<string, string>();
    if (households.status !== 'ready') return map;
    for (const kf of households.data) {
      if (str(kf.firstName).trim() === '' && str(kf.lastName).trim() === '') continue;
      map.set(kf._id, kinfolkDisplayName(kf));
    }
    return map;
  }, [households]);

  /** Runs one row-scoped write with fail-loud reporting and per-row busy state. */
  async function runRowAction(
    id: string,
    action: () => Promise<string | null>,
    fallbackMessage: string,
  ) {
    if (pendingIds.has(id)) return;
    setPendingIds((prev) => new Set(prev).add(id));
    setActionError(null);
    try {
      const refusal = await action();
      if (refusal !== null) setActionError(refusal);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : fallbackMessage);
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function toggleOne(entry: NotificationEntry) {
    void runRowAction(
      entry._id,
      async () => {
        if (isRead(entry)) await markNotificationUnread(entry._id);
        else await markNotificationRead(entry._id);
        return null;
      },
      'Marking the notification failed.',
    );
  }

  function archiveOne(entry: NotificationEntry) {
    void runRowAction(
      entry._id,
      async () => {
        const archived = await archiveNotification(entry._id);
        // A resolved 0 means the server declined: the doc is gone, has no
        // recipientUid, or belongs to someone else. The row is still on screen,
        // so saying nothing would read as success.
        return archived > 0 ? null : 'Nothing was archived. The notification may already be gone.';
      },
      'Archiving the notification failed.',
    );
  }

  function bookingAction(entry: NotificationEntry, bookingId: string, action: BatchBookingAction) {
    void runRowAction(
      entry._id,
      async () => {
        const result = await batchUpdateBookings([bookingId], action);
        if (result.failed.length > 0) {
          return `Booking ${action === 'APPROVE' ? 'approval' : 'denial'} failed: ${result.failed
            .map((f) => f.error)
            .join('; ')}`;
        }
        if (result.updated === 0) {
          return `No booking was ${action === 'APPROVE' ? 'approved' : 'denied'}.`;
        }
        return null;
      },
      'Updating the booking failed.',
    );
  }

  async function archiveSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkArchiving) return;
    setBulkArchiving(true);
    setActionError(null);
    try {
      const archived = await bulkArchiveNotifications(ids);
      bulk.clear();
      if (archived < ids.length) {
        setActionError(
          `Archived ${archived} of ${ids.length}, the rest were already gone or not yours to archive.`,
        );
      }
    } catch (err) {
      // Selection survives a failure so the operator can retry, matching the
      // mark-read half in lib/useBulkMarkRead.ts.
      setActionError(err instanceof Error ? err.message : 'Archiving notifications failed.');
    } finally {
      setBulkArchiving(false);
    }
  }

  // Only claimed once the stream has actually resolved, never a fabricated
  // 0 while loading/erroring (the StatCard / AsyncRegion policy this app
  // follows throughout; see lib/async.ts).
  const unreadCount = rows.status === 'ready' ? unreadNotificationCount(rows.data) : 0;

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Notifications"
        title="Notifications"
        subtitle="Events that need you, and the household each one is about. Activity Log keeps the audit trail."
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
          <GhostButton label="Clear" onClick={bulk.clear} disabled={bulk.busy || bulkArchiving} />
          <GhostButton
            label="Archive selected"
            onClick={() => void archiveSelected()}
            disabled={bulk.busy || bulkArchiving}
          />
          <PrimaryButton
            label="Mark selected read"
            onClick={() => void bulk.markSelectedRead()}
            busy={bulk.busy}
            disabled={bulkArchiving}
          />
        </div>
      ) : null}

      {/* Not titled "Activity" any more: that word is precisely what made this
          feed read as a second Activity Log. */}
      <DenPanel
        title="Recent notifications"
        subtitle="Catalog-dispatched events for your account, newest first."
      >
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
          {(data) => {
            const active = activeNotifications(data);
            const categories = notificationCategories(active);
            const visible = notificationsForFilter(active, filter);

            return (
              <>
                <div className="notif-filters" role="group" aria-label="Filter notifications">
                  <FilterChip label="All" active={filter === null} onSelect={() => setFilter(null)} />
                  <FilterChip
                    label="Unread"
                    active={filter === NOTIF_UNREAD_FILTER}
                    onSelect={() => setFilter(NOTIF_UNREAD_FILTER)}
                  />
                  {categories.map((category) => (
                    <FilterChip
                      key={category}
                      label={category}
                      active={filter === category}
                      onSelect={() => setFilter(category)}
                    />
                  ))}
                </div>

                {visible.length === 0 ? (
                  <p className="notif-hint">Nothing in this filter.</p>
                ) : (
                  <div className="notif-feed">
                    {notificationsByDay(visible).map(([day, group]) => (
                      <section key={day} className="notif-day">
                        <h3 className="notif-day__label">{day}</h3>
                        <ul className="notif-rows">
                          {group.map((entry) => (
                            <NotificationRow
                              key={entry._id}
                              entry={entry}
                              householdName={notificationKinfolkName(entry, namesById)}
                              selected={selectedIds.has(entry._id)}
                              busy={pendingIds.has(entry._id)}
                              onToggleSelect={(checked) => bulk.toggle(entry._id, checked)}
                              onToggleRead={() => toggleOne(entry)}
                              onArchive={() => archiveOne(entry)}
                              onBookingAction={(bookingId, action) =>
                                bookingAction(entry, bookingId, action)
                              }
                              {...(onNavigate ? { onNavigate } : {})}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

interface FilterChipProps {
  label: string;
  active: boolean;
  onSelect: () => void;
}

function FilterChip({ label, active, onSelect }: FilterChipProps) {
  return (
    <button
      type="button"
      className={active ? 'notif-chip notif-chip--active' : 'notif-chip'}
      aria-pressed={active}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

interface NotificationRowProps {
  entry: NotificationEntry;
  /** Resolved household name, or '' when none could be identified. */
  householdName: string;
  selected: boolean;
  busy: boolean;
  onToggleSelect: (checked: boolean) => void;
  onToggleRead: () => void;
  onArchive: () => void;
  onNavigate?: (route: NotificationRoute) => void;
  onBookingAction: (bookingId: string, action: BatchBookingAction) => void;
}

function NotificationRow({
  entry,
  householdName,
  selected,
  busy,
  onToggleSelect,
  onToggleRead,
  onArchive,
  onNavigate,
  onBookingAction,
}: NotificationRowProps) {
  const read = isRead(entry);
  // `channels` is absent on rows dispatched before it was written; `.length` on
  // undefined would blank the page.
  const channels = arr<string>(entry.channels);
  const targetLabel = notificationTargetLabel(entry);
  // AO-28: prefer the human title (catalog label); fall back to the raw key for
  // pre-AO-28 rows.
  const title = entry.title || entry.key || '(no key)';

  return (
    <li className={read ? 'notif-row' : 'notif-row notif-row--unread'}>
      <input
        type="checkbox"
        className="notif-row__select"
        aria-label={`Select ${entry.key || 'notification'}`}
        checked={selected}
        onChange={(e) => onToggleSelect(e.target.checked)}
      />
      <div className="notif-row__body">
        {householdName !== '' || targetLabel !== '' ? (
          <span className="notif-row__context">
            {householdName !== '' ? <span className="notif-row__who">{householdName}</span> : null}
            {targetLabel !== '' ? <span className="notif-row__target">{targetLabel}</span> : null}
          </span>
        ) : null}

        <span className="notif-row__key">{title}</span>
        {entry.description ? <span className="notif-row__desc">{entry.description}</span> : null}

        <span className="notif-row__meta">
          {entry.actorName ? `${entry.actorName} · ` : ''}
          {entry.category || 'uncategorized'} · {entry.mode || 'trigger'}
        </span>

        {channels.length > 0 ? (
          <span className="notif-row__channels">channels: {channels.join(', ')}</span>
        ) : null}

        <span
          className={`notif-row__status notif-row__status--${(entry.status || 'unknown').toLowerCase()}`}
        >
          {entry.status || 'unknown'}
        </span>

        <NotificationQuickActions
          entry={entry}
          read={read}
          busy={busy}
          onToggleRead={onToggleRead}
          onArchive={onArchive}
          onNavigate={(route) => onNavigate?.(route)}
          onBookingAction={onBookingAction}
        />
      </div>
      <div className="notif-row__side">
        <time className="notif-row__time" dateTime={machineWhen(entry.createdAt)}>
          {formatWhen(entry.createdAt)}
        </time>
      </div>
    </li>
  );
}

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
import {
  archiveNotification,
  bulkArchiveNotifications,
  unarchiveNotification,
  bulkUnarchiveNotifications,
} from '../api/notificationsWrite';
import { batchUpdateBookings, type BatchBookingAction } from '../api/bookingsWrite';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { useCollection } from '../lib/firestore';
import {
  NOTIF_UNREAD_FILTER,
  actionableNotificationCount,
  isNotificationArchived,
  notificationCategories,
  notificationsByDay,
  notificationsForArchived,
  notificationsForFilter,
  unreadAmong,
  unreadNotificationCount,
  type NotificationArchivedMode,
} from '../lib/notificationsFeed';
import { notificationKinfolkName, notificationTargetLabel } from '../lib/notificationContext';
import {
  hasNotificationDetail,
  notificationDetailRows,
  notificationDetailSummary,
} from '../lib/notificationDetail';
import { type NotificationRoute } from '../lib/notificationActions';
import { useBulkMarkRead } from '../lib/useBulkMarkRead';
import { useRovingTabs } from '../lib/useRovingTabs';
import { asyncScalar } from '../lib/async';
import { str } from '../lib/coerce';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { LoadingRow } from '../components/LoadingRow';
import {
  NotificationQuickActions,
  type NotificationPendingKind,
} from '../components/NotificationQuickActions';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';

/** A row with no write in flight gets this, rather than a fresh empty Set each render. */
const NO_PENDING: ReadonlySet<NotificationPendingKind> = new Set();

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
 * WHY THIS IS NOT THE ACTIVITY LOG (operator issue #20, and then ruling R5).
 * Both screens read an append-only stream of events, and both once RENDERED
 * like one: a key, a category, a timestamp. That is correct for
 * `ActivityLog.tsx`, whose austerity is the point, it is a tamper-evident,
 * hash-chained audit trail and its rows are evidence. It is wrong here. A
 * notification is not evidence, it is a piece of WORK: it concerns a household,
 * it points at an invoice or a booking or a KinTale, and the operator should be
 * able to act on it without first going to find out what it was about.
 *
 * Issue #20 added the household and the catalog title. R5 (2026-08-03) finished
 * the job, because half of it was still wrong in both directions:
 *
 *   1. WORKFLOW WAS STILL ON THE CARD. The row printed the delivery mode
 *      ("bookings · trigger"), the transports ("channels: email, sms") and a
 *      dispatch-status pill, and the stat strip counted "Dispatched". Verbatim:
 *      "there are many Activity Log records and workflow (Channels, trigger,
 *      and dispatched are activity log not notification) in Notifications."
 *      Every one of those is gone from here. The state lives on
 *      `notificationDispatch/{id}` and the RECORD of it is written to
 *      `activity_log` (NOTIFICATION_DISPATCHED / NOTIFICATION_RECEIVED), so the
 *      Activity Log gained exactly what this screen lost.
 *
 *   2. THE ENTITY DETAIL WAS MISSING. Verbatim: "I see the A KinCare visit was
 *      assigned and the CTAs for the workflow but I do not see the
 *      KinCare/Booking details. Who requested, For which kinfolk, what date,
 *      what time, wheres the notes." Those five are now resolved server-side at
 *      dispatch and stamped on the doc as `detail`; the row summarises them
 *      inline and OPENS to the full block (see NotificationRow).
 *
 * WHY AN EXPANSION AND NOT A DETAIL ROUTE. There is no notification-detail
 * mockup in `ui-ideas/`, and CLAUDE.md is explicit that a screen with no live
 * mockup does not get one invented. What the mockups DO carry is a directive in
 * a filename, `auntieos-manage-bookings-2026-05-27-cardsShouldOpenDisplayingFullerDetails.html`,
 * and per CLAUDE.md a filename directive is part of the spec: cards should
 * OPEN DISPLAYING FULLER DETAILS. An in-place disclosure is the literal reading
 * of that, and it is also the better one here: triage means comparing rows, and
 * a route would throw the feed away to show one. The entities themselves keep
 * their own screens, which is what the Open button is for.
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
 *
 * ARCHIVE IS NO LONGER A ONE-WAY DOOR (2026-08-01). Until now `archivedAt` could
 * only be stamped: nothing cleared it and this feed hid the row outright, so a
 * notification filed away by mistake was unreachable from every surface in the
 * product. The archive FACET below (Hidden / Included / Only archived) mirrors
 * the Invoices screen's three states exactly, and Restore calls the new
 * `unarchiveNotification`. The facet is deliberately not a fourth filter chip:
 * the chips answer "which category", and an archived booking notification is
 * still a booking notification, so folding the two axes together would make
 * them falsely exclusive.
 *
 * THE STAT STRIP is `StatCard` (DenScreenKit), read through `asyncScalar` so a
 * failed listener renders a dash and the reason rather than a confident zero,
 * which is the whole point of that component's signature. All three counts are
 * taken over the rows the facet has left IN SCOPE, so switching to "Only
 * archived" re-describes the strip instead of leaving it describing a different
 * list than the one on screen.
 */
export function Notifications({ onNavigate }: NotificationsProps = {}) {
  const rows = useCollection<NotificationEntry>(NOTIFICATIONS_QUERY);
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);

  // Issue #707: WAS a Set<string>, so any write for a row disabled all six of
  // its buttons for however long that ONE call took (10s+ for
  // markNotificationRead). A Map of Sets remembers WHICH write(s) are running,
  // so only the buttons that write the same thing show as pending. A Set, not
  // a single value, because the read write and the archive write touch
  // different fields and can genuinely overlap (mark read, then archive,
  // before the first call resolves); collapsing that to one value per row
  // would make the guard below drop the second write's own pending state and
  // let its button fire again while the first is still in flight.
  const [pendingActions, setPendingActions] = useState<Map<string, Set<NotificationPendingKind>>>(new Map());
  const [filter, setFilter] = useState<string | null>(null);
  const [archived, setArchived] = useState<NotificationArchivedMode>('hide');
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

  /** Runs one row-scoped write with fail-loud reporting and per-row, per-kind pending state. */
  async function runRowAction(
    id: string,
    kind: NotificationPendingKind,
    action: () => Promise<string | null>,
    fallbackMessage: string,
  ) {
    // Guarded by (id, kind), not just id: two DIFFERENT kinds for the same row
    // are allowed to run at once (see the state comment above), and only a
    // second click of the SAME kind while it is already running is refused.
    if (pendingActions.get(id)?.has(kind)) return;
    setPendingActions((prev) => {
      const next = new Map(prev);
      next.set(id, new Set(next.get(id)).add(kind));
      return next;
    });
    setActionError(null);
    try {
      const refusal = await action();
      if (refusal !== null) setActionError(refusal);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : fallbackMessage);
    } finally {
      setPendingActions((prev) => {
        const next = new Map(prev);
        const remaining = new Set(next.get(id));
        remaining.delete(kind);
        if (remaining.size === 0) next.delete(id);
        else next.set(id, remaining);
        return next;
      });
    }
  }

  function toggleOne(entry: NotificationEntry) {
    void runRowAction(
      entry._id,
      'read',
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
      'archive',
      async () => {
        const count = await archiveNotification(entry._id);
        // A resolved 0 means the server declined: the doc is gone, has no
        // recipientUid, or belongs to someone else. The row is still on screen,
        // so saying nothing would read as success.
        return count > 0 ? null : 'Nothing was archived. The notification may already be gone.';
      },
      'Archiving the notification failed.',
    );
  }

  /** The undo. Same skip-not-throw contract as archive, so a 0 is reported too. */
  function restoreOne(entry: NotificationEntry) {
    void runRowAction(
      entry._id,
      'archive',
      async () => {
        const count = await unarchiveNotification(entry._id);
        return count > 0 ? null : 'Nothing was restored. The notification may already be gone.';
      },
      'Restoring the notification failed.',
    );
  }

  function bookingAction(entry: NotificationEntry, bookingId: string, action: BatchBookingAction) {
    void runRowAction(
      entry._id,
      'booking',
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

  /**
   * The two bulk archive directions, sharing one body because they differ only
   * in which callable runs and how the partial result reads. Written as one
   * function rather than two so a fix to the partial-batch reporting cannot land
   * on only half of it.
   */
  async function archiveSelected(direction: 'archive' | 'restore') {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkArchiving) return;
    setBulkArchiving(true);
    setActionError(null);
    try {
      const done =
        direction === 'archive'
          ? await bulkArchiveNotifications(ids)
          : await bulkUnarchiveNotifications(ids);
      bulk.clear();
      if (done < ids.length) {
        setActionError(
          direction === 'archive'
            ? `Archived ${done} of ${ids.length}, the rest were already gone or not yours to archive.`
            : `Restored ${done} of ${ids.length}, the rest were already gone or not yours to restore.`,
        );
      }
    } catch (err) {
      // Selection survives a failure so the operator can retry, matching the
      // mark-read half in lib/useBulkMarkRead.ts.
      setActionError(
        err instanceof Error
          ? err.message
          : direction === 'archive'
            ? 'Archiving notifications failed.'
            : 'Restoring notifications failed.',
      );
    } finally {
      setBulkArchiving(false);
    }
  }

  /**
   * The rows this screen is ABOUT, after the archive facet. Everything below is
   * projected off this one list: the stat strip, the category chips, the bulk
   * bar's select-all set and the feed itself. Projecting the strip off the full
   * stream instead would leave it describing rows the operator cannot see.
   */
  const inScope = useMemo(
    () => (rows.status === 'ready' ? notificationsForArchived(rows.data, archived) : []),
    [rows, archived],
  );
  const showingArchived = archived === 'only';

  // Read through asyncScalar, so a permission-denied or failed listener renders
  // a dash and the reason rather than a confident zero. That signature is the
  // whole reason StatCard exists; see the note on it in DenScreenKit.tsx.
  const totalCount = asyncScalar(rows, () => inScope.length);
  const unreadStat = asyncScalar(rows, () => unreadNotificationCount(inScope));
  const actionableStat = asyncScalar(rows, () => actionableNotificationCount(inScope));

  // The heading badge. Only claimed once the stream has actually resolved, never
  // a fabricated 0 while loading/erroring (the StatCard / AsyncRegion policy
  // this app follows throughout; see lib/async.ts). Deliberately counted over
  // the ACTIVE feed rather than `inScope`, because it is a standing "how much is
  // waiting for you" figure and must not change when the facet does.
  const unreadCount = rows.status === 'ready' ? unreadNotificationCount(rows.data) : 0;

  // What the bulk buttons will actually SEND, which is not the selection.
  // `bulkMarkNotificationsRead` skips rows that are already read and reports how
  // many it really marked, so sending five ids of which three are read comes
  // back as "Marked 2 of 5" for a batch in which nothing failed. Narrowing here
  // makes the label, the request and any partial report the same number.
  const unreadSelected = useMemo(() => unreadAmong(inScope, selectedIds), [inScope, selectedIds]);
  const allInScopeIds = useMemo(() => inScope.map((r) => r._id), [inScope]);
  const allSelected = allInScopeIds.length > 0 && selectedIds.size >= allInScopeIds.length;

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

      {/* The Den stat vocabulary, on the screen that was the last list without
          it. Counts come through asyncScalar, so a failed listener shows a dash
          and the reason instead of three confident zeros. */}
      <div className="notif-summary">
        <StatCard
          label={showingArchived ? 'Filed away' : 'In your inbox'}
          value={totalCount}
          trend={showingArchived ? 'archived notifications' : 'active notifications'}
          tone="purple"
        />
        <StatCard
          label="Unread"
          value={unreadStat}
          trend="not opened yet"
          tone={unreadStat.kind === 'value' && unreadStat.value > 0 ? 'warning' : 'muted'}
          feature={unreadStat.kind === 'value' && unreadStat.value > 0}
        />
        {/* WAS "Dispatched", counting rows the SENDER had gotten out of the
            door. That is the delivery pipeline's health, on a screen about the
            operator's workload, and it is the tile operator ruling R5 named
            outright. What is here instead answers the question the strip should
            answer: how many of these are waiting on a decision from you. It is
            derived from the same `applicableNotificationActions` that decides
            which rows get Approve/Deny buttons, so the number and the buttons
            can never disagree. */}
        <StatCard
          label="Needs a decision"
          value={actionableStat}
          trend="approve or deny"
          tone={actionableStat.kind === 'value' && actionableStat.value > 0 ? 'warning' : 'muted'}
        />
      </div>

      {selectedIds.size > 0 ? (
        <div className="notif-bulkbar">
          <span className="notif-bulkbar__count">{selectedIds.size} selected</span>
          <GhostButton label="Clear" onClick={bulk.clear} disabled={bulk.busy || bulkArchiving} />
          {/* Counted, like Android's, and counted with the number that will
              actually be SENT rather than the number selected. A button reading
              "Mark 2 read" over a selection of 5 is the honest version of a
              server that skips the three already-read rows. */}
          <PrimaryButton
            label={`Mark ${String(unreadSelected.length)} read`}
            onClick={() => void bulk.markSelectedRead(unreadSelected)}
            busy={bulk.busy}
            disabled={bulkArchiving || unreadSelected.length === 0}
          />
          {showingArchived ? (
            <GhostButton
              label={`Restore ${String(selectedIds.size)}`}
              onClick={() => void archiveSelected('restore')}
              disabled={bulk.busy || bulkArchiving}
            />
          ) : (
            <GhostButton
              label={`Archive ${String(selectedIds.size)}`}
              onClick={() => void archiveSelected('archive')}
              disabled={bulk.busy || bulkArchiving}
            />
          )}
        </div>
      ) : null}

      {/* Not titled "Activity" any more: that word is precisely what made this
          feed read as a second Activity Log. */}
      <DenPanel
        title={showingArchived ? 'Archived notifications' : 'Recent notifications'}
        subtitle="Catalog-dispatched events for your account, newest first."
        trailing={
          <label className="notif-facet">
            <span className="notif-facet__label">Archived</span>
            <select
              className="notif-facet__select"
              value={archived}
              onChange={(e) => {
                // The selection is cleared on a facet change on purpose. The
                // bulk bar's Archive/Restore button is chosen by the FACET, so
                // carrying a selection across the switch would let an operator
                // press Restore on rows they picked while looking at the active
                // feed.
                bulk.clear();
                setArchived(e.target.value as NotificationArchivedMode);
              }}
            >
              <option value="hide">Hidden</option>
              <option value="include">Included</option>
              <option value="only">Only archived</option>
            </select>
          </label>
        }
      >
        <AsyncRegion
          state={rows}
          what="notifications"
          isEmpty={(data) => data.length === 0}
          loading={<LoadingRow label="Loading notifications…" className="den-hint" />}
          empty={
            <EmptyHint>
              No notifications yet. Catalog-dispatched events appear here when MyTribe functions emit them.
            </EmptyHint>
          }
        >
          {() => {
            const categories = notificationCategories(inScope);
            const visible = notificationsForFilter(inScope, filter);

            return (
              <>
                <NotificationFilters
                  categories={categories}
                  filter={filter}
                  onFilter={setFilter}
                />

                {allInScopeIds.length > 0 ? (
                  <div className="notif-selectall">
                    <GhostButton
                      // Over the rows the FACET has left in scope, never over
                      // the whole stream: a select-all that reaches rows the
                      // operator cannot see is how a bulk archive takes out
                      // something nobody looked at.
                      label={allSelected ? 'Clear selection' : `Select all ${String(allInScopeIds.length)}`}
                      onClick={() => (allSelected ? bulk.clear() : bulk.selectAll(allInScopeIds))}
                      disabled={bulk.busy || bulkArchiving}
                    />
                  </div>
                ) : null}

                {visible.length === 0 ? (
                  <EmptyHint>
                    {archived === 'only'
                      ? 'Nothing archived matches this filter.'
                      : filter === null
                        ? 'Every notification here is archived. Switch the Archived facet to see them.'
                        : 'Nothing in this filter.'}
                  </EmptyHint>
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
                              pending={pendingActions.get(entry._id) ?? NO_PENDING}
                              onToggleSelect={(checked) => bulk.toggle(entry._id, checked)}
                              onToggleRead={() => toggleOne(entry)}
                              onArchive={() => archiveOne(entry)}
                              onRestore={() => restoreOne(entry)}
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

interface NotificationFiltersProps {
  /** Categories actually present in the feed, already sorted. */
  categories: readonly string[];
  filter: string | null;
  onFilter: (filter: string | null) => void;
}

/**
 * All / Unread / one chip per real category, as a ROVING TABLIST.
 *
 * It was a `role="group"` of `aria-pressed` toggle buttons, and it was the one
 * filter row in this admin that was. ListToolbar's own note lists the eleven
 * screens whose chip rows are `tablist` + `useRovingTabs` (Invoices, Bookings,
 * Sessions, KinTales, Communicate, Inbox, TribalIntel, NotificationGate,
 * Directory, Templates, settings) and says outright that a second convention for
 * the same visual control is worse than either convention alone. This was that
 * second convention: same appearance, different keyboard contract, arrow keys
 * doing nothing where they move between chips everywhere else.
 *
 * The chips themselves are unchanged, and still derived from the categories the
 * dispatcher really emitted rather than from an invented taxonomy.
 */
function NotificationFilters({ categories, filter, onFilter }: NotificationFiltersProps) {
  // Value per tab, in render order, so the roving index and the chips cannot
  // drift as categories come and go from the live stream.
  const values: (string | null)[] = [null, NOTIF_UNREAD_FILTER, ...categories];
  const activeIndex = Math.max(
    0,
    values.findIndex((v) => v === filter),
  );
  const { getTabProps } = useRovingTabs({ count: values.length, activeIndex });

  return (
    <div className="notif-filters" role="tablist" aria-label="Filter notifications">
      {values.map((value, index) => (
        <button
          key={value ?? '\0all'}
          type="button"
          role="tab"
          aria-selected={filter === value}
          className={filter === value ? 'notif-chip notif-chip--active' : 'notif-chip'}
          onClick={() => onFilter(value)}
          {...getTabProps(index)}
        >
          {value === null ? 'All' : value === NOTIF_UNREAD_FILTER ? 'Unread' : value}
        </button>
      ))}
    </div>
  );
}

interface NotificationRowProps {
  entry: NotificationEntry;
  /** Resolved household name, or '' when none could be identified. */
  householdName: string;
  selected: boolean;
  /** The kinds of write in flight for this row (may be more than one). */
  pending: ReadonlySet<NotificationPendingKind>;
  onToggleSelect: (checked: boolean) => void;
  onToggleRead: () => void;
  onArchive: () => void;
  /** The undo. Offered instead of Archive on a row that is already archived. */
  onRestore: () => void;
  onNavigate?: (route: NotificationRoute) => void;
  onBookingAction: (bookingId: string, action: BatchBookingAction) => void;
}

function NotificationRow({
  entry,
  householdName,
  selected,
  pending,
  onToggleSelect,
  onToggleRead,
  onArchive,
  onRestore,
  onNavigate,
  onBookingAction,
}: NotificationRowProps) {
  const read = isRead(entry);
  // Visible only under the "Included" / "Only archived" facet, where the row
  // would otherwise be indistinguishable from an active one while offering a
  // different action. Android's Invoices list has exactly this hole and its own
  // comment names it.
  const archived = isNotificationArchived(entry);
  const targetLabel = notificationTargetLabel(entry);
  // AO-28: prefer the human title (catalog label); fall back to the raw key for
  // pre-AO-28 rows.
  const title = entry.title || entry.key || '(no key)';

  // R5: the card opens. Collapsed by default because triage is a scanning task
  // and eight open cards is not a feed; the inline summary below is what makes
  // the collapsed state useful enough to leave collapsed.
  const [open, setOpen] = useState(false);
  const detailRows = notificationDetailRows(entry);
  const canOpen = hasNotificationDetail(entry);
  const summary = notificationDetailSummary(entry);
  const detailId = `notif-detail-${entry._id}`;

  const rowClass = [
    'notif-row',
    // Issue #707: a read row must look read. Unread already carried the accent
    // border; read got nothing of its own, so a read row and an unread row
    // were told apart only by the "Mark unread"/"Mark read" label.
    read ? 'notif-row--read' : 'notif-row--unread',
    archived ? 'notif-row--archived' : null,
    open ? 'notif-row--open' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={rowClass}>
      <input
        type="checkbox"
        className="notif-row__select"
        aria-label={`Select ${entry.key || 'notification'}`}
        checked={selected}
        onChange={(e) => onToggleSelect(e.target.checked)}
      />
      <div
        className={canOpen ? 'notif-row__body notif-row__body--openable' : 'notif-row__body'}
        onClick={canOpen ? () => setOpen((v) => !v) : undefined}
      >
        {householdName !== '' || targetLabel !== '' || archived ? (
          <span className="notif-row__context">
            {householdName !== '' ? <span className="notif-row__who">{householdName}</span> : null}
            {targetLabel !== '' ? <span className="notif-row__target">{targetLabel}</span> : null}
            {archived ? <span className="notif-row__archived">Archived</span> : null}
          </span>
        ) : null}

        {/* ISSUE #705: the whole card body is the disclosure control, not just
            the title, so clicking the summary or description (where an
            operator naturally clicks) opens the card. The button itself carries
            no handler of its own: a click on it bubbles to the body's onClick
            above, and a native <button> dispatches that same bubbling click on
            Enter/Space, so keyboard activation still works without a second
            handler that would fire twice. A row whose server-side `detail`
            resolved nothing renders a plain heading and no control at all: a
            control that opens onto an empty box is worse than no control, the
            same rule `applicableNotificationActions` applies to the Open CTA. */}
        {canOpen ? (
          <button
            type="button"
            className="notif-row__key notif-row__key--button"
            aria-expanded={open}
            aria-controls={detailId}
          >
            {title}
            <span
              aria-hidden="true"
              className={open ? 'notif-row__caret notif-row__caret--open' : 'notif-row__caret'}
            >
              ▸
            </span>
          </button>
        ) : (
          <span className="notif-row__key">{title}</span>
        )}
        {entry.description ? <span className="notif-row__desc">{entry.description}</span> : null}

        {/* Kin · date · time on the collapsed row. The whole complaint was that
            a KinCare notification looked identical to every other KinCare
            notification; these are the three values that tell them apart. */}
        {summary !== '' && !open ? (
          <span className="notif-row__summary">{summary}</span>
        ) : null}

        {open ? (
          <dl className="notif-row__detail" id={detailId}>
            {detailRows.map((row) => (
              <div
                key={row.field}
                className={
                  row.multiline
                    ? 'notif-row__detail-item notif-row__detail-item--block'
                    : 'notif-row__detail-item'
                }
              >
                <dt className="notif-row__detail-label">{row.label}</dt>
                <dd className="notif-row__detail-value">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <span className="notif-row__meta">
          {entry.actorName ? `${entry.actorName} · ` : ''}
          {entry.category || 'uncategorized'}
        </span>

        <NotificationQuickActions
          entry={entry}
          read={read}
          archived={archived}
          pending={pending}
          onToggleRead={onToggleRead}
          onArchive={onArchive}
          onRestore={onRestore}
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

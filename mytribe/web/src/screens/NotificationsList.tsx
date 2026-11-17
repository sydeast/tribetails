import { useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  listMyNotifications,
  markNotificationRead,
  type ListMyNotificationsResult,
  type NotificationItemDto,
} from '../api/notificationsApi';
import type { GetMyHomeResult } from '../api/types';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { fullMessageOf, markReadInPages, notificationTarget, notificationWhen, rowNoteOf } from '../lib/notificationsList';
import { myHomeKey } from '../lib/portalQueryKeys';
import { markReadLocally, undoLocalRead } from '../lib/unreadBadge';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { BusyLabel, LoadingLine } from '../components/Loading';
import { viewOfQuery } from '../lib/queryState';
import '../styles/notificationsList.css';

const PAGE_SIZE = 50;

/**
 * The notifications list behind the header bell (#1316).
 *
 * Until this screen the bell opened Notification SETTINGS, so the one place a
 * household could see what the business had told them (a visit confirmed, an
 * invoice sent, a KinTale posted) did not exist in the portal; the rows had
 * been written to `notifications/{id}` all along. Settings stay where they
 * were, under the avatar menu.
 *
 * Reads `listMyNotifications`, newest first, a page at a time. A tap marks the
 * row read optimistically (the row and the bell count change at once and the
 * server is told; the bell's live count, lib/unreadBadge.ts, then carries the
 * server's number), then opens the thing the row is about: a visit, an
 * invoice, a tale (or KinTales), a Kin (or the Kin list), Tribe, Messages, or
 * Schedule for a row about a whole booking request. A row
 * about nothing openable is only marked read.
 *
 * The list is fetched when this screen opens, and again whenever the bell's
 * listener sees a row arrive or change (#1833), so the rows and the count
 * move together. The nav never fetches it.
 */
export function NotificationsList() {
  const kinfolkId = getActiveKinfolkId();
  const { signOut, signingOut, error: signOutError } = useSignOut();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ['myNotifications', kinfolkId] as const;
  // A tapped push whose line was cut, or whose notice carries the office's
  // note, opens the list at that notice (`/notifications?entry=<id>`): the row
  // is marked, brought into view and given focus, once, when it first shows.
  // An entry that is not among the rows (archived since, or another
  // household's id) marks nothing and the list reads as it always does.
  const { entry } = useSearch({ strict: false }) as { entry?: string };
  const entryRow = useRef<HTMLButtonElement | null>(null);
  const shownEntry = useRef<string | null>(null);

  const list = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      listMyNotifications(kinfolkId, { limit: PAGE_SIZE, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore && last.nextBefore !== null ? last.nextBefore : undefined),
  });

  const items = (list.data?.pages ?? []).flatMap((p) => p.items);
  const entryOnList = entry !== undefined && items.some((i) => i.id === entry);
  useEffect(() => {
    if (!entryOnList || entry === undefined || shownEntry.current === entry) return;
    shownEntry.current = entry;
    entryRow.current?.scrollIntoView?.({ block: 'center' });
    entryRow.current?.focus({ preventScroll: true });
  }, [entryOnList, entry]);

  if (list.isError) {
    return (
      <LaunchError
        onRetry={() => void list.refetch()}
        retrying={list.isRefetching}
        onSignOut={signOut}
        signingOut={signingOut}
        signOutError={signOutError}
      />
    );
  }

  const view = viewOfQuery(list, { isEmpty: (d) => d.pages.every((p) => p.items.length === 0) });

  function open(item: NotificationItemDto) {
    if (item.readAt === null) {
      const readAt = new Date().toISOString();
      queryClient.setQueryData<InfiniteData<ListMyNotificationsResult>>(queryKey, (old) =>
        old ? markReadInPages(old, item.id, readAt) : old,
      );
      // The bell follows at once (#1833): the row stops counting here, ahead
      // of the server, and the live count takes over when the read comes back.
      // A refused read puts the row back on the bell, which is the truth.
      markReadLocally(item.id);
      // The count `getMyHome` loaded with is what the bell shows before its
      // first live snapshot, so it is kept in step too.
      queryClient.setQueryData<GetMyHomeResult>(myHomeKey(kinfolkId), (old) =>
        old ? { ...old, unreadNotifications: Math.max(0, (old.unreadNotifications ?? 0) - 1) } : old,
      );
      void markNotificationRead(item.id)
        .catch(() => undoLocalRead(item.id))
        .then(() => queryClient.invalidateQueries({ queryKey: myHomeKey(kinfolkId) }));
    }
    const target = notificationTarget(item);
    switch (target.kind) {
      case 'visit':
        void navigate({ to: '/schedule/$visitId', params: { visitId: target.visitId } });
        break;
      case 'schedule':
        void navigate({ to: '/schedule' });
        break;
      case 'invoice':
        void navigate({ to: '/invoices/$invoiceId', params: { invoiceId: target.invoiceId } });
        break;
      case 'tale':
        void navigate({ to: '/kintales', search: { tale: target.taleId } });
        break;
      case 'tales':
        void navigate({ to: '/kintales', search: {} });
        break;
      case 'kin':
        void navigate({ to: '/kin/$kinId', params: { kinId: target.kinId } });
        break;
      case 'kinList':
        void navigate({ to: '/kin' });
        break;
      case 'household':
        void navigate({ to: '/tribe' });
        break;
      case 'messages':
        void navigate({ to: '/messages' });
        break;
      case 'none':
        break;
    }
  }

  return (
    <>
      <PortalNav active={null} />

      <div className="wrap">
        <header className="hero-greet">
          <h1>Notifications</h1>
        </header>

        <section className="glass card d1">
          {view.kind === 'offline' ? (
            <OfflineNotice what="your notifications" />
          ) : view.kind !== 'data' && view.kind !== 'empty' ? (
            <LoadingLine what="your notifications" retry={() => void list.refetch()}>
              <span data-testid="notifications-loading">Loading your notifications…</span>
            </LoadingLine>
          ) : view.kind === 'empty' ? (
            <p className="sub" data-testid="notifications-empty">
              No notifications yet.
            </p>
          ) : (
            <ul className="nl-list" data-testid="notifications-list">
              {items.map((item) => {
                const unread = item.readAt === null;
                const opened = item.id === entry;
                const message = fullMessageOf(item);
                const note = rowNoteOf(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      ref={opened ? entryRow : undefined}
                      className={`nl-row${unread ? ' nl-row--unread' : ''}${opened ? ' nl-row--opened' : ''}`}
                      data-unread={unread ? 'true' : 'false'}
                      data-opened={opened ? 'true' : undefined}
                      onClick={() => open(item)}
                    >
                      <span className="nl-row__dot" aria-hidden="true" />
                      <span className="nl-row__body">
                        <span className="nl-row__title">
                          {unread && <span className="nl-visually-hidden">Unread: </span>}
                          {item.title || item.key}
                        </span>
                        {item.description && <span className="nl-row__desc">{item.description}</span>}
                        {/* #2368: the rest of a cut push, drawn as text. */}
                        {message !== null && (
                          <span className="nl-row__message" data-testid="notification-full-message">
                            {message}
                          </span>
                        )}
                        {note !== null && (
                          <span className="nl-row__note" data-testid="notification-household-note">
                            {note}
                          </span>
                        )}
                      </span>
                      <span className="nl-row__when">{notificationWhen(item.createdAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {list.hasNextPage && (
            <button
              className="btn ghost block"
              type="button"
              style={{ marginTop: 16 }}
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? <BusyLabel>Loading…</BusyLabel> : 'Show older'}
            </button>
          )}
        </section>
      </div>
    </>
  );
}

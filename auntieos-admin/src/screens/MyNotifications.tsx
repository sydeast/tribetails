import { useCallback, useEffect, useState } from 'react';
import {
  getNotificationMatrix,
  getMyNotificationPrefs,
  STREAM_BUSINESS,
  STREAM_STAFF,
  type AdminNotificationPrefs,
  type NotificationCatalogEntry,
  type NotificationMatrix,
  type NotifStream,
} from '../api/myNotifications';
import {
  adminChannelForced,
  adminChannelReason,
  adminGateEnabledChannels,
  adminVisibleNotifications,
  channelLabel,
  displayTitle,
  sectionedNotifications,
  userChannelChoice,
} from '../lib/myNotificationsFormat';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { Toggle } from '../components/Toggle';
import './MyNotifications.css';

interface MyNotificationsData {
  matrix: NotificationMatrix;
  prefs: AdminNotificationPrefs;
}

/**
 * My Notifications (contextual: reachable by URL from Account, never pinned
 * in the rail; wasm `myNotifications` / slug `my-notifications`). READ-ONLY
 * port of `MyNotificationsScreen.kt`: the operator's OWN "what reaches me"
 * view, two stacked sections for the two hats they wear, "As the owner"
 * (business stream) and "As the Auntie" (staff stream). Distinct from the
 * admin `Notifications` screen (`api/notifications.ts`), the whole-collection
 * dispatch audit; this screen never touches the `notifications` collection.
 *
 * Both reads are one-shot callables, not a live listener: `getNotificationMatrix`
 * (getBusinessNotificationOverrides -> the SAME catalog + gate matrix the
 * Settings panel uses) and `getMyNotificationPrefs` (getMyAdminNotificationPrefs
 * -> the operator's own `staff/{uid}.notificationPrefs`). See api/myNotifications.ts's
 * header for why neither needs `useCollection` or a composite index: both are
 * onCall callables backed by a single-doc Admin SDK read, not a client Firestore
 * query. Fetched in parallel and folded into one `Async` so `AsyncRegion`
 * arbitrates loading/error/empty exactly once, same shape as Account.tsx and
 * Settings.tsx.
 *
 * Editing (per-channel toggle + save, `saveMyAdminNotificationPrefs`) is the
 * deferred surface. Every `Toggle` below renders `disabled`: a true read view,
 * not a control that looks live and silently no-ops on click.
 */
export function MyNotifications() {
  const [state, setState] = useState<Async<MyNotificationsData>>({ status: 'loading' });

  // Hoisted so a failed load can hand AsyncRegion a real retry (the
  // Account.tsx / Settings.tsx / FeatureFlags.tsx convention).
  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    Promise.all([getNotificationMatrix(), getMyNotificationPrefs()])
      .then(([matrix, prefsResult]) => {
        if (live) setState({ status: 'ready', data: { matrix, prefs: prefsResult.prefs } });
      })
      .catch((err: unknown) => {
        if (live) {
          setState({
            status: 'error',
            message: `Couldn't read your notification settings: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          });
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Account"
        title="What reaches"
        accentTail="you."
        subtitle="Your business decides which channels each notification can use. This is what you actually
        receive within those, and how. Anything your business locked on shows as required."
      />

      <Banner tone="info" dashed pillLabel="Read-only">
        Changing what you receive isn&rsquo;t available here yet. Everything below is exactly what&rsquo;s saved.
      </Banner>

      <AsyncRegion
        state={state}
        what="your notification settings"
        isEmpty={(data) =>
          adminVisibleNotifications(data.matrix, STREAM_BUSINESS).length === 0 &&
          adminVisibleNotifications(data.matrix, STREAM_STAFF).length === 0
        }
        loading={<p className="mynotif__hint">Loading your notification settings…</p>}
        empty={
          <DenPanel title="Your notifications" subtitle="Nothing to set just yet.">
            <p className="mynotif__hint">
              Your business has not enabled any notifications for you yet. Once a channel is turned on in
              Settings, it will show up here.
            </p>
          </DenPanel>
        }
      >
        {({ matrix, prefs }) => (
          <>
            <NotifHatSection
              title="As the owner"
              subtitle="The business side: bookings, invoices, payments, security, ratings."
              matrix={matrix}
              prefs={prefs}
              stream={STREAM_BUSINESS}
            />
            <NotifHatSection
              title="As the Auntie"
              subtitle="The care side: visit notes, KinTale comments, pet updates, your schedule digest."
              matrix={matrix}
              prefs={prefs}
              stream={STREAM_STAFF}
            />
          </>
        )}
      </AsyncRegion>
    </div>
  );
}

interface NotifHatSectionProps {
  title: string;
  subtitle: string;
  matrix: NotificationMatrix;
  prefs: AdminNotificationPrefs;
  stream: NotifStream;
}

/** One hat's panel ("As the owner" / "As the Auntie"), or nothing if it has no visible rows. */
function NotifHatSection({ title, subtitle, matrix, prefs, stream }: NotifHatSectionProps) {
  const rows = adminVisibleNotifications(matrix, stream);
  if (rows.length === 0) return null;
  return (
    <DenPanel title={title} subtitle={subtitle}>
      <div className="mynotif__sections">
        {sectionedNotifications(rows, stream).map(([section, entries]) => (
          <section key={section.title} className="mynotif__section">
            <h3 className="mynotif__section-heading">{section.title.toUpperCase()}</h3>
            <div className="mynotif__rows">
              {entries.map((entry) => (
                <NotifBlock key={entry.key} matrix={matrix} prefs={prefs} entry={entry} stream={stream} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </DenPanel>
  );
}

interface NotifBlockProps {
  matrix: NotificationMatrix;
  prefs: AdminNotificationPrefs;
  entry: NotificationCatalogEntry;
  stream: NotifStream;
}

/** One notification: its title, then a read-only row per gate-enabled channel. */
function NotifBlock({ matrix, prefs, entry, stream }: NotifBlockProps) {
  const channels = adminGateEnabledChannels(matrix, entry, stream);
  const title = displayTitle(entry);
  return (
    <div className="mynotif__block">
      <span className="mynotif__block-title">{title}</span>
      <ul className="mynotif__channels">
        {channels.map((channel) => {
          const forced = adminChannelForced(matrix, entry, stream, channel);
          const on = forced ? true : userChannelChoice(prefs, entry.key, entry.category, channel);
          const label = channelLabel(channel);
          return (
            <li key={channel} className="mynotif__channel-row">
              <div className="mynotif__channel-main">
                <span className="mynotif__channel-label">{label}</span>
                {forced && (
                  <span className="mynotif__channel-reason">{adminChannelReason(matrix, entry, channel)}</span>
                )}
              </div>
              <div className="mynotif__channel-trailing">
                {forced && (
                  <span className="den-pill" data-tone="teal">
                    Required
                  </span>
                )}
                <Toggle
                  checked={on}
                  onChange={() => {}}
                  disabled
                  label={`${title} via ${label}${forced ? ', required' : ''}`}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import {
  getNotificationMatrix,
  getMyNotificationPrefs,
  STREAM_BUSINESS,
  STREAM_STAFF,
  type AdminNotificationPrefs,
  type NotificationCatalogEntry,
  type NotificationChannel,
  type NotificationMatrix,
  type NotifStream,
} from '../api/myNotifications';
import { saveMyAdminNotificationPrefs } from '../api/myNotificationsWrite';
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
import { applyBulkToggle, prefsEqual, setUserChannelChoice } from '../lib/myNotificationsEdit';
import { type Async } from '../lib/async';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import './MyNotifications.css';

interface MyNotificationsData {
  matrix: NotificationMatrix;
  /** The last-saved prefs, the Discard target and the dirty-check baseline. */
  savedPrefs: AdminNotificationPrefs;
}

/**
 * My Notifications, EDITABLE. The write/save surface `MyNotifications.tsx`
 * (read-only) deferred: same two-hat layout ("As the owner" / "As the
 * Auntie"), same gate-matrix read (`getNotificationMatrix`) and own-prefs read
 * (`getMyNotificationPrefs`), but every NON-forced channel's `Toggle` is now
 * live, and a Save bar in the heading commits the draft via
 * `saveMyAdminNotificationPrefs` (api/myNotificationsWrite.ts).
 *
 * A deliberate standalone file rather than an edit-mode flag folded into
 * `MyNotifications.tsx`: the two screens share every read/format helper
 * (`api/myNotifications.ts`, `lib/myNotificationsFormat.ts`) but the read
 * screen's `NotifHatSection` / `NotifBlock` are not exported, and giving them
 * an edit mode would touch a file this task was told to leave read-only. See
 * this repo's hand-off notes for the exact `MyNotifications.tsx` wiring edit
 * that swaps this screen in at the route level.
 *
 * State model: `savedPrefs` (the AsyncRegion payload) is the baseline; `draft`
 * is the operator's in-progress edit, seeded from `savedPrefs` on every
 * successful load. `prefsEqual(draft, savedPrefs)` (order-independent
 * structural equality) drives `dirty`, so Save/Discard enable only on a real
 * change, never merely because the draft is a fresh clone. Save failures keep
 * the draft exactly as the operator left it, fail-loud with a Banner and the
 * Save button re-enabled to retry, not a silent revert (FeatureFlags.tsx's
 * per-flag optimistic revert is right for a single toggle; reverting a whole
 * multi-row draft on one network hiccup would erase everything else the
 * operator had already set).
 */
export function MyNotificationsEdit() {
  const [state, setState] = useState<Async<MyNotificationsData>>({ status: 'loading' });
  const [draft, setDraft] = useState<AdminNotificationPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const load = useCallback(() => {
    let live = true;
    setState({ status: 'loading' });
    setDraft(null);
    setSaveError(null);
    setJustSaved(false);
    Promise.all([getNotificationMatrix(), getMyNotificationPrefs()])
      .then(([matrix, prefsResult]) => {
        if (!live) return;
        setState({ status: 'ready', data: { matrix, savedPrefs: prefsResult.prefs } });
        setDraft(prefsResult.prefs);
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

  const savedPrefs = state.status === 'ready' ? state.data.savedPrefs : null;
  const dirty = draft !== null && savedPrefs !== null && !prefsEqual(draft, savedPrefs);

  function setChannel(key: string, channel: NotificationChannel, next: boolean) {
    setDraft((prev) => (prev ? setUserChannelChoice(prev, key, channel, next) : prev));
    setJustSaved(false);
  }

  // Section select-all: flips every editable channel of the section's visible
  // notifications into the draft in one go. It only stages the draft; the
  // operator still reviews and commits with the single Save below (one write),
  // matching the deliberate no-auto-save model this screen documents.
  function bulkToggle(entries: readonly NotificationCatalogEntry[], stream: NotifStream, on: boolean) {
    const matrix = state.status === 'ready' ? state.data.matrix : null;
    if (!matrix) return;
    setDraft((prev) => (prev ? applyBulkToggle(prev, matrix, entries, stream, on) : prev));
    setJustSaved(false);
  }

  function discard() {
    if (savedPrefs) setDraft(savedPrefs);
    setSaveError(null);
    setJustSaved(false);
  }

  async function save() {
    if (!draft || saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveMyAdminNotificationPrefs(draft);
      setState((prev) =>
        prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, savedPrefs: draft } } : prev,
      );
      setJustSaved(true);
    } catch (err) {
      setSaveError(
        `saveMyAdminNotificationPrefs failed: ${err instanceof Error ? err.message : 'Save failed'}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Account"
        title="What reaches"
        accentTail="you."
        subtitle="Your business decides which channels each notification can use. Choose what you actually
        receive within those, and how. Anything your business locked on stays required."
        trailing={
          <>
            <GhostButton label="Discard" onClick={discard} disabled={!dirty || saving} />
            <PrimaryButton
              label={justSaved ? 'Saved' : saving ? 'Saving…' : 'Save changes'}
              onClick={() => void save()}
              disabled={!dirty || saving}
              busy={saving}
            />
          </>
        }
      />

      {saveError && (
        <Banner tone="error" title="Couldn&rsquo;t save your notification settings">
          {saveError}
        </Banner>
      )}

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
        {({ matrix }) =>
          draft === null ? null : (
            <>
              <NotifHatSection
                title="As the owner"
                subtitle="The business side: bookings, invoices, payments, security, ratings."
                matrix={matrix}
                prefs={draft}
                stream={STREAM_BUSINESS}
                onChannelChange={setChannel}
                onBulkChange={bulkToggle}
              />
              <NotifHatSection
                title="As the Auntie"
                subtitle="The care side: visit notes, KinTale comments, pet updates, your schedule digest."
                matrix={matrix}
                prefs={draft}
                stream={STREAM_STAFF}
                onChannelChange={setChannel}
                onBulkChange={bulkToggle}
              />
            </>
          )
        }
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
  onChannelChange: (key: string, channel: NotificationChannel, next: boolean) => void;
  onBulkChange: (entries: readonly NotificationCatalogEntry[], stream: NotifStream, on: boolean) => void;
}

/** One hat's panel ("As the owner" / "As the Auntie"), or nothing if it has no visible rows. */
function NotifHatSection({
  title,
  subtitle,
  matrix,
  prefs,
  stream,
  onChannelChange,
  onBulkChange,
}: NotifHatSectionProps) {
  const rows = adminVisibleNotifications(matrix, stream);
  if (rows.length === 0) return null;
  return (
    <DenPanel title={title} subtitle={subtitle}>
      <div className="mynotif__sections">
        {sectionedNotifications(rows, stream).map(([section, entries]) => (
          <section key={section.title} className="mynotif__section">
            <div className="mynotif__section-head">
              <h3 className="mynotif__section-heading">{section.title.toUpperCase()}</h3>
              <div
                className="mynotif__section-actions"
                role="group"
                aria-label={`Set every editable channel in ${section.title}`}
              >
                <GhostButton label="All on" onClick={() => onBulkChange(entries, stream, true)} />
                <GhostButton label="All off" onClick={() => onBulkChange(entries, stream, false)} />
              </div>
            </div>
            <div className="mynotif__rows">
              {entries.map((entry) => (
                <NotifBlock
                  key={entry.key}
                  matrix={matrix}
                  prefs={prefs}
                  entry={entry}
                  stream={stream}
                  onChannelChange={onChannelChange}
                />
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
  onChannelChange: (key: string, channel: NotificationChannel, next: boolean) => void;
}

/**
 * One notification: its title, then one row per gate-enabled channel. A
 * forced row (catalog-required or business-locked, for this stream) stays
 * `disabled` and pinned on, exactly like the read screen. Everything else is
 * a live `Toggle` writing straight into the draft via `onChannelChange`.
 */
function NotifBlock({ matrix, prefs, entry, stream, onChannelChange }: NotifBlockProps) {
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
                  onChange={(next) => onChannelChange(entry.key, channel, next)}
                  disabled={forced}
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
